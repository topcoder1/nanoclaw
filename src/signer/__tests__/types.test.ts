import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  SignerProfile,
  SignCeremony,
  SignCeremonyState,
  FieldTag,
  ProfileFieldMatch,
} from '../types.js';

describe('signer types', () => {
  it('SignerProfile has required string fields', () => {
    expectTypeOf<SignerProfile>().toMatchTypeOf<{
      fullName: string;
      initials: string;
      title: string | null;
      address: string | null;
      phone: string | null;
      defaultDateFormat: string;
    }>();
  });

  it('SignCeremonyState is a finite union of 8 states', () => {
    const all: SignCeremonyState[] = [
      'detected',
      'summarized',
      'approval_requested',
      'approved',
      'signing',
      'signed',
      'failed',
      'cancelled',
    ];
    expect(all.length).toBe(8);
  });

  it('FieldTag includes the 5 known tags', () => {
    const tags: FieldTag[] = [
      'signature',
      'initial',
      'date_signed',
      'text',
      'check',
    ];
    expect(tags.length).toBe(5);
  });

  it('ProfileFieldMatch has profileKey and value', () => {
    const m: ProfileFieldMatch = { profileKey: 'title', value: 'CEO' };
    expect(m.profileKey).toBe('title');
  });
});
