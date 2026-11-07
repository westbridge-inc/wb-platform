import { describe, expect, it } from 'vitest';
import { nextDeadline } from './useDeadlineClock';

// [APP-SPEED C · report item 8] The clock waits for the nearest moment a fact flips; past and unknown ones are ignored.
describe('nextDeadline', () => {
  it('the nearest deadline still ahead (one at `now` itself counts: it flips a millisecond later)', () => {
    expect(nextDeadline([5_000, 2_000, 9_000], 1_000)).toBe(2_000);
    expect(nextDeadline([1_000, 9_000], 1_000)).toBe(1_000);
  });
  it('past, missing and unparsable deadlines are ignored; none ahead is null (no timer)', () => {
    expect(nextDeadline([500, null, undefined, Number.NaN, Date.parse('')], 1_000)).toBeNull();
    expect(nextDeadline([], 1_000)).toBeNull();
    expect(nextDeadline([500, 3_000], 1_000)).toBe(3_000);
  });
});
