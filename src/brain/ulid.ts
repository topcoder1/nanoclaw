/**
 * Thin ULID wrapper — exists so tests can swap in a seedable generator
 * without reaching into the `ulid` package. Production code should only
 * import `newId` from here, never `ulid` directly.
 */

import { ulid } from 'ulid';

export function newId(): string {
  return ulid();
}
