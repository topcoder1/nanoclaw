// Lesson 2026-07-01: recordTrustDecision must compute graduation confidence
// with the same clock read it stores as last_updated. Re-reading Date.now()
// inside calculateConfidence let a ≥1ms scheduler gap on loaded CI runners
// apply nonzero decay, pushing an exact-threshold confidence (4 approvals →
// 4/5 = 0.80 vs write gate 0.80) below the gate so trust.graduated never
// fired ("expected false to be true" at trust-engine.test.ts:162; passed on
// fast dev machines where all four records land in the same millisecond).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _initTestDatabase, _closeDatabase } from '../../src/db.js';
import { eventBus } from '../../src/event-bus.js';
import { recordTrustDecision } from '../../src/trust-engine.js';

beforeEach(() => _initTestDatabase());
afterEach(() => {
  eventBus.removeAllListeners();
  _closeDatabase();
});

describe('trust graduation under clock skew', () => {
  it('graduation at an exact-threshold confidence survives clock ticks mid-record', () => {
    // Simulate the slow-runner scheduler gap by skewing every Date.now()
    // read 5ms later than the previous one. On the pre-fix code the decay
    // reference then trails the recorded timestamp, so 0.80 - ε < 0.80 and
    // the event never fires.
    const realNow = Date.now.bind(Date);
    let tick = 0;
    const spy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + 5 * ++tick);
    try {
      let graduated = false;
      eventBus.on('trust.graduated', () => {
        graduated = true;
      });
      // write threshold = 0.8; 4th approval lands exactly on it (4/5).
      for (let i = 0; i < 4; i++) {
        recordTrustDecision('send_message', 'group1', 'approved');
      }
      expect(graduated).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
