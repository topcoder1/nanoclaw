import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let tmpDir: string;
vi.mock('../../config.js', () => ({
  get STORE_DIR() {
    return tmpDir;
  },
}));

// Stub the rules-engine — the reflection module must not transitively
// pull in messages.db. Tests that exercise the listActive/addRule path
// inject a fake via the public API or assert against these spies.
const addRuleSpy = vi.fn(() => 'new-rule-id');
const listActiveRulesSpy = vi.fn(() => []);
const markSupersededSpy = vi.fn();
vi.mock('../../learning/rules-engine.js', () => ({
  addRule: (...args: unknown[]) => addRuleSpy(...args),
  listActiveRules: (...args: unknown[]) => listActiveRulesSpy(...args),
  markSuperseded: (...args: unknown[]) => markSupersededSpy(...args),
}));

import { _closeBrainDb, getBrainDb } from '../db.js';
import {
  buildReflectionPrompt,
  collectSignals,
  estimateHaikuCostUsd,
  findSupersedeCandidates,
  hasUsableSignals,
  reflectAndEmit,
  type EmittedRule,
  type ReflectionLlmCaller,
} from '../procedural-reflect.js';
import { newId } from '../ulid.js';

const NOW = '2026-04-27T12:00:00Z';
const WINDOW_START = '2026-04-20T12:00:00Z';

function seedQuery(
  db: ReturnType<typeof getBrainDb>,
  opts: {
    text: string;
    resultCount: number;
    recordedAt: string;
    queryId?: string;
    retrievedKuIds?: string[];
    caller?: string;
  },
): string {
  const queryId = opts.queryId ?? newId();
  db.prepare(
    `INSERT INTO ku_queries
       (id, query_text, caller, account, scope, result_count, duration_ms, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    queryId,
    opts.text,
    opts.caller ?? 'recall-command',
    'work',
    null,
    opts.resultCount,
    50,
    opts.recordedAt,
  );
  if (opts.retrievedKuIds) {
    for (let i = 0; i < opts.retrievedKuIds.length; i++) {
      db.prepare(
        `INSERT INTO ku_retrievals
           (query_id, ku_id, rank, final_score, rank_score, recency_score, access_score, important_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(queryId, opts.retrievedKuIds[i], i, 0.5 - i * 0.1, 0.5, 0.5, 0, 0);
    }
  }
  return queryId;
}

describe('brain/procedural-reflect', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-reflect-'));
    addRuleSpy.mockClear();
    listActiveRulesSpy.mockClear();
    markSupersededSpy.mockClear();
    listActiveRulesSpy.mockReturnValue([]);
  });

  afterEach(() => {
    _closeBrainDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('collectSignals', () => {
    it('returns zero-result queries inside the window', () => {
      const db = getBrainDb();
      seedQuery(db, {
        text: 'pricing for stellar cyber',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      seedQuery(db, {
        text: 'old query outside window',
        resultCount: 0,
        recordedAt: '2026-04-15T10:00:00Z',
      });
      seedQuery(db, {
        text: 'this query had results',
        resultCount: 3,
        recordedAt: '2026-04-23T10:00:00Z',
      });
      const s = collectSignals(db, WINDOW_START, NOW);
      expect(s.zeroResultQueries).toHaveLength(1);
      expect(s.zeroResultQueries[0].text).toContain('stellar cyber');
    });

    it('flags KUs retrieved by ≥3 distinct queries as recurring concerns', () => {
      const db = getBrainDb();
      const hotKu = 'KU-hot';
      const coldKu = 'KU-cold';
      for (let i = 0; i < 4; i++) {
        seedQuery(db, {
          text: `hot query ${i}`,
          resultCount: 2,
          recordedAt: `2026-04-${22 + (i % 3)}T0${i}:00:00Z`,
          retrievedKuIds: [hotKu],
        });
      }
      seedQuery(db, {
        text: 'cold query',
        resultCount: 1,
        recordedAt: '2026-04-23T08:00:00Z',
        retrievedKuIds: [coldKu],
      });
      const s = collectSignals(db, WINDOW_START, NOW);
      const hot = s.recurringRetrievals.find((r) => r.kuId === hotKu);
      expect(hot).toBeDefined();
      expect(hot!.queryCount).toBeGreaterThanOrEqual(3);
      expect(
        s.recurringRetrievals.find((r) => r.kuId === coldKu),
      ).toBeUndefined();
    });

    it('truncates long query text to keep the prompt bounded', () => {
      const db = getBrainDb();
      const long = 'x'.repeat(500);
      seedQuery(db, {
        text: long,
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      const s = collectSignals(db, WINDOW_START, NOW);
      expect(s.zeroResultQueries[0].text.length).toBeLessThanOrEqual(120);
    });

    it('excludes agent-auto callers from zero-result queries', () => {
      // Auto-recall fires on every incoming chat message — its query_text
      // is the chat envelope, not a user-typed question. Surfacing those
      // through the prompt taught Haiku to emit "rules" that just echo KU
      // IDs back. Filter at the SQL layer so the prompt only sees real
      // user-initiated queries.
      const db = getBrainDb();
      seedQuery(db, {
        text: 'real user query — deserves a rule',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
        caller: 'recall-command',
      });
      seedQuery(db, {
        text: '<context timezone="America/Cancun" />\n<messages>...',
        resultCount: 0,
        recordedAt: '2026-04-22T11:00:00Z',
        caller: 'agent-auto',
      });
      const s = collectSignals(db, WINDOW_START, NOW);
      expect(s.zeroResultQueries).toHaveLength(1);
      expect(s.zeroResultQueries[0].text).toContain('real user query');
    });

    it('excludes agent-auto callers from recurring-retrieval signal', () => {
      const db = getBrainDb();
      const ku = 'KU-noisy';
      // Three agent-auto queries hitting the same KU — pre-fix this would
      // have surfaced as "recurring concern", but it's just chat noise.
      for (let i = 0; i < 3; i++) {
        seedQuery(db, {
          text: '<message>chat ' + i + '</message>',
          resultCount: 1,
          recordedAt: `2026-04-22T0${i}:00:00Z`,
          retrievedKuIds: [ku],
          caller: 'agent-auto',
        });
      }
      const s = collectSignals(db, WINDOW_START, NOW);
      expect(s.recurringRetrievals).toEqual([]);
    });

    it('strips chat-window XML envelope from surfaced query_text', () => {
      // Some non-auto-recall callers (cli-claw-know wrapping context, future
      // wrappers) may still send XML-shaped query_text. Strip the envelope
      // so the surfaced text is the user's actual message.
      const db = getBrainDb();
      const wrapped =
        '<context timezone="America/Cancun" />\n' +
        '<messages>\n' +
        '<message sender="Jonathan" time="Apr 28, 2026, 10:08 AM">where is auth handled?</message>\n' +
        '</messages>';
      seedQuery(db, {
        text: wrapped,
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      const s = collectSignals(db, WINDOW_START, NOW);
      expect(s.zeroResultQueries).toHaveLength(1);
      expect(s.zeroResultQueries[0].text).toBe('where is auth handled?');
    });

    it('pulls recent user_feedback rules from the rules-engine', () => {
      const db = getBrainDb();
      seedQuery(db, {
        text: 'something',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      listActiveRulesSpy.mockReturnValue([
        {
          id: 'fb-1',
          rule: "Don't sign emails 'Best,'",
          source: 'user_feedback',
          subsource: null,
          actionClasses: ['email.draft'],
          groupId: 'g1',
          confidence: 0.9,
          evidenceCount: 1,
          createdAt: '2026-04-25T08:00:00Z',
          lastMatchedAt: '2026-04-25T08:00:00Z',
          supersedesId: null,
          supersededAt: null,
        },
      ]);
      const s = collectSignals(db, WINDOW_START, NOW);
      expect(s.recentCorrections).toHaveLength(1);
      expect(s.recentCorrections[0].text).toContain('Best,');
    });
  });

  describe('hasUsableSignals', () => {
    it('returns false when the bundle is empty', () => {
      expect(
        hasUsableSignals({
          zeroResultQueries: [],
          recurringRetrievals: [],
          recentCorrections: [],
        }),
      ).toBe(false);
    });
    it('returns true when any source has rows', () => {
      expect(
        hasUsableSignals({
          zeroResultQueries: [
            { id: 'q1', text: 'x', recordedAt: '2026-04-22T10:00:00Z' },
          ],
          recurringRetrievals: [],
          recentCorrections: [],
        }),
      ).toBe(true);
    });
  });

  describe('buildReflectionPrompt', () => {
    it('embeds all three signal categories with bracketed evidence ids', () => {
      const prompt = buildReflectionPrompt(
        {
          zeroResultQueries: [
            { id: 'q1', text: 'pricing for X', recordedAt: NOW },
          ],
          recurringRetrievals: [
            {
              kuId: 'KU-hot',
              queryCount: 4,
              sampleQueries: ['Q1', 'Q2'],
            },
          ],
          recentCorrections: [
            { id: 'fb-1', text: "Don't sign emails 'Best,'", createdAt: NOW },
          ],
        },
        5,
      );
      expect(prompt).toContain('[q1]');
      expect(prompt).toContain('[KU-hot]');
      expect(prompt).toContain('[fb-1]');
      expect(prompt).toMatch(/Cap at 5 rules/);
      expect(prompt).toMatch(/STRICT JSON/);
      expect(prompt).toMatch(/≥2 evidence ids/);
    });
  });

  describe('findSupersedeCandidates', () => {
    const newRule: EmittedRule = {
      rule: 'When user asks about pricing, default to per-domain rate',
      actionClasses: ['email.draft', 'pricing'],
      evidence: ['q1', 'q2'],
      confidence: 0.8,
    };

    function fakeRule(
      id: string,
      classes: string[],
      opts: { subsource?: string | null; supersededAt?: string | null } = {},
    ) {
      return {
        id,
        rule: `Rule ${id}`,
        source: 'agent_reported' as const,
        subsource: opts.subsource ?? 'brain_reflection',
        actionClasses: classes,
        groupId: null,
        confidence: 0.5,
        evidenceCount: 2,
        createdAt: NOW,
        lastMatchedAt: NOW,
        supersedesId: null,
        supersededAt: opts.supersededAt ?? null,
      };
    }

    it('matches active brain-reflection rules whose classes overlap', () => {
      const candidates = findSupersedeCandidates(newRule, [
        fakeRule('r1', ['email.draft']),
        fakeRule('r2', ['unrelated']),
      ]);
      expect(candidates.map((r) => r.id)).toEqual(['r1']);
    });

    it('skips rules from a different subsource', () => {
      const candidates = findSupersedeCandidates(newRule, [
        fakeRule('r1', ['email.draft'], { subsource: 'user_feedback' }),
      ]);
      expect(candidates).toEqual([]);
    });

    it('skips already-superseded rules', () => {
      const candidates = findSupersedeCandidates(newRule, [
        fakeRule('r1', ['email.draft'], { supersededAt: NOW }),
      ]);
      expect(candidates).toEqual([]);
    });
  });

  describe('estimateHaikuCostUsd', () => {
    // Pricing pinned to Haiku 4.5 ($1/M input, $5/M output as of 2026-Q1).
    // If pricing changes, both this test and the constants in
    // procedural-reflect.ts need updating in lockstep.
    it('charges $1 per million input tokens and $5 per million output', () => {
      expect(estimateHaikuCostUsd(1_000_000, 0)).toBeCloseTo(1.0, 6);
      expect(estimateHaikuCostUsd(0, 1_000_000)).toBeCloseTo(5.0, 6);
    });

    it('combines input + output proportionally', () => {
      // Realistic single-call: 2K input + 1K output = $0.002 + $0.005 = $0.007
      expect(estimateHaikuCostUsd(2_000, 1_000)).toBeCloseTo(0.007, 6);
    });

    it('returns 0 for zero tokens (LLM no-op)', () => {
      expect(estimateHaikuCostUsd(0, 0)).toBe(0);
    });
  });

  describe('reflectAndEmit', () => {
    it('skips when no signals exist', async () => {
      const result = await reflectAndEmit({
        nowIso: NOW,
        brainDb: getBrainDb(),
        llm: vi.fn() as unknown as ReflectionLlmCaller,
      });
      expect(result.skipReason).toBe('no signals in window');
      expect(result.emittedRuleIds).toEqual([]);
      expect(addRuleSpy).not.toHaveBeenCalled();
    });

    it('emits rules from the LLM and inserts via addRule', async () => {
      const db = getBrainDb();
      seedQuery(db, {
        text: 'pricing question',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      const llm: ReflectionLlmCaller = vi.fn(async () => ({
        rules: [
          {
            rule: 'When user asks about pricing, link the per-domain rate sheet',
            actionClasses: ['email.draft'],
            evidence: ['q1', 'q2'],
            confidence: 0.7,
          },
        ],
        inputTokens: 100,
        outputTokens: 50,
      }));
      const result = await reflectAndEmit({ nowIso: NOW, llm });
      expect(result.emittedRuleIds).toHaveLength(1);
      expect(addRuleSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'agent_reported',
          subsource: 'brain_reflection',
          groupId: null,
          confidence: 0.7,
          actionClasses: ['email.draft'],
        }),
      );
    });

    it('drops malformed rules (missing evidence or bad confidence)', async () => {
      const db = getBrainDb();
      seedQuery(db, {
        text: 'q',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      const llm: ReflectionLlmCaller = vi.fn(async () => ({
        rules: [
          {
            rule: 'Only one evidence — drop',
            actionClasses: ['x'],
            evidence: ['only-one'],
            confidence: 0.5,
          },
          {
            rule: 'Empty rule text — drop',
            actionClasses: ['x'],
            evidence: ['e1', 'e2'],
            confidence: 0.5,
          } as unknown as EmittedRule,
          {
            rule: 'Confidence out of range — drop',
            actionClasses: ['x'],
            evidence: ['e1', 'e2'],
            confidence: 1.5,
          },
          {
            rule: 'Valid rule — keep',
            actionClasses: ['x'],
            evidence: ['e1', 'e2'],
            confidence: 0.5,
          },
        ].map((r, i) => (i === 1 ? { ...r, rule: '' } : r)),
        inputTokens: 100,
        outputTokens: 50,
      }));
      const result = await reflectAndEmit({ nowIso: NOW, llm });
      expect(result.emittedRuleIds).toHaveLength(1);
      expect(addRuleSpy).toHaveBeenCalledTimes(1);
      expect(addRuleSpy.mock.calls[0][0]).toMatchObject({
        rule: 'Valid rule — keep',
      });
    });

    it('marks contradicting older brain-reflection rules as superseded', async () => {
      const db = getBrainDb();
      seedQuery(db, {
        text: 'q',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      listActiveRulesSpy.mockReturnValue([
        {
          id: 'old-1',
          rule: 'Old rule on email.draft',
          source: 'agent_reported',
          subsource: 'brain_reflection',
          actionClasses: ['email.draft'],
          groupId: null,
          confidence: 0.5,
          evidenceCount: 2,
          createdAt: '2026-04-15T00:00:00Z',
          lastMatchedAt: '2026-04-15T00:00:00Z',
          supersedesId: null,
          supersededAt: null,
        },
      ]);
      const llm: ReflectionLlmCaller = vi.fn(async () => ({
        rules: [
          {
            rule: 'New rule on same class',
            actionClasses: ['email.draft'],
            evidence: ['q1', 'q2'],
            confidence: 0.7,
          },
        ],
        inputTokens: 50,
        outputTokens: 50,
      }));
      const result = await reflectAndEmit({ nowIso: NOW, llm });
      expect(result.supersededRuleIds).toEqual(['old-1']);
      expect(markSupersededSpy).toHaveBeenCalledWith('old-1', NOW);
      // The new rule's supersedesId should reference the old one.
      expect(addRuleSpy.mock.calls[0][0]).toMatchObject({
        supersedesId: 'old-1',
      });
    });

    it('returns skipReason="llm_error" and emits nothing on LLM failure', async () => {
      const db = getBrainDb();
      seedQuery(db, {
        text: 'q',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      const llm: ReflectionLlmCaller = vi.fn(async () => {
        throw new Error('upstream timeout');
      });
      const result = await reflectAndEmit({ nowIso: NOW, llm });
      expect(result.skipReason).toBe('llm_error');
      expect(addRuleSpy).not.toHaveBeenCalled();
    });

    it('caps emissions at maxRules', async () => {
      const db = getBrainDb();
      seedQuery(db, {
        text: 'q',
        resultCount: 0,
        recordedAt: '2026-04-22T10:00:00Z',
      });
      const llm: ReflectionLlmCaller = vi.fn(async () => ({
        rules: Array.from({ length: 7 }, (_, i) => ({
          rule: `Rule ${i}`,
          actionClasses: ['x'],
          evidence: ['e1', 'e2'],
          confidence: 0.5,
        })),
        inputTokens: 50,
        outputTokens: 50,
      }));
      const result = await reflectAndEmit({ nowIso: NOW, llm, maxRules: 3 });
      expect(result.emittedRuleIds).toHaveLength(3);
    });
  });
});
