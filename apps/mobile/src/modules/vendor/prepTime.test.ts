import { beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] Restaurants run the Swift APP on a tablet,
// so the app's Accept carries a preparation time exactly like the website's
// (NewOrderTakeover.tsx / order-detail.tsx): 10, 15, 20, 30, 45 or 60 minutes.
// A booking is never asked (the website sends none for an APPOINTMENT).
// [ROUND 2 · owner ruling 14 Nov] The pre-selected time is the STORE'S OWN
// declared prep time (the order carries it from checkout) when it is a choice,
// else the closest choice (halfway takes the longer one). Staff can tap
// another; a time staff changed is remembered per store on this device and
// wins until they tap the store's own time again or the store's time changes.
// Fail-safe: a storage that throws or holds junk falls back to the store's time.
// ---------------------------------------------------------------------------

const disk = { values: new Map<string, string>(), broken: false };
const fakeDevice = {
  getString(key: string) { if (disk.broken) throw new Error('disk'); return disk.values.get(key); },
  set(key: string, value: string) { if (disk.broken) throw new Error('disk'); disk.values.set(key, value); },
};

import { PREP_TIME_CHOICES, UNDECLARED_PREP_MINUTES, acceptPrepMinutes, asksPrepTime, isPrepChoice, prepChipLabel, prepChoiceHeading, storePrepChoice } from './prepTime';
import { bindPrepTimeStorage, rememberPrepMinutes, rememberedPrepMinutes, startingPrepMinutes } from './prepTimeMemory';

beforeEach(() => { disk.values.clear(); disk.broken = false; bindPrepTimeStorage(fakeDevice); });

describe('[APP-PREPTIME] the same choices and default as the website', () => {
  it('10, 15, 20, 30, 45 or 60 minutes', () => {
    expect([...PREP_TIME_CHOICES]).toEqual([10, 15, 20, 30, 45, 60]);
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

describe('[ROUND 2 · owner 14 Nov] the store\'s own declared prep time is pre-selected', () => {
  it('a declared time that is a choice is pre-selected as it is', () => {
    for (const m of PREP_TIME_CHOICES) expect(storePrepChoice(m)).toBe(m);
  });

  it('any other declared time: the closest choice', () => {
    const table: Array<[number, number]> = [
      [1, 10], [5, 10], [12, 10], [13, 15], [17, 15], [18, 20], [22, 20], [24, 20], [26, 30],
      [33, 30], [37, 30], [38, 45], [50, 45], [52, 45], [53, 60], [75, 60], [90, 60], [480, 60],
    ];
    for (const [declared, choice] of table) expect(storePrepChoice(declared), String(declared)).toBe(choice);
  });

  it('halfway between two choices takes the LONGER one (a kitchen quoted too short gets riderless orders cancelled sooner)', () => {
    for (const [declared, choice] of [[12.5, 15], [17.5, 20], [25, 30], [37.5, 45], [52.5, 60]] as const) {
      expect(storePrepChoice(declared), String(declared)).toBe(choice);
    }
  });

  it('no declared time (none, 0, junk): 30, the store default the server\'s clocks also assume', () => {
    expect(UNDECLARED_PREP_MINUTES).toBe(30);
    for (const v of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '20', {}]) {
      expect(storePrepChoice(v), String(v)).toBe(30);
    }
  });
});

describe('[ROUND 2] a time staff changed, per store, on this device', () => {
  it('nothing remembered: the store\'s own time', () => {
    expect(rememberedPrepMinutes('store-a', 30)).toBeNull();
    expect(startingPrepMinutes('store-a', 30)).toBe(30);
    expect(startingPrepMinutes('store-a', 45)).toBe(45);
    expect(startingPrepMinutes('store-a', 25)).toBe(30);
    expect(startingPrepMinutes('store-a', null)).toBe(30);
  });

  it('a changed time is remembered for its own store only, and wins over the store\'s time', () => {
    rememberPrepMinutes('store-a', 45, 30);
    expect(startingPrepMinutes('store-a', 30)).toBe(45);
    expect(startingPrepMinutes('store-b', 30)).toBe(30);
  });

  it('tapping the store\'s own time again forgets the change', () => {
    rememberPrepMinutes('store-a', 45, 30);
    rememberPrepMinutes('store-a', 30, 30);
    expect(rememberedPrepMinutes('store-a', 30)).toBeNull();
    expect(startingPrepMinutes('store-a', 30)).toBe(30);
  });

  it('the store changes its own declared time: the old change no longer applies', () => {
    rememberPrepMinutes('store-a', 45, 30);
    expect(startingPrepMinutes('store-a', 20)).toBe(20);
    expect(startingPrepMinutes('store-a', 60)).toBe(60);
    // ... and still applies if the store goes back to 30 (the change was made against 30).
    expect(startingPrepMinutes('store-a', 30)).toBe(45);
  });

  it('never remembers a non-choice, and never with no store', () => {
    rememberPrepMinutes('store-a', 25, 30);
    rememberPrepMinutes(undefined, 45, 30);
    rememberPrepMinutes(null, 45, 30);
    expect(startingPrepMinutes('store-a', 30)).toBe(30);
    expect(disk.values.size).toBe(0);
  });

  it('junk on the device reads as the store\'s own time', () => {
    rememberPrepMinutes('store-a', 45, 30);
    for (const junk of ['not-a-number', '7', '45', '45/abc', '7/30', '45/30/1', '']) {
      for (const [k] of disk.values) disk.values.set(k, junk);
      expect(startingPrepMinutes('store-a', 30), junk).toBe(30);
    }
  });

  it('a storage that throws never breaks Accept: the store\'s own time, and the write is dropped', () => {
    disk.broken = true;
    expect(() => rememberPrepMinutes('store-a', 45, 30)).not.toThrow();
    expect(startingPrepMinutes('store-a', 30)).toBe(30);
  });

  it('a device storage that cannot open: the change holds for this run only', () => {
    bindPrepTimeStorage(null);
    expect(startingPrepMinutes('store-a', 30)).toBe(30);
    rememberPrepMinutes('store-a', 15, 30);
    expect(startingPrepMinutes('store-a', 30)).toBe(15);
    expect(startingPrepMinutes('store-b', 30)).toBe(30);
    expect(disk.values.size).toBe(0);
  });

  it('the real module in a runner without the native storage still answers (no crash at import or use)', () => {
    bindPrepTimeStorage(undefined); // re-open the device storage on next use
    expect(() => rememberPrepMinutes('store-z', 30, 20)).not.toThrow();
    expect(PREP_TIME_CHOICES).toContain(startingPrepMinutes('store-z', 20));
  });
});
