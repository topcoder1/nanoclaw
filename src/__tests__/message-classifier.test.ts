import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../message-classifier.js';

describe('classifyMessage', () => {
  it('classifies Chase wire notification as financial + action-required', () => {
    const meta = classifyMessage(
      'Chase — 2 incoming wires to account ····7958. Total: $54,900. Were both expected?',
    );
    expect(meta.category).toBe('financial');
    expect(meta.urgency).toBe('action-required');
    expect(meta.batchable).toBe(false);
  });

  it('classifies Spamhaus alert as security + urgent', () => {
    const meta = classifyMessage(
      'Hetzner IP Spamhaus listed — 178.104.205.217 has been listed by Spamhaus for abuse',
    );
    expect(meta.category).toBe('security');
    expect(meta.urgency).toBe('urgent');
    expect(meta.batchable).toBe(false);
  });

  it('classifies marketing email as auto-handled + info', () => {
    const meta = classifyMessage(
      'Asoview birthday promo (Japanese marketing email) — AUTO, no action needed.',
    );
    expect(meta.category).toBe('auto-handled');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(true);
  });

  it('classifies receipt as auto-handled + info', () => {
    const meta = classifyMessage(
      'Clerk.com receipt — $25.00 Pro Plan, Apr 15. AUTO, no action.',
    );
    expect(meta.category).toBe('auto-handled');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(true);
  });

  it('classifies team update as team + info', () => {
    const meta = classifyMessage(
      'Dmitrii (Attaxion/WhoisXML) — acknowledged staging request with ticket #WANF-864. No action needed.',
    );
    expect(meta.category).toBe('team');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(true);
  });

  it('classifies Nstproxy verification as account + info', () => {
    const meta = classifyMessage(
      'Nstproxy (proxy signup #12 for Philip Ye) — account activation email received.',
    );
    expect(meta.category).toBe('account');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(false);
  });

  it('classifies draft enrichment notification as email + attention', () => {
    const meta = classifyMessage(
      'Enriched SuperPilot draft → David Hagberg — added invoice ref #INV-031',
    );
    expect(meta.category).toBe('email');
    expect(meta.urgency).toBe('attention');
    expect(meta.batchable).toBe(false);
  });

  it('defaults unrecognized messages to email + info', () => {
    const meta = classifyMessage('Something completely new and unknown');
    expect(meta.category).toBe('email');
    expect(meta.urgency).toBe('info');
    expect(meta.batchable).toBe(false);
  });
});
