import { describe, it, expect } from 'vitest';
import { classifySender, classifySubtype } from '../sender-kind.js';

describe('classifySender', () => {
  it('returns bot when List-Unsubscribe header present', () => {
    expect(
      classifySender({
        from: 'someone@example.com',
        headers: { 'List-Unsubscribe': '<https://unsub>' },
      }),
    ).toBe('bot');
  });

  it('returns bot when List-Id present', () => {
    expect(
      classifySender({
        from: 'newsletter@mailchimp.com',
        headers: { 'List-Id': '<x.list>' },
      }),
    ).toBe('bot');
  });

  it('returns bot when Precedence: bulk', () => {
    expect(
      classifySender({
        from: 'notifications@x.com',
        headers: { Precedence: 'bulk' },
      }),
    ).toBe('bot');
  });

  it('returns bot when From local-part is a no-reply variant', () => {
    expect(classifySender({ from: 'no-reply@stripe.com', headers: {} })).toBe(
      'bot',
    );
    expect(classifySender({ from: 'noreply@apple.com', headers: {} })).toBe(
      'bot',
    );
    expect(classifySender({ from: 'do-not-reply@bank.com', headers: {} })).toBe(
      'bot',
    );
    expect(
      classifySender({ from: 'notifications@github.com', headers: {} }),
    ).toBe('bot');
  });

  it('returns bot when sender domain matches known ESP', () => {
    expect(classifySender({ from: 'x@mail.mailchimp.com', headers: {} })).toBe(
      'bot',
    );
    expect(classifySender({ from: 'bounce@amazonses.com', headers: {} })).toBe(
      'bot',
    );
  });

  it('returns human for an ordinary personal address with no bot signals', () => {
    expect(classifySender({ from: 'jane@personal.com', headers: {} })).toBe(
      'human',
    );
  });

  it('returns human when inconclusive (fail-open)', () => {
    expect(
      classifySender({ from: 'contact@somecompany.com', headers: {} }),
    ).toBe('human');
  });
});

describe('classifySubtype', () => {
  it('returns transactional for Stripe verification code', () => {
    expect(
      classifySubtype({
        from: 'noreply@stripe.com',
        gmailCategory: 'CATEGORY_UPDATES',
        subject: 'Your Stripe verification code',
        body: 'Your verification code is 123456',
      }),
    ).toBe('transactional');
  });

  it('returns transactional for Apple receipt', () => {
    expect(
      classifySubtype({
        from: 'no_reply@email.apple.com',
        gmailCategory: 'CATEGORY_UPDATES',
        subject: 'Your receipt from Apple',
        body: 'your receipt',
      }),
    ).toBe('transactional');
  });

  it('returns null for newsletter (promotional, not transactional)', () => {
    expect(
      classifySubtype({
        from: 'news@mailchimp.com',
        gmailCategory: 'CATEGORY_PROMOTIONS',
        subject: 'Weekly roundup',
        body: 'Our top stories this week',
      }),
    ).toBe(null);
  });

  it('returns null for human email', () => {
    expect(
      classifySubtype({
        from: 'jane@personal.com',
        gmailCategory: null,
        subject: 'Lunch tomorrow?',
        body: 'Want to grab lunch?',
      }),
    ).toBe(null);
  });
});
