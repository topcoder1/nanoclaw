import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockFindProcedure = vi.fn();
const mockListProcedures = vi.fn();
const mockSaveProcedure = vi.fn();
const mockUpdateProcedureStats = vi.fn();

vi.mock('../memory/procedure-store.js', () => ({
  findProcedure: (...args: unknown[]) => mockFindProcedure(...args),
  listProcedures: (...args: unknown[]) => mockListProcedures(...args),
  saveProcedure: (...args: unknown[]) => mockSaveProcedure(...args),
  updateProcedureStats: (...args: unknown[]) =>
    mockUpdateProcedureStats(...args),
}));

import {
  checkProcedureMatch,
  formatProcedureOffer,
  promoteProcedure,
} from './procedure-matcher.js';

describe('checkProcedureMatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no procedure matches', () => {
    mockFindProcedure.mockReturnValue(null);
    const result = checkProcedureMatch('hello world', 'g1');
    expect(result).toBeNull();
  });

  it('returns procedure when trigger matches', () => {
    const proc = {
      name: 'check-pr-status',
      trigger: 'check PR status',
      description: 'Check GitHub PR status',
      steps: [{ action: 'github_api' }],
      success_count: 5,
      failure_count: 1,
      auto_execute: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      groupId: 'g1',
    };
    mockFindProcedure.mockReturnValue(proc);
    const result = checkProcedureMatch('check PR status for nanoclaw', 'g1');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('check-pr-status');
  });
});

describe('formatProcedureOffer', () => {
  it('formats an offer message with success rate', () => {
    const proc = {
      name: 'check-pr-status',
      trigger: 'check PR status',
      description: 'Check GitHub PR status and summarize',
      steps: [{ action: 'github_api' }, { action: 'send_message' }],
      success_count: 7,
      failure_count: 1,
      auto_execute: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      groupId: 'g1',
    };
    const offer = formatProcedureOffer(proc);
    expect(offer).toContain('learned procedure');
    expect(offer).toContain('87%');
    expect(offer).toContain('8 times');
    expect(offer).toContain('Yes');
    expect(offer).toContain('Yes, always');
    expect(offer).toContain('No');
  });
});

describe('promoteProcedure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('copies procedure to global scope when found in 2+ groups', () => {
    const baseProc = {
      name: 'check-pr',
      trigger: 'check PR status',
      description: 'Check PR status',
      steps: [{ action: 'github_api' }],
      success_count: 3,
      failure_count: 0,
      auto_execute: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mockListProcedures
      .mockReturnValueOnce([{ ...baseProc, groupId: 'g1' }])
      .mockReturnValueOnce([{ ...baseProc, groupId: 'g2' }]);
    mockFindProcedure.mockReturnValue(null);

    promoteProcedure('check-pr', 'check PR status', ['g1', 'g2']);
    expect(mockSaveProcedure).toHaveBeenCalledOnce();
    const saved = mockSaveProcedure.mock.calls[0][0];
    expect(saved.groupId).toBeUndefined();
  });

  it('does not promote when found in only 1 group', () => {
    mockListProcedures
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ name: 'check-pr', groupId: 'g2' }]);
    promoteProcedure('check-pr', 'check PR status', ['g1', 'g2']);
    expect(mockSaveProcedure).not.toHaveBeenCalled();
  });
});
