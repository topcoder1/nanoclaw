import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, upsertTrustLevel } from '../db.js';
import { parseTrustCommand, executeTrustCommand } from '../trust-commands.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('parseTrustCommand', () => {
  it('parses "trust status"', () => {
    expect(parseTrustCommand('trust status')).toEqual({ type: 'status' });
  });

  it('parses "never auto-execute health.write"', () => {
    expect(parseTrustCommand('never auto-execute health.write')).toEqual({
      type: 'never_auto',
      actionClass: 'health.write',
    });
  });

  it('parses "never autoexecute code.transact"', () => {
    expect(parseTrustCommand('never autoexecute code.transact')).toEqual({
      type: 'never_auto',
      actionClass: 'code.transact',
    });
  });

  it('parses "reset trust"', () => {
    expect(parseTrustCommand('reset trust')).toEqual({ type: 'reset' });
  });

  it('returns null for unrecognized commands', () => {
    expect(parseTrustCommand('hello')).toBeNull();
    expect(parseTrustCommand('what is trust')).toBeNull();
  });
});

describe('executeTrustCommand', () => {
  it('status with no data returns cold start message', () => {
    const result = executeTrustCommand({ type: 'status' }, 'group1');
    expect(result).toContain('cold start');
  });

  it('status shows level data', () => {
    upsertTrustLevel({
      action_class: 'comms.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.833,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    const result = executeTrustCommand({ type: 'status' }, 'group1');
    expect(result).toContain('comms.write');
    expect(result).toContain('5');
  });

  it('never_auto sets manual gate', () => {
    const result = executeTrustCommand(
      { type: 'never_auto', actionClass: 'health.transact' },
      'group1',
    );
    expect(result).toContain('permanently gated');
  });

  it('reset clears all data', () => {
    upsertTrustLevel({
      action_class: 'comms.write',
      group_id: 'group1',
      approvals: 5,
      denials: 0,
      confidence: 0.833,
      threshold: 0.8,
      auto_execute: true,
      last_updated: new Date().toISOString(),
    });
    executeTrustCommand({ type: 'reset' }, 'group1');
    const statusResult = executeTrustCommand({ type: 'status' }, 'group1');
    expect(statusResult).toContain('cold start');
  });
});
