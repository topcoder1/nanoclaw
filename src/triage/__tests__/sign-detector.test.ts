import { describe, it, expect } from 'vitest';
import {
  detectSignUrl,
  isSignInvite,
  looksLikeSignInvite,
} from '../sign-detector.js';

describe('looksLikeSignInvite', () => {
  it('identifies DocuSign by sender', () => {
    expect(
      looksLikeSignInvite({
        from: 'DocuSign System <dse_NA4@docusign.net>',
        subject: 'Please DocuSign: Contract.pdf',
      }),
    ).toBe('docusign');
  });

  it('identifies Adobe Sign by sender', () => {
    expect(
      looksLikeSignInvite({
        from: 'Acme via Adobe Acrobat Sign <echosign@echosign.com>',
        subject: 'Please sign: Lease',
      }),
    ).toBe('adobe_sign');
  });

  it('identifies Dropbox Sign by sender', () => {
    expect(
      looksLikeSignInvite({
        from: 'noreply@mail.hellosign.com',
        subject: 'Your document is ready',
      }),
    ).toBe('dropbox_sign');
  });

  it('returns null for unrelated senders even with sign-like subject', () => {
    // looksLikeSignInvite only vouches for vendor-confirmed senders.
    expect(
      looksLikeSignInvite({
        from: 'friend@example.com',
        subject: 'please sign my yearbook',
      }),
    ).toBeNull();
  });
});

describe('isSignInvite', () => {
  it('true when sender is a known vendor', () => {
    expect(
      isSignInvite({
        from: 'dse@docusign.net',
        subject: 'Completed: agreement',
      }),
    ).toBe(true);
  });

  it('true when subject has explicit signing language', () => {
    expect(
      isSignInvite({
        from: 'legal@counterparty.com',
        subject: 'You are invited to sign an electronic document',
      }),
    ).toBe(true);
  });

  it('false for generic business email', () => {
    expect(
      isSignInvite({
        from: 'colleague@work.com',
        subject: 'Re: meeting notes',
      }),
    ).toBe(false);
  });
});

describe('detectSignUrl', () => {
  it('extracts DocuSign Signing URL', () => {
    const body = `Hi Jonathan,

Please review and sign: https://na4.docusign.net/Signing/EmailStart.aspx?a=abc&etti=1
Thanks,
Legal`;
    expect(
      detectSignUrl({
        from: 'dse_NA4@docusign.net',
        subject: 'Please DocuSign',
        body,
      }),
    ).toEqual({
      vendor: 'docusign',
      signUrl:
        'https://na4.docusign.net/Signing/EmailStart.aspx?a=abc&etti=1',
    });
  });

  it('extracts Adobe Sign secure URL', () => {
    const body =
      'Review at https://secure.na1.adobesign.com/public/esignWidget?wid=CBFCIBAA.';
    const out = detectSignUrl({
      from: 'echosign@echosign.com',
      subject: 'Please sign',
      body,
    });
    expect(out?.vendor).toBe('adobe_sign');
    expect(out?.signUrl).toBe(
      'https://secure.na1.adobesign.com/public/esignWidget?wid=CBFCIBAA',
    );
  });

  it('extracts Dropbox Sign editor URL', () => {
    const body = 'Sign now: https://app.hellosign.com/editor/sign?guid=xyz123';
    expect(
      detectSignUrl({
        from: 'noreply@mail.hellosign.com',
        subject: 'Doc to sign',
        body,
      })?.vendor,
    ).toBe('dropbox_sign');
  });

  it('falls back across vendors when sender does not match', () => {
    // Forwarded DocuSign invite — sender is a friend, but body still has the URL.
    const body = 'FYI — please sign: https://na3.docusign.net/Member/View?t=1';
    const out = detectSignUrl({
      from: 'friend@example.com',
      subject: 'Fwd: Please DocuSign',
      body,
    });
    expect(out?.vendor).toBe('docusign');
  });

  it('returns null when no vendor URL is present', () => {
    expect(
      detectSignUrl({
        from: 'someone@example.com',
        subject: 'Hello',
        body: 'No links here, just words.',
      }),
    ).toBeNull();
  });

  it('strips trailing punctuation from extracted URL', () => {
    const body =
      'See (https://app.pandadoc.com/s/abc123).';
    const out = detectSignUrl({
      from: 'notifications@pandadoc.com',
      subject: 'Please sign',
      body,
    });
    expect(out?.signUrl).toBe('https://app.pandadoc.com/s/abc123');
  });
});
