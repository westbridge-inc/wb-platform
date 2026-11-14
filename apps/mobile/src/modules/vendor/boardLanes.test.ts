import { describe, expect, it } from 'vitest';
import { BOARD_LANES, boardLanes, laneColumns, laneOf } from './boardLanes';

// [STORE-BOARD · parity audit A2 + A3] The tablet board's lanes, the website's own: New, Preparing, Ready / handoff,
// Out for delivery. Every open order lands in exactly one lane; a status this build does not know is still the store's
// work (Preparing), never nowhere. A phone keeps its one list.

const OPEN = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
  'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RETURNING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'];

describe('[STORE-BOARD] board lanes', () => {
  it('the website\'s lanes, in its order', () => {
    expect(BOARD_LANES.map((l) => l.label)).toEqual(['New', 'Preparing', 'Ready / handoff', 'Out for delivery']);
  });

  it('each open status in the website\'s lane', () => {
    expect(laneOf('PENDING')).toBe('new');
    for (const s of ['ACCEPTED', 'PREPARING']) expect(laneOf(s)).toBe('kitchen');
    for (const s of ['READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP']) expect(laneOf(s)).toBe('handoff');
    for (const s of ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'RETURNING', 'DRIVER_ASSIGNED', 'RIDE_IN_PROGRESS']) expect(laneOf(s)).toBe('moving');
    expect(laneOf('preparing')).toBe('kitchen');
  });

  it('no order is ever dropped: every order in exactly one lane, an unknown status in Preparing', () => {
    const orders = [...OPEN, 'SOMETHING_NEW', null].map((status, i) => ({ id: `o${i}`, status }));
    const lanes = boardLanes(orders);
    const all = Object.values(lanes).flat();
    expect(all).toHaveLength(orders.length);
    expect(new Set(all.map((o) => o.id)).size).toBe(orders.length);
    expect(lanes.kitchen.map((o) => o.status)).toContain('SOMETHING_NEW');
  });

  it('a phone keeps one list; a tablet in portrait gets two lanes a row; a wide one all four', () => {
    expect(laneColumns(390)).toBe(1);
    expect(laneColumns(759)).toBe(1);
    expect(laneColumns(768)).toBe(2);
    expect(laneColumns(834)).toBe(2);
    expect(laneColumns(1024)).toBe(4);
    expect(laneColumns(Number.NaN)).toBe(1);
  });
});
