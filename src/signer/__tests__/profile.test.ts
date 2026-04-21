import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db.js';
import { getProfile, upsertProfile, matchProfileFieldByLabel } from '../profile.js';

describe('signer profile', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  it('returns null when no profile exists', () => {
    expect(getProfile(db)).toBeNull();
  });

  it('upsert creates profile on first call', () => {
    upsertProfile(db, {
      fullName: 'Alice Example',
      initials: 'AE',
      title: 'CEO',
      address: '1 Market St',
      phone: '+1-555-0100',
    });
    const p = getProfile(db);
    expect(p).not.toBeNull();
    expect(p!.fullName).toBe('Alice Example');
    expect(p!.initials).toBe('AE');
    expect(p!.title).toBe('CEO');
    expect(p!.defaultDateFormat).toBe('MM/DD/YYYY');
    expect(p!.createdAt).toBeGreaterThan(0);
    expect(p!.updatedAt).toBe(p!.createdAt);
  });

  it('upsert updates existing profile and bumps updated_at', async () => {
    upsertProfile(db, { fullName: 'Alice', initials: 'A' });
    const p1 = getProfile(db)!;
    await new Promise((r) => setTimeout(r, 5));
    upsertProfile(db, { fullName: 'Alice Example', initials: 'AE' });
    const p2 = getProfile(db)!;
    expect(p2.fullName).toBe('Alice Example');
    expect(p2.createdAt).toBe(p1.createdAt);
    expect(p2.updatedAt).toBeGreaterThan(p1.updatedAt);
  });

  it('upsert preserves unset fields as null', () => {
    upsertProfile(db, { fullName: 'Alice', initials: 'A' });
    const p = getProfile(db)!;
    expect(p.title).toBeNull();
    expect(p.address).toBeNull();
    expect(p.phone).toBeNull();
  });

  it('matchProfileFieldByLabel finds profile field from label keyword', () => {
    upsertProfile(db, {
      fullName: 'Alice',
      initials: 'A',
      title: 'CEO',
      address: '1 Market St',
      phone: '555-0100',
    });
    const p = getProfile(db)!;
    expect(matchProfileFieldByLabel(p, 'Job title')).toEqual({ profileKey: 'title', value: 'CEO' });
    expect(matchProfileFieldByLabel(p, 'Your address')).toEqual({ profileKey: 'address', value: '1 Market St' });
    expect(matchProfileFieldByLabel(p, 'Phone number')).toEqual({ profileKey: 'phone', value: '555-0100' });
    expect(matchProfileFieldByLabel(p, 'Favorite color')).toBeNull();
  });

  it('matchProfileFieldByLabel returns null when profile field is null even if label matches', () => {
    upsertProfile(db, { fullName: 'Alice', initials: 'A' });
    const p = getProfile(db)!;
    expect(matchProfileFieldByLabel(p, 'Job title')).toBeNull();
  });
});
