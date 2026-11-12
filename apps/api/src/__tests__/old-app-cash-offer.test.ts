import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { makeDispatchService, rememberCashUnshown, type DispatchService } from '../modules/dispatch/dispatch.service';
import { APP_UPDATE_STEPS, assertCashShown } from '../modules/dispatch/cash-limit';
import { dispatchCashUnshownKey } from '../modules/dispatch/dispatch-generation-keys';
import { recordDispatchQueue } from './helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// [PROD-RIDER-TEST 11 Nov 2026 · COORD ruling (b) under the owner's "just fix these issues"]
// A rider on an app older than the cash card (#2385) was offered a GY$10,400 cash job four times in two minutes, and
// every accept was refused CASH_AMOUNT_NOT_SHOWN: the search exhausted, which wiped its decline memory, and the next
// sweep offered the same rider again.
//  1. The refusal tells the rider, in plain words, to close and reopen Swift to get the update, then try again, and
//     keeps the amount. A job whose split cannot be shown (a discount) never says "update": no app shows it.
//  2. The refused offer is released at once and the next rider is offered; the refused rider is not offered this job
//     again, even after an exhausted search, until the store asks for a fresh search (or the skip runs out). Their
//     acceptance rate is untouched.
// ---------------------------------------------------------------------------

const LIMIT = 100_000;
const SPOT = { lat: 7.37, lng: -59.9 }; // Port Kaituma, far from every other suite
const DAY = 24 * 60 * 60 * 1000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'old-app-cash-offer-fixture');
type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };
const refusalOf = (fn: () => void): Refusal | null => {
  try { fn(); return null; } catch (e) { return e as Refusal; }
};

describe('[PROD-RIDER-TEST (b)1] the words of an old app\'s refusal', () => {
  it('a job Swift could show: close and reopen Swift for the update, then try again; the amount stays', () => {
    const err = refusalOf(() => assertCashShown(10_400, undefined, 'Westside Grill', true));
    expect(err?.code).toBe('CASH_AMOUNT_NOT_SHOWN');
    expect(err?.message).toContain('GY$10,400');
    expect(err?.message).toContain('Westside Grill');
    expect(err?.message).toContain('Close Swift completely and open it again to get the update, then try again.');
    expect(err?.details).toMatchObject({ payToVendor: 10_400, appUpdateNeeded: true });
  });

  it('a job no app can show (no stated split): never "update"', () => {
    const err = refusalOf(() => assertCashShown(10_400, undefined, 'Westside Grill', false));
    expect(err?.code).toBe('CASH_AMOUNT_NOT_SHOWN');
    expect(err?.message).toContain('GY$10,400');
    expect(err?.message).not.toContain('update');
  });
});

describe('[review S4-3] the skip and its expiry are written in one atomic call', () => {
  it('one EVAL (SADD + EXPIRE together), never a bare SADD whose EXPIRE could fail apart', async () => {
    const redis = { eval: vi.fn(async () => 1), sadd: vi.fn(async () => 1), expire: vi.fn(async () => 1) };
    await rememberCashUnshown(redis as never, 'order-1', 2, 'rider-1');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.sadd).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();
    const [script, numKeys, key, member, ttl] = redis.eval.mock.calls[0] as unknown as [string, number, string, string, string];
    expect(script).toContain("redis.call('SADD', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ARGV[2])");
    expect([numKeys, key, member, ttl]).toEqual([1, dispatchCashUnshownKey('order-1', 2), 'rider-1', '600']);
  });
});

describe('[PROD-RIDER-TEST (b)] an older app and a cash job over GY$8,000', () => {
  let app: FastifyInstance;
  let dispatch: DispatchService;
  let vendorId = '';
  let itemId = '';
  let customerId = '';
  let seq = 0;
  const phoneBase = 592_620_000_000 + Math.floor(Math.random() * 800_000_000);
  const userIds: string[] = [];
  const riderIds: string[] = [];
  const orderIds: string[] = [];
  const envBefore = process.env['NODE_ENV'];

  async function makeUser(roles: UserRole[], activeRole: UserRole) {
    seq += 1;
    const user = await sys(() => app.prisma.user.create({
      data: {
        phone: `+${phoneBase + seq}`, firstName: 'Old', lastName: `App${seq}`, roles, activeRole, countryCode: 'GY',
        isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L1',
        ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
      },
    }));
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    const session = await sys(() => app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `oldapp-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    }));
    return { userId: user.id, token, sessionId: session.id };
  }

  async function makeRider(meters: number) {
    const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
    const rider = await sys(() => app.prisma.rider.create({
      data: {
        userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: LIMIT,
        isOnline: true, isAvailable: true, locationSessionId: u.sessionId,
        currentLat: SPOT.lat + meters / 111_000, currentLng: SPOT.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
      },
    }));
    riderIds.push(rider.id);
    return { ...u, riderId: rider.id };
  }

  /** The production order's shape: cash food 10,400 + delivery 1,800 = 12,200 (it reconciles, so a card shows it). */
  async function makeCashOrder(goods = 10_400, discount = 0) {
    const order = await sys(() => app.prisma.order.create({
      data: {
        orderNumber: `OLDAPP-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', fulfillmentMode: 'PLATFORM_RIDER',
        customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
        pickupAddress: 'Kaituma Grill', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
        deliveryAddress: 'Kaituma homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
        subtotalBase: goods, subtotalMarkup: 0, subtotalCustomer: goods, deliveryFee: 1_800, discount, totalAmount: goods + 1_800 - discount,
        paymentMethod: 'CASH',
        items: { create: [{ itemId, name: 'Family meal', quantity: 1, basePrice: goods, markedUpPrice: goods, markupAmount: 0, totalBase: goods, totalMarkup: 0, totalCustomer: goods }] },
      },
    }));
    orderIds.push(order.id);
    return order;
  }

  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
    method, url, ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
  const currentOffer = async (token: string) => (await call('GET', '/api/v1/rider/offers/current', token)).json().data.offer as
    { orderId: string; offerAttemptId?: string } | null;
  /** The accept an older app sends: the card's attempt id, and no amount (its card had no cash line). */
  const oldAppAccept = async (token: string, orderId: string) => {
    const card = await currentOffer(token);
    return call('POST', '/api/v1/rider/offers/accept', token, { orderId, ...(card?.offerAttemptId ? { offerAttemptId: card.offerAttemptId } : {}) });
  };
  const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id } }));

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'development';
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    recordDispatchQueue(app);
    await app.register(riderRoutes, { prefix: '/api/v1/rider' });
    await app.ready();
    dispatch = makeDispatchService(app);

    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    customerId = customer.userId;
    [vendorId, itemId] = await sys(async () => {
      const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
      const vendor = await app.prisma.vendor.create({
        data: {
          ownerId: vo.id, name: 'Kaituma Grill', slug: `kaituma-grill-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926998811',
          addressLine1: '1 Kaituma Road', city: 'Port Kaituma', region: 'Barima-Waini', latitude: SPOT.lat, longitude: SPOT.lng,
          status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
        },
      });
      const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
      const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Family meal', basePrice: 1000, isAvailable: true } });
      return [vendor.id, item.id] as const;
    });
  }, 120_000);

  afterEach(async () => {
    await sys(() => app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { isOnline: false, isAvailable: false, locationSessionId: null, currentOrderId: null } }));
  });

  afterAll(async () => {
    await sys(async () => {
      await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { currentOrderId: null } });
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
      await app.prisma.item.deleteMany({ where: { vendorId } });
      await app.prisma.category.deleteMany({ where: { vendorId } });
      await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
      await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await app.close();
    if (envBefore === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = envBefore;
  }, 120_000);

  it('(b)1 the offer refusal tells an older app to close and reopen Swift for the update, with the amount', async () => {
    const old = await makeRider(30);
    const job = await makeCashOrder();
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(old.riderId);
    const res = await oldAppAccept(old.token, job.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CASH_AMOUNT_NOT_SHOWN' });
    expect(res.json().error.message).toContain('GY$10,400');
    expect(res.json().error.message).toContain(APP_UPDATE_STEPS);
  });

  it('(b)2 the refused offer goes at once to the next rider, and the older app is not offered it again', async () => {
    const old = await makeRider(20);
    const next = await makeRider(400);
    const job = await makeCashOrder();
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(old.riderId);
    expect((await oldAppAccept(old.token, job.id)).statusCode).toBe(409);
    expect((await currentOffer(old.token))?.orderId ?? null).toBeNull();
    expect((await currentOffer(next.token))?.orderId).toBe(job.id);
  });

  it('(b)2 an exhausted search does not re-offer the job to the older app; the store\'s "Find a rider" asks it again', async () => {
    const old = await makeRider(25);
    const before = Number((await riderRow(old.riderId)).acceptanceRate);
    const job = await makeCashOrder();
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(old.riderId);
    expect((await oldAppAccept(old.token, job.id)).statusCode).toBe(409);
    // Nobody else is near: the search exhausts. Its next sweep (the slow lane's re-dispatch) must not burn itself on
    // the same app — before this fix the exhaustion wiped the decline memory and the same rider was offered again.
    const sweep = await dispatch.dispatchOrder(job.id);
    expect(sweep.offered).not.toBe(old.riderId);
    expect((await currentOffer(old.token))?.orderId ?? null).toBeNull();
    const searches = await sys(() => app.prisma.dispatchSearch.findMany({ where: { subjectId: job.id }, select: { status: true } }));
    expect(searches.some((s) => s.status === 'EXHAUSTED')).toBe(true);
    // A refused claim is not a decline the rider made: their acceptance rate is untouched.
    expect(Number((await riderRow(old.riderId)).acceptanceRate)).toBe(before);
    // A rider who comes online is offered it.
    const fresh = await makeRider(500);
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(fresh.riderId);
    const card = await currentOffer(fresh.token);
    expect((await call('POST', '/api/v1/rider/offers/decline', fresh.token, { orderId: job.id, offerAttemptId: card?.offerAttemptId })).statusCode).toBe(200);
    await sys(() => app.prisma.rider.update({ where: { id: fresh.riderId }, data: { isOnline: false, isAvailable: false, locationSessionId: null } }));
    // The store's "Find a rider" is a fresh search: a rider who has updated is asked again.
    const retried = await dispatch.retryDispatch(job.id);
    expect(retried.offered).toBe(old.riderId);
  });

  it('(b)2 a board grab refused for the same reason also stops the offers, and says to update', async () => {
    const old = await makeRider(35);
    const job = await makeCashOrder();
    const blind = await call('POST', `/api/v1/rider/orders/${job.id}/accept`, old.token, {});
    expect(blind.statusCode, blind.body).toBe(409);
    expect(blind.json().error).toMatchObject({ code: 'CASH_AMOUNT_NOT_SHOWN' });
    expect(blind.json().error.message).toContain(APP_UPDATE_STEPS);
    expect(await app.redis.sismember(dispatchCashUnshownKey(job.id, job.fulfillmentModeVersion), old.riderId)).toBe(1);
    // [review S4-3] The skip always carries its expiry.
    const ttl = await app.redis.ttl(dispatchCashUnshownKey(job.id, job.fulfillmentModeVersion));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
    expect((await dispatch.dispatchOrder(job.id)).offered).not.toBe(old.riderId);
  });

  it('(b)1 a discounted job (no cash split any app can show) is refused without "update"', async () => {
    const old = await makeRider(28);
    const job = await makeCashOrder(10_400, 1_000);
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(old.riderId);
    const res = await oldAppAccept(old.token, job.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CASH_AMOUNT_NOT_SHOWN' });
    expect(res.json().error.message).not.toContain('update');
  });
});
