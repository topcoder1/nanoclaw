import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db.js';
import {
  createCeremony,
  getCeremony,
  transitionState,
  updateSummary,
  updateFailure,
  updateSignedPdf,
  listByEmail,
} from '../ceremony-repo.js';

describe('ceremony-repo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('createCeremony inserts a row in detected state', () => {
    const c = createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://docusign.net/x',
      docTitle: 'NDA.pdf',
    });
    expect(c.state).toBe('detected');
    expect(c.completedAt).toBeNull();
    expect(c.createdAt).toBeGreaterThan(0);
  });

  it('getCeremony returns null for missing id', () => {
    expect(getCeremony(db, 'nope')).toBeNull();
  });

  it('transitionState succeeds when current state matches', () => {
    createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://docusign.net/x',
    });
    const ok = transitionState(db, 'c1', 'detected', 'summarized');
    expect(ok).toBe(true);
    expect(getCeremony(db, 'c1')!.state).toBe('summarized');
  });

  it('transitionState fails silently (returns false) when state does not match', () => {
    createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://docusign.net/x',
    });
    const ok = transitionState(db, 'c1', 'approved', 'signing');
    expect(ok).toBe(false);
    expect(getCeremony(db, 'c1')!.state).toBe('detected');
  });

  it('transitionState to signed requires updateSignedPdf first', () => {
    createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://docusign.net/x',
    });
    transitionState(db, 'c1', 'detected', 'summarized');
    transitionState(db, 'c1', 'summarized', 'approved');
    transitionState(db, 'c1', 'approved', 'signing');
    expect(() => transitionState(db, 'c1', 'signing', 'signed')).toThrow(
      /CHECK constraint failed/,
    );
    updateSignedPdf(db, 'c1', '/tmp/signed.pdf');
    const ok = transitionState(db, 'c1', 'signing', 'signed');
    expect(ok).toBe(true);
    const c = getCeremony(db, 'c1')!;
    expect(c.state).toBe('signed');
    expect(c.signedPdfPath).toBe('/tmp/signed.pdf');
    expect(c.completedAt).not.toBeNull();
  });

  it('updateFailure sets reason + screenshot + transitions to failed', () => {
    createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://docusign.net/x',
    });
    transitionState(db, 'c1', 'detected', 'summarized');
    transitionState(db, 'c1', 'summarized', 'approved');
    transitionState(db, 'c1', 'approved', 'signing');
    updateFailure(db, 'c1', 'layout_changed', '/tmp/fail.png');
    const c = getCeremony(db, 'c1')!;
    expect(c.state).toBe('failed');
    expect(c.failureReason).toBe('layout_changed');
    expect(c.failureScreenshotPath).toBe('/tmp/fail.png');
    expect(c.completedAt).not.toBeNull();
  });

  it('updateSummary stores summary + flags as JSON', () => {
    createCeremony(db, {
      id: 'c1',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'https://docusign.net/x',
    });
    updateSummary(
      db,
      'c1',
      ['line 1', 'line 2'],
      [
        {
          category: 'auto_renewal',
          severity: 'high',
          evidence: 'Auto-renews yearly',
        },
      ],
    );
    const c = getCeremony(db, 'c1')!;
    expect(c.summaryText).toBe('line 1\nline 2');
    expect(c.riskFlags).toEqual([
      {
        category: 'auto_renewal',
        severity: 'high',
        evidence: 'Auto-renews yearly',
      },
    ]);
  });

  it('listByEmail returns all ceremonies ordered by created_at desc', () => {
    createCeremony(db, {
      id: 'a',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'x',
    });
    transitionState(db, 'a', 'detected', 'summarized');
    transitionState(db, 'a', 'summarized', 'cancelled');
    createCeremony(db, {
      id: 'b',
      emailId: 'e1',
      vendor: 'docusign',
      signUrl: 'x',
    });
    const list = listByEmail(db, 'e1');
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
  });
});
