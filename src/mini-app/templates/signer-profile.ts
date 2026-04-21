import { escapeHtml as esc } from './escape.js';
import type { SignerProfile } from '../../signer/types.js';

export function renderProfileForm(profile: SignerProfile | null): string {
  const p = profile ?? {
    fullName: '',
    initials: '',
    title: null,
    address: null,
    phone: null,
  };
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Signer profile</title></head>
<body>
  <h1>Signer profile</h1>
  <p>Used to auto-fill DocuSign signing ceremonies.</p>
  <form method="post" action="/signer/profile">
    <label>Full name* <input name="fullName" required value="${esc(p.fullName ?? '')}"></label><br>
    <label>Initials* <input name="initials" required value="${esc(p.initials ?? '')}"></label><br>
    <label>Title <input name="title" value="${esc(p.title ?? '')}"></label><br>
    <label>Address <input name="address" value="${esc(p.address ?? '')}"></label><br>
    <label>Phone <input name="phone" value="${esc(p.phone ?? '')}"></label><br>
    <button type="submit">Save</button>
  </form>
</body>
</html>`;
}
