import { describe, it, expect } from 'vitest';
import { renderActionRow } from '../action-row.js';

describe('renderActionRow', () => {
  const base = { emailId: 'i1', account: 'a@x.com', threadId: 'thread-1' };

  it('push + human shows canned chips and Quick/Prompt/Archive primary', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',
      senderKind: 'human',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    expect(html).toContain('data-chip="thanks"');
    expect(html).toContain('data-chip="got-it"');
    expect(html).toContain('data-chip="will-do"');
    expect(html).toContain('data-action="quick-draft"');
    expect(html).toContain('data-action="draft-prompt"');
    expect(html).toContain('data-action="archive"');
    expect(html).not.toContain('data-action="unsubscribe"');
    expect(html).toContain('data-action="more"');
  });

  it('push + bot shows Archive/Snooze/Open primary, no chips', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',
      senderKind: 'bot',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    expect(html).not.toContain('data-chip=');
    expect(html).toContain('data-action="archive"');
    expect(html).toContain('data-action="snooze"');
    expect(html).toContain('data-action="open-gmail"');
  });

  it('digest + List-Unsubscribe shows Unsubscribe as primary', () => {
    const html = renderActionRow({
      ...base,
      classification: 'digest',
      senderKind: 'bot',
      subtype: null,
      hasUnsubscribeHeader: true,
    });
    expect(html).toContain('data-action="unsubscribe"');
    expect(html).toContain('data-action="mute"');
  });

  it('digest without unsubscribe omits it and adds Open in Gmail', () => {
    const html = renderActionRow({
      ...base,
      classification: 'digest',
      senderKind: 'bot',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    // unsubscribe may still appear in the hidden More row; check it's not
    // in the primary row.
    const primarySection = html
      .split('id="more-row"')[0];
    expect(primarySection).not.toContain('data-action="unsubscribe"');
    expect(html).toContain('data-action="open-gmail"');
    expect(html).toContain('data-action="mute"');
  });

  it('transactional is minimal: Archive + Open', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',
      senderKind: 'bot',
      subtype: 'transactional',
      hasUnsubscribeHeader: false,
    });
    const primarySection = html.split('id="more-row"')[0];
    expect(primarySection).toContain('data-action="archive"');
    expect(primarySection).toContain('data-action="open-gmail"');
    expect(primarySection).not.toContain('data-action="snooze"');
    expect(primarySection).not.toContain('data-action="mute"');
  });

  it('missing/ignore classification still shows More and Archive+Open', () => {
    const html = renderActionRow({
      ...base,
      classification: null,
      senderKind: 'unknown',
      subtype: null,
      hasUnsubscribeHeader: false,
    });
    expect(html).toContain('data-action="archive"');
    expect(html).toContain('data-action="more"');
  });

  it('More row (when expanded attribute is true) includes all other actions', () => {
    const html = renderActionRow({
      ...base,
      classification: 'push',
      senderKind: 'human',
      subtype: null,
      hasUnsubscribeHeader: false,
      expanded: true,
    });
    expect(html).toContain('id="more-row"');
    expect(html).toContain('data-action="snooze"');
    expect(html).toContain('data-action="mute"');
  });
});
