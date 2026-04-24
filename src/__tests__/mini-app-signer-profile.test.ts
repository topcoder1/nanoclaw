import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { runMigrations } from '../db.js';
import { createMiniAppServer } from '../mini-app/server.js';
import { getProfile } from '../signer/profile.js';

describe('mini-app /signer/profile', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createMiniAppServer>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    app = createMiniAppServer({ port: 0, db });
  });

  it('GET renders empty form when no profile exists', async () => {
    const res = await request(app).get('/signer/profile');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form');
    expect(res.text).toContain('name="fullName"');
    expect(res.text).toContain('name="initials"');
  });

  it('POST creates profile', async () => {
    const res = await request(app).post('/signer/profile').type('form').send({
      fullName: 'Alice Example',
      initials: 'AE',
      title: 'CEO',
      address: '1 Market St',
      phone: '555-0100',
    });
    expect(res.status).toBe(302);
    const p = getProfile(db);
    expect(p?.fullName).toBe('Alice Example');
  });

  it('POST with missing required fields returns 400', async () => {
    const res = await request(app)
      .post('/signer/profile')
      .type('form')
      .send({ fullName: 'x' });
    expect(res.status).toBe(400);
  });

  it('GET renders existing profile values', async () => {
    await request(app)
      .post('/signer/profile')
      .type('form')
      .send({ fullName: 'Alice', initials: 'A' });
    const res = await request(app).get('/signer/profile');
    expect(res.text).toContain('value="Alice"');
    expect(res.text).toContain('value="A"');
  });
});
