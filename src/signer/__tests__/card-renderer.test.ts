import { describe, it, expect } from 'vitest';
import { renderCeremonyCard, renderDoubleConfirmCard, renderReceipt } from '../card-renderer.js';
import type { SignCeremony, RiskFlag } from '../types.js';

function makeCeremony(overrides: Partial<SignCeremony> = {}): SignCeremony {
  return {
    id: 'cer-1',
    emailId: 'eml-1',
    vendor: 'docusign',
    signUrl: 'https://na3.docusign.net/Signing/abc',
    docTitle: 'NDA between Acme and Alice',
    state: 'summarized',
    summaryText: 'Doc type: NDA\nCounterparties: Acme / Alice\nTerm: 2 years',
    riskFlags: [],
    signedPdfPath: null,
    failureReason: null,
    failureScreenshotPath: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

describe('card-renderer', () => {
  it('renders a clean card with no risk flags', () => {
    const card = renderCeremonyCard(makeCeremony());
    expect(card.text).toContain('NDA between Acme and Alice');
    expect(card.text).toContain('Doc type: NDA');
    expect(card.text).not.toContain('risks flagged');
    expect(card.buttons).toEqual([
      [
        { text: '✅ Sign', callback_data: 'sign:approve:cer-1' },
        { text: '❌ Dismiss', callback_data: 'sign:cancel:cer-1' },
        { text: '📄 Full doc', url: 'https://na3.docusign.net/Signing/abc' },
      ],
    ]);
  });

  it('renders warning header when high-severity flags present', () => {
    const flags: RiskFlag[] = [
      { category: 'auto_renewal', severity: 'high', evidence: 'auto-renews yearly' },
      { category: 'non_compete', severity: 'high', evidence: '2 year non-compete' },
    ];
    const card = renderCeremonyCard(makeCeremony({ riskFlags: flags }));
    expect(card.text).toContain('⚠️ 2 risks flagged');
    expect(card.text).toContain('auto_renewal');
    expect(card.text).toContain('auto-renews yearly');
  });

  it('renders double-confirm card after first tap', () => {
    const card = renderDoubleConfirmCard(makeCeremony({ state: 'approval_requested' }));
    expect(card.text).toContain('Tap again to confirm');
    expect(card.buttons).toEqual([
      [
        { text: '✅✅ Confirm', callback_data: 'sign:approve:cer-1' },
        { text: '❌ Cancel', callback_data: 'sign:cancel:cer-1' },
      ],
    ]);
  });

  it('renders success receipt', () => {
    const r = renderReceipt({
      ceremony: makeCeremony({ state: 'signed', completedAt: Date.now() }),
      outcome: 'signed',
    });
    expect(r.text).toMatch(/✅ Signed/);
    expect(r.text).toContain('NDA');
  });

  it('renders failure receipt with reason and manual-open button', () => {
    const r = renderReceipt({
      ceremony: makeCeremony({
        state: 'failed',
        failureReason: 'layout_changed',
        completedAt: Date.now(),
      }),
      outcome: 'failed',
    });
    expect(r.text).toMatch(/❌ Sign failed/);
    expect(r.text).toContain('layout_changed');
    expect(r.buttons).toEqual([
      [{ text: '🖥 Open in browser', url: 'https://na3.docusign.net/Signing/abc' }],
    ]);
  });
});
