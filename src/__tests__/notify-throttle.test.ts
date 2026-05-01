import { describe, it, expect, beforeEach } from 'vitest';
import { shouldNotify, _resetNotifyThrottle } from '../notify-throttle.js';

describe('shouldNotify', () => {
  beforeEach(() => _resetNotifyThrottle());

  it('returns true on the first call for a key', () => {
    expect(shouldNotify('k', 1000, 0)).toBe(true);
  });

  it('returns false within the ttl window', () => {
    expect(shouldNotify('k', 1000, 0)).toBe(true);
    expect(shouldNotify('k', 1000, 500)).toBe(false);
    expect(shouldNotify('k', 1000, 999)).toBe(false);
  });

  it('returns true once the ttl has elapsed', () => {
    expect(shouldNotify('k', 1000, 0)).toBe(true);
    expect(shouldNotify('k', 1000, 1000)).toBe(true);
  });

  it('throttles independently per key', () => {
    expect(shouldNotify('a', 1000, 0)).toBe(true);
    expect(shouldNotify('b', 1000, 0)).toBe(true);
    expect(shouldNotify('a', 1000, 100)).toBe(false);
    expect(shouldNotify('b', 1000, 100)).toBe(false);
  });

  it('records the timestamp of the most recent accepted call', () => {
    expect(shouldNotify('k', 1000, 0)).toBe(true);
    expect(shouldNotify('k', 1000, 1500)).toBe(true);
    expect(shouldNotify('k', 1000, 2000)).toBe(false);
    expect(shouldNotify('k', 1000, 2500)).toBe(true);
  });
});
