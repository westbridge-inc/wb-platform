import { describe, expect, it } from 'vitest';
import { acceptRowState, keepDemandOfKind, moverCameraRegion } from './moverHomeMap';

// [APP-SPEED C · report item 9] The driver Home map's pure seams (the screen's behaviour is in
// MoverHomeScreen.mapAndBoard.navigation.test.ts; the demand query's in hooks/mover.demandKeep.test.ts).
describe('[APP-SPEED C] moverHomeMap', () => {
  it('the camera sits just south of the driver, as before', () => {
    expect(moverCameraRegion(6.81, -58.15)).toEqual({ latitude: 6.81 - 0.008, longitude: -58.15, latitudeDelta: 0.04, longitudeDelta: 0.04 });
  });

  it('demand: the last answer is kept for the same kind of work only', () => {
    const keep = keepDemandOfKind('DRIVER');
    expect(keep({ waiting: 2 }, { queryKey: ['mover', 'demand', 'DRIVER', '6.810,-58.150'] })).toEqual({ waiting: 2 });
    expect(keep({ waiting: 2 }, { queryKey: ['mover', 'demand', 'RIDER', '6.810,-58.150'] })).toBeUndefined();
    expect(keep(undefined, undefined)).toBeUndefined();
  });

  it('accept rows: this row, another row, none; an accept with no row id shows on every row (as before)', () => {
    expect(acceptRowState(false, { id: 'a' }, 'a')).toBe('idle');
    expect(acceptRowState(true, { id: 'a' }, 'a')).toBe('mine');
    expect(acceptRowState(true, { id: 'a' }, 'b')).toBe('other');
    expect(acceptRowState(true, undefined, 'b')).toBe('mine');
    expect(acceptRowState(true, { id: '' }, 'b')).toBe('mine');
  });
});
