import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import { buildWalkWorld, call, castWalk, drainDue, placeCashOrder, releaseWorld, type Cast, type WalkWorld } from './helpers/order-walk-world';
import { testPhone } from './helpers/fixture-ids';
import { dispatchMoverOfferKey, dispatchOfferKey } from '../modules/dispatch/dispatch-generation-keys';
import { OWN_RIDER_NOTICE } from '../modules/order/own-rider-notice';

// ---------------------------------------------------------------------------
// [PROD-RIDER-TEST 11 Nov 2026 · COORD ruling (a) under the owner's "just fix these issues"]
// On production a store accepted a cash delivery, the rider search came back empty, and the customer's only way out
// was a free cancel — of food the store had already made. Now, once the search for THIS order comes back empty:
//  1. the store is asked at once (push + its order card): "No rider found. Deliver it yourselves?"; one tap takes
//     this order to the store's own delivery even without the standing self-delivery setting, the customer is told
//     in the own-rider notice's words, and "Find a rider" still searches again;
//  2. the customer is offered "Switch to pickup" (delivery fee and tip off) before the free cancel, which stays;
//  3. the store is told plainly when the customer cancels.
// Real routes and the real dispatch engine (helpers/order-walk-world.ts); nobody is online, so the search exhausts.
// ---------------------------------------------------------------------------

let w: WalkWorld;
const flagBefore = process.env['DISPATCH_EXHAUSTION'];
const inviteBefore = process.env['STAFF_INVITE_ACCEPT'];

/** [review S4-1/S4-2] A STAFF member of the store, signed in (a store tablet signed in as staff). */
async function addStaff(cast: Cast): Promise<{ userId: string; token: string }> {
  const user = await w.app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Walk', lastName: 'Staff', roles: ['CUSTOMER'] as never, activeRole: 'CUSTOMER' as never, isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  w.userIds.add(user.id);
  const token = w.app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await w.app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `walk-staff-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await w.app.prisma.vendorStaff.create({ data: { vendorId: cast.vendorId, userId: user.id, role: 'STAFF', invitedBy: cast.vendorOwner.userId } });
  return { userId: user.id, token };
}

beforeAll(async () => {
  delete process.env['DISPATCH_EXHAUSTION']; // production today: the general conversion switch is off
  w = await buildWalkWorld();
}, 120_000);

afterAll(async () => {
  await releaseWorld(w);
  await w.app.close();
  if (flagBefore === undefined) delete process.env['DISPATCH_EXHAUSTION'];
  else process.env['DISPATCH_EXHAUSTION'] = flagBefore;
  if (inviteBefore === undefined) delete process.env['STAFF_INVITE_ACCEPT'];
  else process.env['STAFF_INVITE_ACCEPT'] = inviteBefore;
});

async function noticesOf(orderId: string, userId: string) {
  return w.app.prisma.$queryRawUnsafe<Array<{ title: string; body: string }>>(
    `SELECT title, body FROM notifications WHERE data->>'orderId' = $1 AND "userId" = $2 ORDER BY "createdAt", id`,
    orderId, userId,
  );
}

/** A cash delivery the store accepted, whose first rider search came back empty (nobody online). */
async function acceptedWithNoRider(): Promise<{ cast: Cast; id: string }> {
  const cast = await castWalk(w, 0);
  const { orderId, body } = await placeCashOrder(w, cast);
  expect(orderId, body).toBeTruthy();
  const id = orderId!;
  expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
  await drainDue(w);
  expect(await w.app.prisma.dispatchSearch.count({ where: { subjectId: id, status: 'EXHAUSTED' } })).toBeGreaterThan(0);
  return { cast, id };
}

const customerOrder = async (cast: Cast, id: string) => (await call(w, 'GET', `/api/v1/customer/orders/${id}`, cast.customer.token)).json().data;
const storeOrder = async (cast: Cast, id: string) => (await call(w, 'GET', `/api/v1/vendor/orders/${id}`, cast.vendorOwner.token)).json().data;

describe('[PROD-RIDER-TEST (a)1] the store is asked at once: "No rider found. Deliver it yourselves?"', () => {
  it('the first empty search pushes the store, and its order card and board say so', async () => {
    const { cast, id } = await acceptedWithNoRider();
    // Only the first search has run (the slow lane's later sweeps are still scheduled): the store is asked now.
    const store = await noticesOf(id, cast.vendorOwner.userId);
    const asked = store.filter((n) => n.title === 'No rider found');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toContain('Deliver it yourselves?');
    const card = await storeOrder(cast, id);
    expect(card).toMatchObject({ noRiderFound: true, noRiderPrompt: 'No rider found. Deliver it yourselves?' });
    const board = (await call(w, 'GET', '/api/v1/vendor/orders', cast.vendorOwner.token)).json().data as Array<{ id: string; noRiderFound?: boolean }>;
    expect(board.find((o) => o.id === id)?.noRiderFound).toBe(true);
  }, 120_000);

  it('one tap delivers THIS order with the store\'s own rider, without the standing setting; the customer is told', async () => {
    const { cast, id } = await acceptedWithNoRider();
    expect((await w.app.prisma.vendor.findUniqueOrThrow({ where: { id: cast.vendorId } })).selfDeliveryEnabled).toBe(false);
    const tap = await call(w, 'PUT', `/api/v1/vendor/orders/${id}/fulfillment-mode`, cast.vendorOwner.token, { mode: 'VENDOR_DELIVERY' });
    expect(tap.statusCode, tap.body).toBe(200);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id }, include: { statusHistory: true } });
    expect(row.fulfillmentMode).toBe('VENDOR_DELIVERY');
    expect(row.statusHistory.some((l) => l.note === 'No rider found: the store chose to deliver this order itself')).toBe(true);
    // The standing setting is untouched: the next order still goes to Swift riders.
    expect((await w.app.prisma.vendor.findUniqueOrThrow({ where: { id: cast.vendorId } })).selfDeliveryEnabled).toBe(false);
    // The customer: a push in the own-rider notice's words, and the order screen says it too.
    const told = (await noticesOf(id, cast.customer.userId)).filter((n) => n.title === 'The store is delivering your order');
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain(OWN_RIDER_NOTICE);
    const screen = await customerOrder(cast, id);
    expect(screen.ownRiderNotice).toBe(OWN_RIDER_NOTICE);
    // The store has it now: no "no rider" prompt, no pickup offer, and the free cancel closes (the store accepted).
    expect((await storeOrder(cast, id)).noRiderFound).toBe(false);
    expect(screen.switchToPickup).toBeNull();
    expect(screen.canCancel).toBe(false);
    // No cash check for a Swift rider applies: the store's own rider carries it (no rider float was committed).
    expect(row.riderId).toBeNull();
    // End to end: the store finishes its own delivery (ready, then delivered), still without the standing setting.
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/ready`, cast.vendorOwner.token)).statusCode).toBe(200);
    const done = await call(w, 'PUT', `/api/v1/vendor/orders/${id}/delivered`, cast.vendorOwner.token, {});
    expect(done.statusCode, done.body).toBe(200);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('DELIVERED');
  }, 120_000);

  it('before any search came back empty, the setting still decides (no one-tap self-delivery)', async () => {
    const cast = await castWalk(w, 0);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    // Not accepted yet: no search ran.
    const tap = await call(w, 'PUT', `/api/v1/vendor/orders/${id}/fulfillment-mode`, cast.vendorOwner.token, { mode: 'VENDOR_DELIVERY' });
    expect(tap.statusCode, tap.body).toBe(400);
    expect(tap.json().error).toMatchObject({ code: 'SELF_DELIVERY_DISABLED' });
    expect((await storeOrder(cast, id)).noRiderFound).toBe(false);
  }, 120_000);

  it('"Find a rider" still searches again', async () => {
    const { cast, id } = await acceptedWithNoRider();
    const retry = await call(w, 'POST', `/api/v1/vendor/orders/${id}/retry-dispatch`, cast.vendorOwner.token, {});
    expect(retry.statusCode, retry.body).toBe(200);
  }, 120_000);
});

describe('[PROD-RIDER-TEST (a)2] the customer is offered "Switch to pickup" before the free cancel', () => {
  it('the order screen offers pickup with the fee off and what is left to pay; the free cancel stays', async () => {
    const { cast, id } = await acceptedWithNoRider();
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const fee = Number(order.deliveryFee);
    const tip = Number(order.tipAmount);
    const total = Number(order.totalAmount);
    const screen = await customerOrder(cast, id);
    expect(screen.switchToPickup).toMatchObject({ deliveryFeeRemoved: fee, tipRemoved: tip, newTotal: total - fee - tip });
    expect(screen.switchToPickup.message).toContain('No rider was found');
    expect(screen.switchToPickup.message).toContain('comes off');
    expect(screen.canCancel).toBe(true);

    const res = await call(w, 'POST', `/api/v1/customer/orders/${id}/convert-to-pickup`, cast.customer.token, {});
    expect(res.statusCode, res.body).toBe(200);
    const after = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ fulfillment: after.fulfillment, deliveryFee: Number(after.deliveryFee), totalAmount: Number(after.totalAmount) })
      .toEqual({ fulfillment: 'PICKUP', deliveryFee: 0, totalAmount: total - fee - tip });
    expect((await noticesOf(id, cast.vendorOwner.userId)).some((n) => n.title === 'Order switched to pickup')).toBe(true);
  }, 120_000);

  it('the store\'s tap and the customer\'s switch cannot both win: the store delivering ends the pickup offer', async () => {
    const { cast, id } = await acceptedWithNoRider();
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/fulfillment-mode`, cast.vendorOwner.token, { mode: 'VENDOR_DELIVERY' })).statusCode).toBe(200);
    const res = await call(w, 'POST', `/api/v1/customer/orders/${id}/convert-to-pickup`, cast.customer.token, {});
    expect(res.statusCode).not.toBe(200);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).fulfillment).toBe('DELIVERY');
  }, 120_000);

  it('an MMG order is never offered pickup (the conversion refuses it); the cancel rule is unchanged', async () => {
    const { cast, id } = await acceptedWithNoRider();
    await w.app.prisma.order.update({ where: { id }, data: { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' } });
    expect((await customerOrder(cast, id)).switchToPickup).toBeNull();
  }, 120_000);
});

describe('[PROD-RIDER-TEST (a)3] the store sees clearly when the customer cancels after no rider was found', () => {
  it('the free cancel goes through, and the store is pushed in plain words', async () => {
    const { cast, id } = await acceptedWithNoRider();
    const res = await call(w, 'POST', `/api/v1/customer/orders/${id}/cancel`, cast.customer.token, { reason: 'No rider' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
    const store = (await noticesOf(id, cast.vendorOwner.userId)).filter((n) => n.title === 'Customer cancelled the order');
    expect(store).toHaveLength(1);
    expect(store[0]!.body).toContain('after no rider was found');
  }, 120_000);
});

// [PROD-RIDER-TEST review round · COORD 11 Nov 2026]
describe('[review S3-1] "Switch to pickup" withdraws a rider card still ringing for the order', () => {
  it('the live offer pair goes at once and the rider is free for the next offer', async () => {
    const cast = await castWalk(w, 1);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
    await drainDue(w);
    expect(await w.app.prisma.dispatchSearch.count({ where: { subjectId: id, status: 'EXHAUSTED' } })).toBeGreaterThan(0);
    // A rider comes online and the store's "Find a rider" rings them: a live card.
    const r = cast.riders[0]!;
    expect((await call(w, 'POST', '/api/v1/rider/go-online', r.token, { latitude: r.lat, longitude: r.lng })).statusCode).toBe(200);
    expect((await call(w, 'POST', `/api/v1/vendor/orders/${id}/retry-dispatch`, cast.vendorOwner.token, {})).statusCode).toBe(200);
    expect(await w.app.redis.get(dispatchOfferKey(id))).toMatch(new RegExp(`^${r.riderId}`));
    // The customer, still offered the switch (no rider found stays true through a retry), takes it.
    const res = await call(w, 'POST', `/api/v1/customer/orders/${id}/convert-to-pickup`, cast.customer.token, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(await w.app.redis.get(dispatchOfferKey(id))).toBeNull();
    expect(await w.app.redis.get(dispatchMoverOfferKey(r.riderId))).toBeNull();
    await w.app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: false } });
  }, 120_000);
});

describe('[review S4-1 · COORD: any store role may tap] the status log records who took the delivery', () => {
  it('a STAFF member\'s "We\'ll deliver it" is accepted and logged with that person as the actor', async () => {
    const { cast, id } = await acceptedWithNoRider();
    const staff = await addStaff(cast);
    const tap = await call(w, 'PUT', `/api/v1/vendor/orders/${id}/fulfillment-mode`, staff.token, { mode: 'VENDOR_DELIVERY' });
    expect(tap.statusCode, tap.body).toBe(200);
    const row = await w.app.prisma.orderStatusLog.findFirstOrThrow({
      where: { orderId: id, note: 'No rider found: the store chose to deliver this order itself' },
    });
    expect(row.changedBy).toBe(staff.userId);
  }, 120_000);
});

describe('[review S4-2 · COORD] the store notices reach the team the new-order alert rings', () => {
  it('with staff invites on, the owner AND a staff member hear "No rider found" and "Customer cancelled the order"', async () => {
    process.env['STAFF_INVITE_ACCEPT'] = '1';
    try {
      const cast = await castWalk(w, 0);
      const staff = await addStaff(cast);
      const { orderId } = await placeCashOrder(w, cast);
      const id = orderId!;
      expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
      await drainDue(w);
      for (const userId of [cast.vendorOwner.userId, staff.userId]) {
        expect((await noticesOf(id, userId)).filter((n) => n.title === 'No rider found'), userId).toHaveLength(1);
      }
      expect((await call(w, 'POST', `/api/v1/customer/orders/${id}/cancel`, cast.customer.token, { reason: 'No rider' })).statusCode).toBe(200);
      for (const userId of [cast.vendorOwner.userId, staff.userId]) {
        expect((await noticesOf(id, userId)).filter((n) => n.title === 'Customer cancelled the order'), userId).toHaveLength(1);
      }
    } finally {
      if (inviteBefore === undefined) delete process.env['STAFF_INVITE_ACCEPT'];
      else process.env['STAFF_INVITE_ACCEPT'] = inviteBefore;
    }
  }, 120_000);

  it('with staff invites off (the new-order alert rings the owner alone), the owner alone hears them', async () => {
    delete process.env['STAFF_INVITE_ACCEPT'];
    try {
      const cast = await castWalk(w, 0);
      const staff = await addStaff(cast);
      const { orderId } = await placeCashOrder(w, cast);
      const id = orderId!;
      expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
      await drainDue(w);
      expect((await noticesOf(id, cast.vendorOwner.userId)).filter((n) => n.title === 'No rider found')).toHaveLength(1);
      expect((await noticesOf(id, staff.userId)).filter((n) => n.title === 'No rider found')).toHaveLength(0);
    } finally {
      if (inviteBefore === undefined) delete process.env['STAFF_INVITE_ACCEPT'];
      else process.env['STAFF_INVITE_ACCEPT'] = inviteBefore;
    }
  }, 120_000);
});
