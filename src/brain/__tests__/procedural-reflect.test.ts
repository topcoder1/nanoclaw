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
    'recall-command',
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
      expect(s.recurringRetrievals.find((r) => r.kuId === coldKu)).toBeUndefined();
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
      expect(s.recentCorrections[0].text).toContain("Best,");
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
