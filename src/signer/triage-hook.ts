import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus.js';
import type { SignVendor } from './types.js';
import { createCeremony, listByEmail } from './ceremony-repo.js';

export interface TriageHookInput {
  db: Database.Database;
  bus: EventBus;
  emailId: string;
  vendor: SignVendor;
  signUrl: string;
  docTitle: string | null;
  groupId: string;
  flagEnabled: boolean;
}

export async function onSignInviteDetected(input: TriageHookInput): Promise<string | null> {
  if (!input.flagEnabled) return null;

  // Idempotency: if there's an active ceremony for this email, reuse it.
  const existing = listByEmail(input.db, input.emailId).find(
    (c) => !['failed', 'cancelled'].includes(c.state),
  );
  if (existing) return existing.id;

  const id = randomUUID();
  createCeremony(input.db, {
    id,
    emailId: input.emailId,
    vendor: input.vendor,
    signUrl: input.signUrl,
    docTitle: input.docTitle,
  });

  input.bus.emit('sign.invite.detected', {
    type: 'sign.invite.detected',
    source: 'triage',
    timestamp: Date.now(),
    payload: {
      ceremonyId: id,
      emailId: input.emailId,
      vendor: input.vendor,
      signUrl: input.signUrl,
      groupId: input.groupId,
    },
  });

  return id;
}
