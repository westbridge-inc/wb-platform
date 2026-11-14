import { beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] Restaurants run the Swift APP on a tablet,
// so the app's Accept carries a preparation time exactly like the website's
// (NewOrderTakeover.tsx / order-detail.tsx): 10, 15, 20, 30, 45 or 60 minutes,
// 20 unless the staff pick another. A booking is never asked (the website
// sends none for an APPOINTMENT). The last choice is remembered per store on
// this device, fail-safe: a storage that throws or holds junk falls back to 20.
// ---------------------------------------------------------------------------

const disk = { values: new Map<string, string>(), broken: false };
const fakeDevice = {
  getString(key: string) { if (disk.broken) throw new Error('disk'); return disk.values.get(key); },
  set(key: string, value: string) { if (disk.broken) throw new Error('disk'); disk.values.set(key, value); },
};

import { DEFAULT_PREP_MINUTES, PREP_TIME_CHOICES, acceptPrepMinutes, asksPrepTime, isPrepChoice, prepChipLabel, prepChoiceHeading } from './prepTime';
import { bindPrepTimeStorage, rememberPrepMinutes, rememberedPrepMinutes, startingPrepMinutes } from './prepTimeMemory';

beforeEach(() => { disk.values.clear(); disk.broken = false; bindPrepTimeStorage(fakeDevice); });

describe('[APP-PREPTIME] the same choices and default as the website', () => {
  it('10, 15, 20, 30, 45 or 60 minutes; 20 by default', () => {
    expect([...PREP_TIME_CHOICES]).toEqual([10, 15, 20, 30, 45, 60]);
    expect(DEFAULT_PREP_MINUTES).toBe(20);
  });

  it('only a listed choice counts', () => {
    for (const m of PREP_TIME_CHOICES) expect(isPrepChoice(m)).toBe(true);
    for (const v of [0, 5, 25, 90, 20.5, '20', null, undefined, Number.NaN]) expect(isPrepChoice(v)).toBe(false);
  });

  it('a booking is never asked and never sends minutes; every other order does', () => {
    expect(asksPrepTime({ fulfillment: 'APPOINTMENT' })).toBe(false);
    for (const fulfillment of ['DELIVERY', 'PICKUP', undefined]) expect(asksPrepTime({ fulfillment })).toBe(true);
    // Not read yet: it may be a booking, so nothing is asked or sent.
    expect(asksPrepTime(undefined)).toBe(false);
    expect(asksPrepTime(null)).toBe(false);
    expect(acceptPrepMinutes(undefined, 20)).toBeUndefined();
    expect(acceptPrepMinutes({ fulfillment: 'APPOINTMENT' }, 30)).toBeUndefined();
    expect(acceptPrepMinutes({ fulfillment: 'DELIVERY' }, 30)).toBe(30);
    expect(acceptPrepMinutes({ fulfillment: 'PICKUP' }, 20)).toBe(20);
    expect(acceptPrepMinutes({ fulfillment: 'PICKUP' }, 25)).toBeUndefined();
  });

  it('the words: a kitchen says "Preparation time", any other store "Ready time"; chips read "N min"', () => {
    expect(prepChoiceHeading('RESTAURANT')).toBe('Preparation time');
    expect(prepChoiceHeading('SUPERMARKET')).toBe('Ready time');
    expect(prepChoiceHeading(undefined)).toBe('Ready time');
    expect(prepChipLabel(45)).toBe('45 min');
  });
});

describe('[APP-PREPTIME] the last choice, per store, on this device', () => {
  it('nothing remembered: 20', () => {
    expect(rememberedPrepMinutes('store-a')).toBeNull();
    expect(startingPrepMinutes('store-a')).toBe(20);
  });

  it('a choice is remembered for its own store only', () => {
    rememberPrepMinutes('store-a', 45);
    expect(startingPrepMinutes('store-a')).toBe(45);
    expect(startingPrepMinutes('store-b')).toBe(20);
  });

  it('never remembers a non-choice, and never with no store', () => {
    rememberPrepMinutes('store-a', 25);
    rememberPrepMinutes(undefined, 45);
    rememberPrepMinutes(null, 45);
    expect(startingPrepMinutes('store-a')).toBe(20);
    expect(disk.values.size).toBe(0);
  });

  it('junk on the device reads as 20', () => {
    rememberPrepMinutes('store-a', 30);
    for (const [k] of disk.values) disk.values.set(k, 'not-a-number');
    expect(startingPrepMinutes('store-a')).toBe(20);
    for (const [k] of disk.values) disk.values.set(k, '7');
    expect(startingPrepMinutes('store-a')).toBe(20);
  });

  it('a storage that throws never breaks Accept: 20, and the write is dropped', () => {
    disk.broken = true;
    expect(() => rememberPrepMinutes('store-a', 45)).not.toThrow();
    expect(startingPrepMinutes('store-a')).toBe(20);
  });

  it('a device storage that cannot open: the choice holds for this run only', () => {
    bindPrepTimeStorage(null);
    expect(startingPrepMinutes('store-a')).toBe(20);
    rememberPrepMinutes('store-a', 15);
    expect(startingPrepMinutes('store-a')).toBe(15);
    expect(startingPrepMinutes('store-b')).toBe(20);
    expect(disk.values.size).toBe(0);
  });

  it('the real module in a runner without the native storage still answers (no crash at import or use)', () => {
    bindPrepTimeStorage(undefined); // re-open the device storage on next use
    expect(() => rememberPrepMinutes('store-z', 30)).not.toThrow();
    expect(PREP_TIME_CHOICES).toContain(startingPrepMinutes('store-z'));
  });
});
