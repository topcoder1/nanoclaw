import type Database from 'better-sqlite3';
import type { SignerProfile, ProfileFieldMatch } from './types.js';

export interface UpsertProfileInput {
  fullName: string;
  initials: string;
  title?: string | null;
  address?: string | null;
  phone?: string | null;
  defaultDateFormat?: string;
}

interface Row {
  id: number;
  full_name: string;
  initials: string;
  title: string | null;
  address: string | null;
  phone: string | null;
  default_date_format: string;
  created_at: number;
  updated_at: number;
}

function rowToProfile(r: Row): SignerProfile {
  return {
    fullName: r.full_name,
    initials: r.initials,
    title: r.title,
    address: r.address,
    phone: r.phone,
    defaultDateFormat: r.default_date_format,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getProfile(db: Database.Database): SignerProfile | null {
  const row = db.prepare('SELECT * FROM signer_profile WHERE id = 1').get() as
    | Row
    | undefined;
  return row ? rowToProfile(row) : null;
}

export function upsertProfile(
  db: Database.Database,
  input: UpsertProfileInput,
): void {
  const now = Date.now();
  const existing = db
    .prepare('SELECT id, created_at FROM signer_profile WHERE id = 1')
    .get() as { id: number; created_at: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE signer_profile SET
        full_name = ?, initials = ?, title = ?, address = ?, phone = ?,
        default_date_format = COALESCE(?, default_date_format),
        updated_at = ?
       WHERE id = 1`,
    ).run(
      input.fullName,
      input.initials,
      input.title ?? null,
      input.address ?? null,
      input.phone ?? null,
      input.defaultDateFormat ?? null,
      now,
    );
  } else {
    db.prepare(
      `INSERT INTO signer_profile (id, full_name, initials, title, address, phone, default_date_format, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, COALESCE(?, 'MM/DD/YYYY'), ?, ?)`,
    ).run(
      input.fullName,
      input.initials,
      input.title ?? null,
      input.address ?? null,
      input.phone ?? null,
      input.defaultDateFormat ?? null,
      now,
      now,
    );
  }
}

const LABEL_KEYWORDS: Array<{
  re: RegExp;
  key: ProfileFieldMatch['profileKey'];
}> = [
  { re: /\b(title|role|position|job)\b/i, key: 'title' },
  { re: /\b(address|street|city|zip|postal)\b/i, key: 'address' },
  { re: /\b(phone|mobile|tel|cell)\b/i, key: 'phone' },
];

export function matchProfileFieldByLabel(
  profile: SignerProfile,
  label: string,
): ProfileFieldMatch | null {
  for (const { re, key } of LABEL_KEYWORDS) {
    if (re.test(label)) {
      const value = profile[key];
      if (value) return { profileKey: key, value };
    }
  }
  return null;
}
