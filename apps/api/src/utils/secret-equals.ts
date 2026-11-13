import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * [AUDIT-20261113 FABLE-03 S4] Compare a presented secret with the configured one in constant time. Both sides
 * are hashed first, so neither the length nor the first differing byte shows in the timing. A missing side
 * never matches.
 */
export function secretEquals(presented: unknown, expected: string | null | undefined): boolean {
  if (typeof presented !== 'string' || !expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
