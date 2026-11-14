import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { OrderService } from '../modules/order/order.service';
import { MockDragontail } from './helpers/mock-dragontail';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { claimForKitchen, kitchenDefersStoreAlert } from '../modules/kitchen/kitchen-claim';
import { drainKitchenSyncs, forgetKitchenTokens, kitchenBackstopSweep, KITCHEN_TICK_LOCK, type KitchenDeps } from '../modules/kitchen/kitchen-sync';
import { kitchenLoginRef, kitchenWebhookRef } from '../modules/kitchen/kitchen-credentials';
import * as kitchenAdmin from '../modules/kitchen/kitchen-admin';
import * as overflowModule from '../modules/kitchen/kitchen-overflow';
import type { DriverCheck } from '../modules/kitchen/kitchen-overflow';

const { putKitchenIntegration } = kitchenAdmin;
// [round 2] Read through the module, so this file still loads against the round-1 code (the red-first run).
type Refresh = (prisma: unknown, env: Record<string, string | undefined>, deps: { client?: { backoffMs: number } }) => Promise<number>;
const refreshDriverChecks = () => (overflowModule as unknown as { refreshKitchenDriverChecks?: Refresh }).refreshKitchenDriverChecks?.(app.prisma, process.env, { client: { backoffMs: 1 } });

// ---------------------------------------------------------------------------
// [DT-OVERFLOW · owner 14 Nov 2026] Automatic delivery overflow against a real database and a mock Dragontail.
// Order by order, BEFORE anything is sent, a connected own-driver branch's cash delivery goes to Dragontail OR to the
// Swift tablet and Swift riders, never both: busy hours, the driver check (PosGetVehicles) and its safe default
// (timeout / error / no endpoint → Dragontail, as today), Swift's own rider check, pickups untouched, one path under
// concurrent claims, the store's words, and "Get a Swift rider" refused on an order Dragontail has.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const mock = new MockDragontail();
const RUN = nanoid(6).toLowerCase();
const FIXTURE = 'kitchen-overflow-fixture';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const DAY = 86_400_000;
const STORE_NO = 100_000 + Math.floor(Math.random() * 800_000);
const VEHICLES = `/PosGetVehicles/${STORE_NO}`;
// A place of the suite's own, so no other suite's riders are "near".
const AT = { lat: 3.2 + Math.random() * 0.6, lng: -59.9 + Math.random() * 0.4 };

const userIds: string[] = [];
const vendorIds: string[] = [];
const riderIds: string[] = [];
let dispatchJobs: ReturnType<typeof recordDispatchQueue> = [];

type Actor = { userId: string; token: string; sessionId: string };
let owner: Actor;
let staff: Actor;
let customerId = '';
let vendorId = '';
let integrationId = '';
let itemId = '';
let unmappedItemId = '';
let riderId = '';
let opsAdminId = '';

const deps = (): KitchenDeps => ({ prisma: app.prisma, io: app.io, redis: app.redis, client: { backoffMs: 1 } });

function setEnv(on: boolean) {
  process.env['DRAGONTAIL_INTEGRATION'] = on ? '1' : '';
  process.env['DRAGONTAIL_API_URL'] = mock.url;
  process.env['DRAGONTAIL_CREDENTIALS'] = JSON.stringify({
    [kitchenLoginRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { userName: 'pos-overflow', password: 'pw-overflow' },
    [kitchenWebhookRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { webhookSecret: `whs-${nanoid(24)}` },
  });
  for (const key of ['DRAGONTAIL_ACCEPT_ON', 'DRAGONTAIL_DRIVER_CHECK_MS', 'DRAGONTAIL_TIMEOUT_MS', 'DISPATCH_AVAILABILITY']) delete process.env[key];
  // [round 2 · review A S2-3] The driver check has its own switch; these tests turn it on unless they say otherwise.
  process.env['DRAGONTAIL_DRIVER_CHECK'] = on ? '1' : '';
}

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Over', lastName: `F${RUN}`, roles, activeRole, status: 'ACTIVE', isPhoneVerified: true,
      selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `ko-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

async function makeOrder(opts: { fulfillment?: 'DELIVERY' | 'PICKUP'; mapped?: boolean } = {}) {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `KO-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'PENDING',
      fulfillment: opts.fulfillment ?? 'DELIVERY',
      deliveryAddress: '9 Test Street', deliveryLat: AT.lat + 0.004, deliveryLng: AT.lng + 0.004,
      pickupAddress: 'store', pickupLat: AT.lat, pickupLng: AT.lng,
      subtotalBase: 3500, subtotalMarkup: 0, subtotalCustomer: 3500, deliveryFee: 800, totalAmount: 4300,
      paymentMethod: 'CASH', holdExpiresAt: new Date(Date.now() - 1_000),
      items: {
        create: [{
          itemId: opts.mapped === false ? unmappedItemId : itemId, name: 'Pan Pizza XL', quantity: 1, basePrice: 3500, markedUpPrice: 3500,
          markupAmount: 0, totalBase: 3500, totalMarkup: 0, totalCustomer: 3500,
        }],
      },
      statusHistory: { create: { status: 'PENDING', changedBy: customerId, note: 'placed (test)' } },
    },
  }));
}

const syncOf = (orderId: string) => app.prisma.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } } });
const orderOf = (orderId: string) => app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
const ringsOf = (orderId: string) => app.prisma.notification.count({ where: { userId: owner.userId, title: { contains: 'New' }, data: { path: ['orderId'], equals: orderId } } });
const setOverflow = (mode: string, busyHours: unknown = []) => sys(() => app.prisma.vendorIntegration.update({
  where: { id: integrationId },
  data: { overflowMode: mode as never, overflowBusyHours: busyHours as never, driverCheckAt: null, driverCheckFree: null, driverCheckProblem: null },
}));
const riderOnline = (online: boolean) => sys(() => app.prisma.rider.update({ where: { id: riderId }, data: { isOnline: online, lastLocationUpdate: new Date() } }));
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
const NEVER_NOW = (() => {
  // A one-hour window twelve hours from now: never "now".
  const later = new Date(Date.now() + 12 * 60 * 60 * 1000 - 4 * 60 * 60 * 1000);
  const hh = String(later.getUTCHours()).padStart(2, '0');
  return [{ day: later.getUTCDay(), start: `${hh}:00`, end: `${String((later.getUTCHours() + 1) % 24).padStart(2, '0')}:00` }];
})();

async function releaseOnly() {
  await new OrderService(app.prisma, app.io).releaseDueHeldOrders(async () => {});
}

const call = (method: 'GET' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}), 'x-vendor-id': vendorId },
});

/** The order lives in exactly one place: routed to Swift riders with no kitchen claim, or to the kitchen with one. */
async function expectOnePlace(orderId: string) {
  const [order, sync] = await Promise.all([orderOf(orderId), syncOf(orderId)]);
  if (order.kitchenRoute === 'SWIFT_RIDERS') expect(sync, 'a Swift-rider order is never claimed for the kitchen').toBeNull();
  if (order.kitchenRoute === 'KITCHEN') expect(sync, 'a kitchen order has its claim').not.toBeNull();
  return { order, sync };
}

beforeAll(async () => {
  await mock.start();
  mock.users.set('pos-overflow', 'pw-overflow');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  dispatchJobs = recordDispatchQueue(app);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  customerId = (await makeUser(['CUSTOMER'], 'CUSTOMER')).userId;
  opsAdminId = (await makeUser(['ADMIN'], 'ADMIN')).userId;
  staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: `Overflow Diner ${wordFreeTag()}`, slug: `ko-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926990001',
        addressLine1: '1 Kitchen St', city: 'Lethem', region: 'Upper Takutu', latitude: AT.lat, longitude: AT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, selfDeliveryEnabled: true,
      },
    });
    vendorId = vendor.id;
    vendorIds.push(vendor.id);
    await app.prisma.vendorStaff.create({ data: { vendorId, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } });
    const category = await app.prisma.category.create({ data: { vendorId, name: 'Pizza' } });
    itemId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Pan Pizza XL', basePrice: 3500, externalItemNo: '8' } })).id;
    unmappedItemId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Pan Pizza XL', basePrice: 3500 } })).id;
  });
  // A Swift rider online near the branch, whose cash limit covers the orders' cash.
  const r = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  riderId = (await sys(() => app.prisma.rider.create({
    data: {
      userId: r.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 1_000_000, committedFloat: 0,
      isOnline: true, isAvailable: true, locationSessionId: r.sessionId, currentLat: AT.lat + 0.005, currentLng: AT.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
    },
  }))).id;
  riderIds.push(riderId);
  process.env['DRAGONTAIL_INTEGRATION'] = '1';
  const view = await putKitchenIntegration(app.prisma, vendorId, { enabled: true, externalStoreNo: STORE_NO });
  integrationId = view.connection!.id;
}, 120_000);

beforeEach(async () => {
  mock.reset();
  setEnv(true);
  forgetKitchenTokens();
  await app.redis.del(KITCHEN_TICK_LOCK);
  await setOverflow('NONE', []);
  await riderOnline(true);
});

afterEach(() => {
  dispatchJobs.length = 0;
});

afterAll(async () => {
  for (const key of ['DRAGONTAIL_INTEGRATION', 'DRAGONTAIL_API_URL', 'DRAGONTAIL_CREDENTIALS', 'DRAGONTAIL_DRIVER_CHECK', 'DRAGONTAIL_DRIVER_CHECK_MS', 'DRAGONTAIL_TIMEOUT_MS', 'DISPATCH_AVAILABILITY']) delete process.env[key];
  await sys(async () => {
    const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    if (ids.length) {
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: ids } } });
      await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: ids } } });
      await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
    if (riderIds.length) await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    if (vendorIds.length) {
      await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    }
    if (userIds.length) {
      await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });
  await app.close();
  await mock.stop();
});

describe('[DT-OVERFLOW] switch OFF: inert', () => {
  it('no route, no claim, no call; the store’s setting is not available and cannot be changed', async () => {
    await setOverflow('BOTH', ALL_WEEK);
    setEnv(false);
    mock.vehicles = [];
    const order = await makeOrder();
    await releaseOnly();
    const after = await orderOf(order.id);
    expect(after.kitchenRoute).toBeNull();
    expect(await syncOf(order.id)).toBeNull();
    expect(mock.requests).toHaveLength(0);
    expect(await ringsOf(order.id), 'the tablet rings as for any store').toBe(1);
    const read = await call('GET', '/api/v1/vendor/kitchen-overflow', owner.token);
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({ available: false, mode: 'NONE' });
    const write = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode: 'NONE' });
    expect(write.statusCode).toBe(409);
    expect(write.json().error.code).toBe('KITCHEN_SWITCH_OFF');
  });
});

describe('[DT-OVERFLOW] overflow off (NONE): Dragontail as before, recorded', () => {
  it('the delivery is claimed for the kitchen, the route says why, and no driver check is made', async () => {
    mock.vehicles = [];
    const order = await makeOrder();
    await releaseOnly();
    const { order: after, sync } = await expectOnePlace(order.id);
    expect(after).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'OVERFLOW_OFF' });
    expect(sync?.state).toBe('QUEUED');
    expect(mock.count(VEHICLES)).toBe(0);
    expect(await ringsOf(order.id), 'claimed: the tablet is not rung').toBe(0);
  });
});

describe('[DT-OVERFLOW] AUTO_DRIVER_CHECK', () => {
  beforeEach(async () => { await setOverflow('AUTO_DRIVER_CHECK'); });

  it('no free vehicle: the Swift path — the tablet rings, nothing is claimed or sent, and accept binds Swift riders', async () => {
    mock.vehicles = [];
    await refreshDriverChecks();
    const order = await makeOrder();
    await releaseOnly();
    const { order: after } = await expectOnePlace(order.id);
    expect(after).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'NO_FREE_DRIVER', fulfillmentMode: null });
    expect(mock.count(VEHICLES)).toBe(1);
    expect(mock.requests.find((r) => r.path === VEHICLES)?.headers['token'], 'the check is an authenticated GET').toBeTruthy();
    expect(mock.count('/PosInsertOrders')).toBe(0);
    expect(await ringsOf(order.id), 'rung on the tablet, as a store without the integration').toBe(1);
    expect(await kitchenDefersStoreAlert(app.prisma, order.id), 'the ladder never waits for a kitchen that does not have it').toBe(false);
    // A second claim (a replayed release, checkout's tail) answers from the route: still nothing claimed.
    expect(await claimForKitchen(app.prisma, order.id)).toBe(false);
    expect(await syncOf(order.id)).toBeNull();
    expect(mock.count(VEHICLES), 'decided once: no second check').toBe(1);
    // The sender has nothing to send for it.
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect(mock.count('/PosInsertOrders')).toBe(0);

    // The store sees where it went and why; its money is a Swift-rider delivery's.
    const detail = await call('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().data.kitchen).toMatchObject({ holdsOrder: false, route: 'SWIFT_RIDERS', title: 'Swift rider: your drivers were all busy' });
    expect(detail.json().data.storeMoney?.delivery).toBe('SWIFT_RIDER');

    // Accept: bound to Swift riders (not the store's own driver, though its setting is on), and dispatched.
    const accept = await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, owner.token, {});
    expect(accept.statusCode, accept.body).toBe(200);
    expect((await orderOf(order.id)).fulfillmentMode).toBe('PLATFORM_RIDER');
    expect(dispatchJobs.some((j) => j.name === 'dispatch-order' && j.data.orderId === order.id), 'offered to Swift riders').toBe(true);
    expect(await syncOf(order.id)).toBeNull();
  });

  it('a free vehicle (either spec shape): Dragontail as today', async () => {
    mock.vehicles = [{ id: '234', number: '234', status: 1 }];
    await refreshDriverChecks();
    const order = await makeOrder();
    await releaseOnly();
    const { order: after, sync } = await expectOnePlace(order.id);
    expect(after).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_FREE' });
    expect(sync?.state).toBe('QUEUED');
    expect(await ringsOf(order.id)).toBe(0);

    mock.reset();
    mock.vehicleKey = 'vehicle';
    mock.vehicles = [{ id: '345', number: '345', status: 1 }];
    await setOverflow('AUTO_DRIVER_CHECK');
    await refreshDriverChecks();
    const second = await makeOrder();
    await releaseOnly();
    expect(await orderOf(second.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_FREE' });
  });

  it('TIMEOUT: decided within the short budget, and the safe default is Dragontail as today (recorded) — never both', async () => {
    process.env['DRAGONTAIL_DRIVER_CHECK_MS'] = '400';
    mock.vehicles = [];
    mock.pathDelays.set(VEHICLES, 3_000);
    const checking = Date.now();
    await refreshDriverChecks();
    expect(Date.now() - checking, 'the tick’s check is bounded by its budget').toBeLessThan(1_500);
    const order = await makeOrder();
    const started = Date.now();
    expect(await claimForKitchen(app.prisma, order.id)).toBe(true);
    expect(Date.now() - started, 'the check never holds the order for long').toBeLessThan(1_500);
    const { order: after, sync } = await expectOnePlace(order.id);
    expect(after).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_CHECK_FAILED' });
    expect(sync?.state).toBe('QUEUED');
  });

  it('the endpoint missing (404: it is optional), or 5xx after the retries: Dragontail as today', async () => {
    mock.vehicles = null;
    await refreshDriverChecks();
    const missing = await makeOrder();
    await releaseOnly();
    expect(await orderOf(missing.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_CHECK_FAILED' });
    expect((await syncOf(missing.id))?.state).toBe('QUEUED');

    mock.reset();
    mock.vehicles = [];
    mock.failNext(VEHICLES, [500, 502, 503, 504]);
    await setOverflow('AUTO_DRIVER_CHECK');
    await refreshDriverChecks();
    const flaky = await makeOrder();
    expect(await claimForKitchen(app.prisma, flaky.id)).toBe(true);
    expect(await orderOf(flaky.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_CHECK_FAILED' });
  });

  it('no Swift rider near can carry it: kept with Dragontail rather than sent to nobody', async () => {
    await riderOnline(false);
    mock.vehicles = [];
    await refreshDriverChecks();
    const order = await makeOrder();
    await releaseOnly();
    const { order: after, sync } = await expectOnePlace(order.id);
    expect(after).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'NO_SWIFT_RIDER_NEAR' });
    expect(sync?.state).toBe('QUEUED');
    expect(await ringsOf(order.id)).toBe(0);
  });

  it('PICKUPS ARE NEVER DIVERTED: no route, no driver check, claimed as before', async () => {
    mock.vehicles = [];
    const order = await makeOrder({ fulfillment: 'PICKUP' });
    await releaseOnly();
    const after = await orderOf(order.id);
    expect(after.kitchenRoute).toBeNull();
    expect((await syncOf(order.id))?.state).toBe('QUEUED');
    expect(mock.count(VEHICLES)).toBe(0);
  });

  it('ONE PATH ONLY: concurrent claims of one order, disagreeing driver answers, end in exactly one place', async () => {
    for (let round = 0; round < 4; round += 1) {
      const order = await makeOrder();
      let n = 0;
      const answers = await Promise.all(Array.from({ length: 6 }, () => claimForKitchen(app.prisma, order.id, process.env, {
        driverCheck: async (): Promise<DriverCheck> => ((n++ + round) % 2 === 0 ? { kind: 'FREE', count: 1, ms: 1 } : { kind: 'NONE_FREE', ms: 1 }),
        swiftRiders: async () => ({ kind: 'NEAR', count: 1 }),
      })));
      const { order: after, sync } = await expectOnePlace(order.id);
      expect(after.kitchenRoute).not.toBeNull();
      // Every claimer gives the same answer, and it matches the one place the order is.
      expect(new Set(answers).size, `round ${round}: ${answers.join(',')}`).toBe(1);
      expect(answers[0]).toBe(after.kitchenRoute === 'KITCHEN');
      if (after.kitchenRoute === 'KITCHEN') expect(sync?.state).toBe('QUEUED');
    }
  });
});

describe('[DT-OVERFLOW] BUSY_HOURS and BOTH', () => {
  it('inside the busy hours: the Swift path, and Dragontail is not called at all', async () => {
    await setOverflow('BUSY_HOURS', ALL_WEEK);
    mock.vehicles = [{ id: '1', number: '1', status: 1 }];
    const order = await makeOrder();
    await releaseOnly();
    expect(await orderOf(order.id)).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'BUSY_HOURS' });
    expect(await syncOf(order.id)).toBeNull();
    expect(mock.requests, 'no login, no check, no insert').toHaveLength(0);
    expect(await ringsOf(order.id)).toBe(1);
  });

  it('outside the busy hours: Dragontail; with BOTH, the driver check then decides', async () => {
    await setOverflow('BUSY_HOURS', NEVER_NOW);
    mock.vehicles = [];
    const quiet = await makeOrder();
    await releaseOnly();
    expect(await orderOf(quiet.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'OUTSIDE_BUSY_HOURS' });
    expect(mock.count(VEHICLES)).toBe(0);

    await setOverflow('BOTH', NEVER_NOW);
    await refreshDriverChecks();
    const busyDrivers = await makeOrder();
    await releaseOnly();
    expect(await orderOf(busyDrivers.id)).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'NO_FREE_DRIVER' });
    expect(mock.count(VEHICLES)).toBe(1);
  });
});

describe('[DT-OVERFLOW] the "Get a Swift rider" gap', () => {
  it('refused on an own-delivery order Dragontail has (switch on or off), with clear words; allowed once it fell back', async () => {
    const order = await makeOrder();
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state).toBe('SENT');
    expect((await orderOf(order.id)).fulfillmentMode).toBe('VENDOR_DELIVERY');

    const detail = await call('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(detail.json().data.kitchen).toMatchObject({ holdsOrder: true, title: 'In Dragontail: your own driver delivers it' });

    for (const on of [true, false]) {
      setEnv(on);
      const res = await call('PUT', `/api/v1/vendor/orders/${order.id}/fulfillment-mode`, owner.token, { mode: 'PLATFORM_RIDER' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('KITCHEN_HAS_ORDER');
      expect(res.json().error.message).toContain('Dragontail');
      const after = await orderOf(order.id);
      expect(after.fulfillmentMode).toBe('VENDOR_DELIVERY');
      expect(after.riderId).toBeNull();
      expect(dispatchJobs.filter((j) => j.data.orderId === order.id), 'no Swift rider sought').toHaveLength(0);
    }

    // An order whose send fell back to the tablet is the store's on Swift: the choice is open again.
    setEnv(true);
    const fellBack = await makeOrder({ mapped: false });
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [fellBack.id] });
    expect((await syncOf(fellBack.id))?.state).toBe('FALLBACK');
    const accept = await call('PUT', `/api/v1/vendor/orders/${fellBack.id}/accept`, owner.token, {});
    expect(accept.statusCode, accept.body).toBe(200);
    expect((await orderOf(fellBack.id)).fulfillmentMode).toBe('VENDOR_DELIVERY');
    const swap = await call('PUT', `/api/v1/vendor/orders/${fellBack.id}/fulfillment-mode`, owner.token, { mode: 'PLATFORM_RIDER' });
    expect(swap.statusCode, swap.body).toBe(200);
    expect((await orderOf(fellBack.id)).fulfillmentMode).toBe('PLATFORM_RIDER');
  });
});

describe('[DT-OVERFLOW] the store’s setting', () => {
  it('the owner (or a manager) reads and sets it; plain staff cannot; bad windows are refused', async () => {
    const read = await call('GET', '/api/v1/vendor/kitchen-overflow', owner.token);
    expect(read.json().data).toMatchObject({ available: true, mode: 'NONE', busyHours: [] });
    const set = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode: 'BOTH', busyHours: [{ day: 5, start: '18:00', end: '02:00' }] });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().data).toMatchObject({ available: true, mode: 'BOTH', busyHours: [{ day: 5, start: '18:00', end: '02:00' }] });
    expect((await app.prisma.vendorIntegration.findUniqueOrThrow({ where: { id: integrationId } })).overflowMode).toBe('BOTH');
    const bad = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode: 'BUSY_HOURS', busyHours: [{ day: 1, start: '18:00', end: '18:00' }] });
    expect(bad.statusCode).toBe(400);
    const empty = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode: 'BUSY_HOURS', busyHours: [] });
    expect(empty.statusCode).toBe(400);
    const byStaff = await call('PUT', '/api/v1/vendor/kitchen-overflow', staff.token, { mode: 'NONE' });
    expect(byStaff.statusCode).toBe(403);
    expect((await app.prisma.vendorIntegration.findUniqueOrThrow({ where: { id: integrationId } })).overflowMode).toBe('BOTH');
  });
});

// ── ROUND 2 (review A) ──────────────────────────────────────────────────────

describe('[round 2 · S2-2] the driver check never runs in the hold-release sweep or checkout', () => {
  it('the sweep only READS the tick’s answer: no Dragontail call while releasing, however slow Dragontail is', async () => {
    await setOverflow('AUTO_DRIVER_CHECK');
    mock.vehicles = [];
    await refreshDriverChecks();
    const before = mock.requests.length;
    mock.pathDelays.set(VEHICLES, 3_000);
    const orders = [await makeOrder(), await makeOrder(), await makeOrder()];
    const started = Date.now();
    await releaseOnly();
    expect(mock.requests.length - before, 'the release made no call to Dragontail').toBe(0);
    expect(Date.now() - started, 'three overflow deliveries released without waiting on Dragontail').toBeLessThan(2_000);
    for (const o of orders) expect(await orderOf(o.id)).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'NO_FREE_DRIVER' });
  });

  it('no fresh answer (none yet, or older than 45 s): the kitchen, the safe default, with no call', async () => {
    await setOverflow('AUTO_DRIVER_CHECK');
    mock.vehicles = [];
    const none = await makeOrder();
    await releaseOnly();
    expect(await orderOf(none.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_CHECK_FAILED' });
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { driverCheckAt: new Date(Date.now() - 50_000), driverCheckFree: 0 } }));
    const stale = await makeOrder();
    await releaseOnly();
    expect(await orderOf(stale.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_CHECK_FAILED' });
    expect(mock.count(VEHICLES)).toBe(0);
  });

  it('a failed check is not asked again for a minute; an answered one every 20 s', async () => {
    await setOverflow('AUTO_DRIVER_CHECK');
    mock.vehicles = null; // 404: failed
    await refreshDriverChecks();
    expect(mock.count(VEHICLES)).toBe(1);
    const failed = await app.prisma.vendorIntegration.findUniqueOrThrow({ where: { id: integrationId } });
    expect(failed.driverCheckFree).toBeNull();
    expect(failed.driverCheckProblem).toContain('404');
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { driverCheckAt: new Date(Date.now() - 30_000) } }));
    await refreshDriverChecks();
    expect(mock.count(VEHICLES), '30 s after a failure: not asked').toBe(1);
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { driverCheckAt: new Date(Date.now() - 61_000) } }));
    mock.vehicles = [];
    await refreshDriverChecks();
    expect(mock.count(VEHICLES), 'a minute after a failure: asked again').toBe(2);
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { driverCheckAt: new Date(Date.now() - 21_000) } }));
    await refreshDriverChecks();
    expect(mock.count(VEHICLES), '20 s after an answer: asked again').toBe(3);
  });
});

describe('[round 2 · S2-3] the driver check stays OFF until Dragontail confirms it (its own switch)', () => {
  it('AUTO_DRIVER_CHECK = off, BOTH = busy hours only, no call; the two choices cannot be set; busy hours can', async () => {
    process.env['DRAGONTAIL_DRIVER_CHECK'] = '';
    mock.vehicles = [];
    await setOverflow('AUTO_DRIVER_CHECK');
    await refreshDriverChecks();
    const auto = await makeOrder();
    await releaseOnly();
    expect(await orderOf(auto.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'DRIVER_CHECK_OFF' });

    await setOverflow('BOTH', NEVER_NOW);
    await refreshDriverChecks();
    const outside = await makeOrder();
    await releaseOnly();
    expect(await orderOf(outside.id)).toMatchObject({ kitchenRoute: 'KITCHEN', kitchenRouteReason: 'OUTSIDE_BUSY_HOURS' });
    await setOverflow('BOTH', ALL_WEEK);
    const inside = await makeOrder();
    await releaseOnly();
    expect(await orderOf(inside.id)).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'BUSY_HOURS' });
    expect(mock.count(VEHICLES), 'never asked').toBe(0);

    const read = await call('GET', '/api/v1/vendor/kitchen-overflow', owner.token);
    expect(read.json().data).toMatchObject({ available: true, driverCheckAvailable: false });
    for (const mode of ['AUTO_DRIVER_CHECK', 'BOTH']) {
      const res = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode, busyHours: [{ day: 5, start: '18:00', end: '21:00' }] });
      expect(res.statusCode, `${mode}: ${res.body}`).toBe(409);
      expect(res.json().error.code).toBe('DRIVER_CHECK_OFF');
    }
    const hours = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode: 'BUSY_HOURS', busyHours: [{ day: 5, start: '18:00', end: '21:00' }] });
    expect(hours.statusCode, hours.body).toBe(200);
  });
});

describe('[round 2 · S3-3] "Get a Swift rider" stays refused while Dragontail MAY still have the order', () => {
  it('the switch went off mid-send: rung on the tablet, but no Swift rider may be added (and the store is told why)', async () => {
    const order = await makeOrder();
    await releaseOnly();
    expect((await syncOf(order.id))?.state).toBe('QUEUED');
    // The send got no answer (it may be in the kitchen), then the switch was turned off.
    await sys(() => app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { state: 'UNKNOWN', lastError: 'timed out' } }));
    setEnv(false);
    await kitchenBackstopSweep({ prisma: app.prisma, io: app.io });
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(await ringsOf(order.id), 'rung on the tablet').toBe(1);
    const accept = await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, owner.token, {});
    expect(accept.statusCode, accept.body).toBe(200);
    expect((await orderOf(order.id)).fulfillmentMode).toBe('VENDOR_DELIVERY');
    const swap = await call('PUT', `/api/v1/vendor/orders/${order.id}/fulfillment-mode`, owner.token, { mode: 'PLATFORM_RIDER' });
    expect(swap.statusCode, swap.body).toBe(409);
    expect(swap.json().error.code).toBe('KITCHEN_HAS_ORDER');
    expect((await orderOf(order.id)).fulfillmentMode).toBe('VENDOR_DELIVERY');
    const detail = await call('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(detail.json().data.kitchen).toMatchObject({ holdsOrder: true, title: 'On this tablet, and maybe in Dragontail' });

    // [round 3 · review B S4-8] Operations confirm with the store that Dragontail does not have it: the hold clears.
    const clear = (kitchenAdmin as unknown as { clearMaybeInKitchen?: (p: unknown, v: string, o: string, a?: unknown) => Promise<unknown> }).clearMaybeInKitchen;
    const audited: unknown[] = [];
    await clear?.(app.prisma, vendorId, order.id, async (_tx: unknown, _id: string, facts: unknown) => { audited.push(facts); });
    expect(audited, 'audited').toHaveLength(1);
    expect((await syncOf(order.id))?.maybeInKitchen).toBe(false);
    const again = await call('PUT', `/api/v1/vendor/orders/${order.id}/fulfillment-mode`, owner.token, { mode: 'PLATFORM_RIDER' });
    expect(again.statusCode, again.body).toBe(200);
  });
});

describe('[round 2 · S3-4] an overflow order kept with the store’s driver for its cash: operations are told', () => {
  it('routed to Swift riders, then no Swift rider may carry its cash at accept: own driver, and one note to operations', async () => {
    await setOverflow('BUSY_HOURS', ALL_WEEK);
    const order = await makeOrder();
    await releaseOnly();
    expect(await orderOf(order.id)).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'BUSY_HOURS' });
    // The only rider near now has too small a cash limit for this order.
    await sys(() => app.prisma.rider.update({ where: { id: riderId }, data: { floatLimit: 100 } }));
    process.env['DISPATCH_AVAILABILITY'] = '1';
    try {
      const accept = await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, owner.token, {});
      expect(accept.statusCode, accept.body).toBe(200);
    } finally {
      delete process.env['DISPATCH_AVAILABILITY'];
      await sys(() => app.prisma.rider.update({ where: { id: riderId }, data: { floatLimit: 1_000_000 } }));
    }
    expect((await orderOf(order.id)).fulfillmentMode).toBe('VENDOR_DELIVERY');
    const notes = await app.prisma.notification.findMany({ where: { userId: opsAdminId, data: { path: ['orderId'], equals: order.id } }, select: { title: true, body: true } });
    expect(notes, JSON.stringify(notes)).toHaveLength(1);
    expect(notes[0]!.title).toContain('own driver');
    expect(notes[0]!.body).toContain('NOT in Dragontail');
  });
});

describe('[round 2 · S4-1] the console’s change of the overflow is audited', () => {
  it('the audit callback runs inside the write, with the mode before and after (no person data)', async () => {
    const facts: Array<Record<string, unknown>> = [];
    const put = kitchenAdmin.putKitchenOverflow as unknown as (p: unknown, v: string, b: unknown, a?: (tx: unknown, id: string, f: Record<string, unknown>) => Promise<void>) => Promise<unknown>;
    await put(app.prisma, vendorId, { mode: 'BUSY_HOURS', busyHours: [{ day: 1, start: '11:00', end: '14:00' }] }, async (tx, id, f) => {
      expect(typeof (tx as { auditLog?: unknown }).auditLog, 'a transaction client').toBe('object');
      expect(id).toBe(integrationId);
      facts.push(f);
    });
    expect(facts).toEqual([{ modeBefore: 'NONE', modeAfter: 'BUSY_HOURS', busyWindowsBefore: 0, busyWindowsAfter: 1 }]);
    const [{ readFileSync }, { resolve }] = await Promise.all([import('node:fs'), import('node:path')]);
    const routes = readFileSync(resolve(__dirname, '../modules/admin/admin.routes.ts'), 'utf8');
    const handler = routes.slice(routes.indexOf("app.put('/vendors/:id/kitchen-integration/overflow'"), routes.indexOf("app.get('/vendors/:id/kitchen-integration/routes'"));
    expect(handler, 'the console route passes auditWithin').toMatch(/auditWithin\(/);
  });
});

// ── ROUND 3 (review B) ──────────────────────────────────────────────────────

describe('[round 3 · S3-2] the kitchen link offline: busy-hours overflow still applies, and the store sees the truth', () => {
  const offline = () => sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkOfflineAt: new Date(), linkProbeAt: new Date() } }));
  const online = () => sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkOfflineAt: null, linkProbeAt: null, linkOutageSince: null } }));

  it('busy hours or not, a Swift rider near takes it (nothing asked of Dragontail); none near: the tablet with the own driver, said so', async () => {
    await offline();
    try {
      await setOverflow('BUSY_HOURS', ALL_WEEK);
      const busy = await makeOrder();
      await releaseOnly();
      expect(await orderOf(busy.id)).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'BUSY_HOURS' });
      expect(await syncOf(busy.id)).toBeNull();
      expect(await ringsOf(busy.id)).toBe(1);
      const accept = await call('PUT', `/api/v1/vendor/orders/${busy.id}/accept`, owner.token, {});
      expect(accept.statusCode, accept.body).toBe(200);
      expect((await orderOf(busy.id)).fulfillmentMode, 'bound to Swift riders, as the branch asked').toBe('PLATFORM_RIDER');

      // [COORD ruling 14 Nov · PDF v1.1 "Dragontail down → a Swift rider delivers it"] Any time, a Swift rider near
      // who can carry the cash takes an outage delivery.
      await setOverflow('NONE');
      const outage = await makeOrder();
      await releaseOnly();
      expect(await orderOf(outage.id)).toMatchObject({ kitchenRoute: 'SWIFT_RIDERS', kitchenRouteReason: 'LINK_OFFLINE_SWIFT_RIDERS' });
      const outageView = await call('GET', `/api/v1/vendor/orders/${outage.id}`, owner.token);
      expect(outageView.json().data.kitchen).toMatchObject({ holdsOrder: false, title: 'Swift rider: Dragontail was not reachable' });
      const takeIt = await call('PUT', `/api/v1/vendor/orders/${outage.id}/accept`, owner.token, {});
      expect(takeIt.statusCode, takeIt.body).toBe(200);
      expect((await orderOf(outage.id)).fulfillmentMode).toBe('PLATFORM_RIDER');

      // No Swift rider near: the tablet with the branch's own driver, said so.
      await riderOnline(false);
      const plain = await makeOrder();
      await releaseOnly();
      expect(await orderOf(plain.id)).toMatchObject({ kitchenRoute: 'TABLET', kitchenRouteReason: 'LINK_OFFLINE' });
      const detail = await call('GET', `/api/v1/vendor/orders/${plain.id}`, owner.token);
      expect(detail.json().data.kitchen).toMatchObject({ holdsOrder: false, title: 'On this tablet only, not in Dragontail' });
      const accepted = await call('PUT', `/api/v1/vendor/orders/${plain.id}/accept`, owner.token, {});
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await orderOf(plain.id)).fulfillmentMode).toBe('VENDOR_DELIVERY');
      expect(mock.requests, 'nothing sent to an offline link').toHaveLength(0);
    } finally {
      await online();
    }
    // Back online: an order routed to the tablet while offline is never claimed afterwards.
    const later = await makeOrder();
    await offline();
    await releaseOnly();
    await online();
    expect(await claimForKitchen(app.prisma, later.id)).toBe(false);
    expect(await syncOf(later.id)).toBeNull();
  });
});

describe('[round 3 · S3-3] the store’s words follow what Swift knows', () => {
  it('queued: "Being sent to Dragontail"; no answer: "Maybe in Dragontail"; accepted by Dragontail: "In Dragontail"', async () => {
    const order = await makeOrder();
    await releaseOnly();
    expect((await syncOf(order.id))?.state).toBe('QUEUED');
    const queued = await call('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(queued.json().data.kitchen).toMatchObject({ holdsOrder: true, title: 'Being sent to Dragontail' });
    await sys(() => app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { state: 'UNKNOWN' } }));
    const unknown = await call('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(unknown.json().data.kitchen).toMatchObject({ holdsOrder: true, title: 'Maybe in Dragontail: check Dragontail' });
    expect(unknown.json().data.kitchen.detail).not.toContain('Sent to Dragontail');
  });
});

describe('[round 3 · S4] the store’s own change is audited; busy hours need a window', () => {
  it('the owner’s change writes an audit row with who and what; busy hours with no window at all are refused', async () => {
    const before = await app.prisma.auditLog.count({ where: { entityId: integrationId, action: 'VENDOR_KITCHEN_OVERFLOW_CHANGED' } });
    const set = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode: 'BUSY_HOURS', busyHours: [{ day: 3, start: '12:00', end: '14:00' }] });
    expect(set.statusCode, set.body).toBe(200);
    const rows = await app.prisma.auditLog.findMany({ where: { entityId: integrationId, action: 'VENDOR_KITCHEN_OVERFLOW_CHANGED' }, orderBy: { createdAt: 'desc' } });
    expect(rows.length - before).toBe(1);
    expect(rows[0]).toMatchObject({ userId: owner.userId, entity: 'VendorIntegration' });
    expect(rows[0]!.changes).toMatchObject({ vendorId, role: 'OWNER', modeAfter: 'BUSY_HOURS', busyWindowsAfter: 1 });

    await setOverflow('NONE', []);
    const none = await call('PUT', '/api/v1/vendor/kitchen-overflow', owner.token, { mode: 'BUSY_HOURS' });
    expect(none.statusCode, none.body).toBe(400);
    expect(none.json().error.code).toBe('BUSY_HOURS_EMPTY');
  });
});

// ── FOLLOW-UP (confirm review round 3) ──────────────────────────────────────

describe('[follow-up · N-7] an order that ended before it was ever sent is never "In Dragontail"', () => {
  it('DONE with no send: "Not sent to Dragontail", and "Get a Swift rider" is not held by Dragontail', async () => {
    const order = await makeOrder();
    await releaseOnly();
    await sys(() => app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { state: 'DONE', sentAt: null } }));
    const detail = await call('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(detail.json().data.kitchen).toMatchObject({ holdsOrder: false, title: 'Not sent to Dragontail' });
    await sys(() => app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { sentAt: new Date() } }));
    const sent = await call('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(sent.json().data.kitchen).toMatchObject({ holdsOrder: true, title: 'In Dragontail: your own driver delivers it' });
  });
});

describe('[follow-up · review B S4-9] every store role sees the offline kitchen link on its order screen', () => {
  it('delivery-status carries kitchenLink for plain staff; null with the switch off', async () => {
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkOfflineAt: new Date(), linkProbeAt: new Date() } }));
    try {
      const res = await call('GET', '/api/v1/vendor/vendor/delivery-status', staff.token);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.kitchenLink).toMatchObject({ offline: true });
      setEnv(false);
      const off = await call('GET', '/api/v1/vendor/vendor/delivery-status', staff.token);
      expect(off.json().data.kitchenLink ?? null).toBeNull();
    } finally {
      setEnv(true);
      await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkOfflineAt: null, linkProbeAt: null } }));
    }
  });
});

describe('[follow-up · N-1/N-5 · COORD ruling 14 Nov] the console’s kitchen actions need a stated reason', () => {
  it('"Dragontail does not have it", "Try the link now" and the overflow change (PDF v1.1 §6) refuse a request with no reason', async () => {
    const [{ readFileSync }, { resolve }] = await Promise.all([import('node:fs'), import('node:path')]);
    const routes = readFileSync(resolve(__dirname, '../modules/admin/admin.routes.ts'), 'utf8');
    for (const [method, route] of [['post', "'/vendors/:id/kitchen-integration/orders/:orderId/not-in-kitchen'"], ['post', "'/vendors/:id/kitchen-integration/link/try'"], ['put', "'/vendors/:id/kitchen-integration/overflow'"]] as const) {
      const at = routes.indexOf(`app.${method}(${route}`);
      expect(at, route).toBeGreaterThan(0);
      const handler = routes.slice(at, routes.indexOf('\n  app.', at + 10));
      expect(handler, route).toMatch(/reasonProblem\('C3'/);
      expect(handler, route).toMatch(/auditWithin\(/);
    }
  });
});

