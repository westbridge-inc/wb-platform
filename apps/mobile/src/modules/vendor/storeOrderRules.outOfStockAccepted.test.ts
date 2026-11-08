import { describe, expect, it } from 'vitest';
import { lastItemAfterAccept, nothingLeftToHandOver, storeCanReject } from './storeOrderRules';
import { lineRemoved } from '../orders/substitutionCopy';

// ---------------------------------------------------------------------------
// [OOS-FLOW · owner 8 Nov 2026] The shared (phone + web) rules for an item out
// of stock AFTER the store accepted: the last item still coming (removing it
// cancels the order, so the store is asked once), an order emptied on an older
// server, and whether the store may still reject it itself.
// ---------------------------------------------------------------------------

const l = (subStatus: string, extra: Record<string, unknown> = {}) => ({ subStatus, ...extra });

describe('lastItemAfterAccept', () => {
  it('is the one line still coming on an accepted order', () => {
    const keep = l('NONE');
    const order = { status: 'PREPARING', items: [l('REFUNDED'), l('REJECTED'), keep] };
    expect(lastItemAfterAccept(order, keep)).toBe(true);
  });
  it('a swap waiting on the customer is still coming (it may be approved)', () => {
    const asked = l('PENDING', { substituteName: 'Tank top' });
    const order = { status: 'RIDER_ASSIGNED', items: [l('REFUNDED'), asked] };
    expect(lastItemAfterAccept(order, asked)).toBe(true);
  });
  it('not while another line is still coming, never for a removed line, never before the accept', () => {
    const a = l('NONE');
    const b = l('APPROVED');
    expect(lastItemAfterAccept({ status: 'PREPARING', items: [a, b] }, a)).toBe(false);
    const gone = l('REFUNDED');
    expect(lastItemAfterAccept({ status: 'PREPARING', items: [gone] }, gone)).toBe(false);
    const only = l('NONE');
    expect(lastItemAfterAccept({ status: 'PENDING', items: [only] }, only)).toBe(false); // the waiting rule is lastLineStanding
  });
});

describe('nothingLeftToHandOver', () => {
  it('an accepted, live order whose every line came off', () => {
    expect(nothingLeftToHandOver({ status: 'PREPARING', items: [l('REFUNDED'), l('REJECTED')] })).toBe(true);
    expect(nothingLeftToHandOver({ status: 'RIDER_ASSIGNED', items: [l('REFUNDED')] })).toBe(true);
  });
  it('never with a line still coming, never on a waiting or closed order, never with no lines read', () => {
    expect(nothingLeftToHandOver({ status: 'PREPARING', items: [l('REFUNDED'), l('NONE')] })).toBe(false);
    expect(nothingLeftToHandOver({ status: 'PENDING', items: [l('REFUNDED')] })).toBe(false);
    expect(nothingLeftToHandOver({ status: 'CANCELLED', items: [l('REFUNDED')] })).toBe(false);
    expect(nothingLeftToHandOver({ status: 'PREPARING', items: [] })).toBe(false);
    expect(nothingLeftToHandOver({ status: 'PREPARING' })).toBe(false);
  });
});

describe('storeCanReject (the server\'s STORE_REJECTABLE_STATUSES)', () => {
  it.each(['PENDING', 'ACCEPTED', 'PREPARING'])('%s: the store rejects it itself', (status) => {
    expect(storeCanReject({ status })).toBe(true);
  });
  it.each(['READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'PICKED_UP', 'CANCELLED', undefined])('%s: only Swift support', (status) => {
    expect(storeCanReject({ status })).toBe(false);
  });
});

describe('lineRemoved (the customer\'s order list)', () => {
  it('a line taken off or a declined swap is not charged; every other line is', () => {
    expect(lineRemoved({ subStatus: 'REFUNDED' })).toBe(true);
    expect(lineRemoved({ subStatus: 'REJECTED' })).toBe(true);
    for (const subStatus of ['NONE', 'PENDING', 'APPROVED', null, undefined]) expect(lineRemoved({ subStatus })).toBe(false);
    expect(lineRemoved(null)).toBe(false);
  });
});
