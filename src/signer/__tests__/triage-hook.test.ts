import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db.js';
import { EventBus } from '../../event-bus.js';
import { onSignInviteDetected } from '../triage-hook.js';
import { listByEmail } from '../ceremony-repo.js';

describe('triage-hook', () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    bus = new EventBus();
  });

  it('creates a ceremony and emits sign.invite.detected when flag enabled', async () => {
    const emitted = vi.fn();
    bus.on('sign.invite.detected', emitted);

    const id = await onSignInviteDetected({
      db,
      bus,
      emailId: 'email-1',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/Signing/abc',
      docTitle: 'NDA',
      groupId: 'main',
      flagEnabled: true,
    });

    expect(id).toBeTruthy();
    const rows = listByEmail(db, 'email-1');
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('detected');
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sign.invite.detected',
        payload: expect.objectContaining({
          ceremonyId: id,
          vendor: 'docusign',
        }),
      }),
    );
  });

  it('returns null and does nothing when flag disabled', async () => {
    const id = await onSignInviteDetected({
      db,
      bus,
      emailId: 'email-2',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/Signing/abc',
      docTitle: 'NDA',
      groupId: 'main',
      flagEnabled: false,
    });
    expect(id).toBeNull();
    expect(listByEmail(db, 'email-2')).toEqual([]);
  });

  it('returns existing ceremony id if one is already active (idempotent)', async () => {
    const id1 = await onSignInviteDetected({
      db,
      bus,
      emailId: 'email-3',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/Signing/abc',
      docTitle: 'NDA',
      groupId: 'main',
      flagEnabled: true,
    });
    const id2 = await onSignInviteDetected({
      db,
      bus,
      emailId: 'email-3',
      vendor: 'docusign',
      signUrl: 'https://na3.docusign.net/Signing/abc',
      docTitle: 'NDA',
      groupId: 'main',
      flagEnabled: true,
    });
    expect(id2).toBe(id1);
    expect(listByEmail(db, 'email-3').length).toBe(1);
  });
});
