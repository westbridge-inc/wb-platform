import { describe, it, expect } from 'vitest';
import { orderLimitCounts } from '../modules/integrity/velocity';
import { planFulfillment } from '../modules/order/cart-plans';

// ---------------------------------------------------------------------------
// [OWNER-ASKS · owner 9 Nov 2026] Only pickup is unlimited. A delivery, a parcel and a booking keep the hourly order
// limit (6 for a person, 12 across linked accounts). Checkout reserves one order for every plan whose fulfillment
// orderLimitCounts() counts, and a booking's plan is APPOINTMENT whatever the client sent (planFulfillment). These
// pin that a booking still counts, so narrowing the predicate to "DELIVERY only" turns a test red.
// The same rule is proved end to end (a booking refused at the limit) in order-place-limit.test.ts.
// ---------------------------------------------------------------------------

const booking = [{ item: { fulfillment: 'APPOINTMENT' } }];
const food = [{ item: { fulfillment: 'DELIVERY' } }];

describe('[OWNER-ASKS 9 Nov] which orders the hourly limit counts', () => {
  it('a booking counts', () => {
    expect(orderLimitCounts('APPOINTMENT')).toBe(true);
  });

  it('a delivery counts; a pickup never does', () => {
    expect(orderLimitCounts('DELIVERY')).toBe(true);
    expect(orderLimitCounts('PICKUP')).toBe(false);
  });

  it('a booking the client sends as a pickup is still a booking, and still counts', () => {
    for (const claimed of ['PICKUP', 'DELIVERY', undefined] as const) {
      const plan = planFulfillment(booking, claimed);
      expect(plan, `claimed ${claimed ?? 'nothing'}`).toBe('APPOINTMENT');
      expect(orderLimitCounts(plan), `claimed ${claimed ?? 'nothing'}`).toBe(true);
    }
  });

  it('a store order counts unless it is a pickup', () => {
    expect(orderLimitCounts(planFulfillment(food, undefined))).toBe(true);
    expect(orderLimitCounts(planFulfillment(food, 'DELIVERY'))).toBe(true);
    expect(orderLimitCounts(planFulfillment(food, 'PICKUP'))).toBe(false);
  });
});
