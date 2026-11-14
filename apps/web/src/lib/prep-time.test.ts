import { describe, expect, it } from 'vitest';
import { PREP_TIME_CHOICES, UNDECLARED_PREP_MINUTES, storePrepChoice } from './prep-time';

// ---------------------------------------------------------------------------
// [APP-PREPTIME ROUND 2 · owner ruling 14 Nov 2026] The time the website's Accept
// pre-selects is the STORE'S OWN declared prep time (Vendor.estimatedPrepTime;
// the order carries it from checkout) when it is one of the six choices, else
// the closest choice; halfway takes the longer one. The same rule as the app
// (apps/mobile/src/modules/vendor/prepTime.ts storePrepChoice).
// ---------------------------------------------------------------------------

describe('[ROUND 2] the store\'s own prep time, as one of the six choices', () => {
  it('the six choices are the app\'s', () => {
    expect([...PREP_TIME_CHOICES]).toEqual([10, 15, 20, 30, 45, 60]);
  });

  it('a declared choice is itself; any other time is the closest choice', () => {
    for (const m of PREP_TIME_CHOICES) expect(storePrepChoice(m)).toBe(m);
    const table: Array<[number, number]> = [
      [1, 10], [5, 10], [12, 10], [13, 15], [17, 15], [18, 20], [22, 20], [24, 20], [26, 30],
      [33, 30], [37, 30], [38, 45], [50, 45], [52, 45], [53, 60], [75, 60], [90, 60], [480, 60],
    ];
    for (const [declared, choice] of table) expect(storePrepChoice(declared), String(declared)).toBe(choice);
  });

  it('halfway takes the LONGER choice', () => {
    for (const [declared, choice] of [[12.5, 15], [17.5, 20], [25, 30], [37.5, 45], [52.5, 60]] as const) {
      expect(storePrepChoice(declared), String(declared)).toBe(choice);
    }
  });

  it('no declared time: 30, the store default the server\'s clocks assume', () => {
    expect(UNDECLARED_PREP_MINUTES).toBe(30);
    for (const v of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '20']) expect(storePrepChoice(v), String(v)).toBe(30);
  });
});
