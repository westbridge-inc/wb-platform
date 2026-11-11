import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { moverHomeResting } from './moverHomeResting';

// [PROD-RIDER-TEST 11 Nov 2026 · COORD ruling (b)3] The rider's home takes a downloaded update only when nothing on it
// can be cut: never over a ringing offer card, a live delivery or ride, or before the job read has answered.
const idle = { kind: 'RIDER', jobKnown: true, activeJob: null, run: null, offer: null, queuedBehind: 0 };

describe('[PROD-RIDER-TEST (b)3] when the rider\'s home is a resting screen', () => {
  it('idle: no job, no run, no offer -> resting', () => {
    expect(moverHomeResting(idle)).toBe(true);
  });

  it('never with an offer card up or waiting, a live job or run, an unknown job read, or no kind yet', () => {
    expect(moverHomeResting({ ...idle, offer: { orderId: 'o1' } })).toBe(false);
    expect(moverHomeResting({ ...idle, queuedBehind: 1 })).toBe(false);
    expect(moverHomeResting({ ...idle, activeJob: { id: 'o2' } })).toBe(false);
    expect(moverHomeResting({ ...idle, run: { legs: 2 } })).toBe(false);
    expect(moverHomeResting({ ...idle, jobKnown: false })).toBe(false);
    expect(moverHomeResting({ ...idle, kind: null })).toBe(false);
  });

  it('the home screen claims MoverRoot with exactly this rule (no other claim of the route anywhere)', () => {
    const src = readFileSync(join(__dirname, '../modules/mover/screens/MoverHomeScreen.tsx'), 'utf8');
    expect(src).toContain("useOtaRestingRoute('MoverRoot', moverHomeResting({ kind, jobKnown: active.isSuccess, activeJob: active.data, run, offer, queuedBehind }));");
  });
});
