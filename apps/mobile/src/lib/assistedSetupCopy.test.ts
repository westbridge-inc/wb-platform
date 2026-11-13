import { describe, expect, it } from 'vitest';
import { ADDED_BY_SWIFT_REPLACE_HINT, addedBySwiftLine, photoAddedBySwiftLine } from './assistedSetupCopy';

// [ASSISTED SETUP · owner 12 Nov 2026] What the store reads on a paper, an item or a photo Swift added with its OK: the
// day in Guyana, never who at Swift; and that it can replace it.
describe('[ASSISTED SETUP] the store’s words', () => {
  it('names the Guyana day it was added, and says the store agreed', () => {
    expect(addedBySwiftLine('2026-11-12T14:00:00.000Z')).toBe('Added by Swift on 12 Nov 2026 with your OK');
    // 02:00Z on the 13th is still the 12th in Guyana (UTC-4).
    expect(addedBySwiftLine('2026-11-13T02:00:00.000Z')).toBe('Added by Swift on 12 Nov 2026 with your OK');
    expect(photoAddedBySwiftLine('2026-11-12T14:00:00.000Z')).toBe('Photo added by Swift on 12 Nov 2026 with your OK');
  });

  it('without a readable date, still says it, without inventing one', () => {
    expect(addedBySwiftLine(null)).toBe('Added by Swift with your OK');
    expect(addedBySwiftLine('not a date')).toBe('Added by Swift with your OK');
    expect(photoAddedBySwiftLine(undefined)).toBe('Photo added by Swift with your OK');
    expect(ADDED_BY_SWIFT_REPLACE_HINT).toBe('You can replace it any time.');
  });
});
