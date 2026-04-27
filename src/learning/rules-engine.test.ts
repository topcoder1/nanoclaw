import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDb = {
  exec: vi.fn(),
  prepare: vi.fn(),
};

vi.mock('../db.js', () => ({ getDb: vi.fn(() => mockDb) }));

import {
  initRulesStore,
  addRule,
  queryRules,
  markMatched,
  pruneStaleRules,
  deleteRule,
  decayConfidence,
  listActiveRules,
  markSuperseded,
} from './rules-engine.js';

describe('initRulesStore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates learned_rules table and FTS index', () => {
    initRulesStore();
    // First exec: base schema (table + FTS + triggers).
    // Subsequent execs: idempotent ALTER TABLE migrations + active-rules
    // index. Assertion focuses on the schema content, not call count.
    expect(mockDb.exec).toHaveBeenCalled();
    const baseSql = mockDb.exec.mock.calls[0][0] as string;
    expect(baseSql).toContain('CREATE TABLE IF NOT EXISTS learned_rules');
    expect(baseSql).toContain('fts5');
  });

  it('applies idempotent column migrations for supersession + subsource', () => {
    initRulesStore();
    const allSql = mockDb.exec.mock.calls
      .map((c) => c[0] as string)
      .join('\n');
    expect(allSql).toContain('ADD COLUMN subsource');
    expect(allSql).toContain('ADD COLUMN supersedes_id');
    expect(allSql).toContain('ADD COLUMN superseded_at');
    expect(allSql).toContain('idx_learned_rules_active');
  });

  it('swallows duplicate-column errors so re-init is a no-op', () => {
    mockDb.exec
      .mockImplementationOnce(() => undefined) // base schema OK
      .mockImplementationOnce(() => {
        throw new Error('duplicate column name: subsource');
      })
      .mockImplementationOnce(() => {
        throw new Error('duplicate column name: supersedes_id');
      })
      .mockImplementationOnce(() => {
        throw new Error('duplicate column name: superseded_at');
      })
      .mockImplementationOnce(() => undefined); // index OK
    expect(() => initRulesStore()).not.toThrow();
  });
});

describe('addRule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts rule and returns generated id', () => {
    const mockRun = vi.fn().mockReturnValue({ lastInsertRowid: 1 });
    const mockInsertStmt = { run: mockRun };
    const mockFtsStmt = { run: vi.fn() };
    let callCount = 0;
    mockDb.prepare.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? mockInsertStmt : mockFtsStmt;
    });

    const id = addRule({
      rule: 'Refresh OAuth before email ops',
      source: 'outcome_pattern',
      actionClasses: ['email.read'],
      groupId: 'g1',
      confidence: 0.5,
      evidenceCount: 2,
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(mockRun).toHaveBeenCalledOnce();
  });
});

describe('queryRules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns rules matching action classes and group', () => {
    const rows = [
      {
        id: 'abc',
        rule: 'Use API not browser',
        source: 'outcome_pattern',
        action_classes: '["github.read"]',
        group_id: 'g1',
        confidence: 0.7,
        evidence_count: 3,
        created_at: new Date().toISOString(),
        last_matched_at: new Date().toISOString(),
      },
    ];
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(rows) });

    const results = queryRules(['github.read'], 'g1');
    expect(results).toHaveLength(1);
    expect(results[0].actionClasses).toEqual(['github.read']);
  });

  it('returns empty array when no rules found', () => {
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });
    const results = queryRules(['email.send'], 'g1');
    expect(results).toEqual([]);
  });
});

describe('markMatched', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates last_matched_at for the rule', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    markMatched('rule-id-1');
    expect(mockRun).toHaveBeenCalledWith(expect.any(String), 'rule-id-1');
  });
});

describe('pruneStaleRules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes rules with confidence below 0.1 and returns count', () => {
    const mockRun = vi.fn().mockReturnValue({ changes: 3 });
    mockDb.prepare.mockReturnValue({ run: mockRun });
    const count = pruneStaleRules();
    expect(count).toBe(3);
  });
});

describe('deleteRule', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes rule by id (trigger handles FTS cleanup)', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    deleteRule('rule-id-1');
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});

describe('decayConfidence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reduces confidence for rules not matched in 30 days', () => {
    const mockRun = vi.fn().mockReturnValue({ changes: 2 });
    mockDb.prepare.mockReturnValue({ run: mockRun });
    const count = decayConfidence();
    expect(count).toBe(2);
  });
});

describe('addRule with subsource + supersedesId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists subsource and supersedesId when supplied', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    addRule({
      rule: 'When user asks about pricing, default to per-domain rate',
      source: 'agent_reported',
      subsource: 'brain_reflection',
      actionClasses: ['email.draft'],
      groupId: null,
      confidence: 0.7,
      evidenceCount: 3,
      supersedesId: 'old-rule-1',
    });
    expect(mockRun).toHaveBeenCalledOnce();
    const args = mockRun.mock.calls[0];
    // Order: id, rule, source, subsource, action_classes, group_id,
    //        confidence, evidence_count, created_at, last_matched_at,
    //        supersedes_id
    expect(args[3]).toBe('brain_reflection');
    expect(args[10]).toBe('old-rule-1');
  });

  it('defaults subsource and supersedesId to NULL when omitted', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    addRule({
      rule: 'Stay polite',
      source: 'user_feedback',
      actionClasses: ['general'],
      groupId: 'g1',
      confidence: 0.5,
      evidenceCount: 1,
    });
    const args = mockRun.mock.calls[0];
    expect(args[3]).toBeNull();
    expect(args[10]).toBeNull();
  });
});

describe('listActiveRules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('filters by subsource and since when supplied', () => {
    const mockAll = vi.fn().mockReturnValue([]);
    mockDb.prepare.mockReturnValue({ all: mockAll });
    listActiveRules({
      subsource: 'brain_reflection',
      since: '2026-04-20T00:00:00Z',
      limit: 10,
    });
    const sql = (mockDb.prepare.mock.calls[0][0] as string).toLowerCase();
    expect(sql).toContain('superseded_at is null');
    expect(sql).toContain('subsource = ?');
    expect(sql).toContain('created_at >= ?');
    expect(mockAll).toHaveBeenCalledWith(
      'brain_reflection',
      '2026-04-20T00:00:00Z',
      10,
    );
  });

  it('returns rules with the supersession fields populated', () => {
    const rows = [
      {
        id: 'r1',
        rule: 'New rule',
        source: 'agent_reported',
        subsource: 'brain_reflection',
        action_classes: '["email.draft"]',
        group_id: null,
        confidence: 0.8,
        evidence_count: 3,
        created_at: '2026-04-22T00:00:00Z',
        last_matched_at: '2026-04-22T00:00:00Z',
        supersedes_id: 'r0',
        superseded_at: null,
      },
    ];
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue(rows) });
    const results = listActiveRules({ subsource: 'brain_reflection' });
    expect(results).toHaveLength(1);
    expect(results[0].subsource).toBe('brain_reflection');
    expect(results[0].supersedesId).toBe('r0');
    expect(results[0].supersededAt).toBeNull();
  });
});

describe('markSuperseded', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps superseded_at on the matching rule', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    markSuperseded('old-rule-1', '2026-04-23T09:00:00Z');
    expect(mockRun).toHaveBeenCalledWith('2026-04-23T09:00:00Z', 'old-rule-1');
  });

  it('only updates rows where superseded_at IS NULL (idempotent)', () => {
    const mockRun = vi.fn();
    mockDb.prepare.mockReturnValue({ run: mockRun });
    markSuperseded('old-rule-1');
    const sql = (mockDb.prepare.mock.calls[0][0] as string).toLowerCase();
    expect(sql).toContain('superseded_at is null');
  });
});
