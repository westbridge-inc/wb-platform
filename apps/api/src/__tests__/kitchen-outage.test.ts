import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { claimForKitchen } from '../modules/kitchen/kitchen-claim';
import { drainKitchenSyncs, forgetKitchenTokens, probeOfflineKitchenLinks, type KitchenDeps } from '../modules/kitchen/kitchen-sync';
import { kitchenLoginRef, kitchenWebhookRef } from '../modules/kitchen/kitchen-credentials';
import { putKitchenIntegration } from '../modules/kitchen/kitchen-admin';

// ---------------------------------------------------------------------------
// [DT-OUTAGE · owner 14 Nov 2026] A Dragontail outage against a real database, a mock Dragontail and a REAL refused
// connection (a closed local port). A send that certainly never arrived rings the tablet at once with no page per
// order (never "may have arrived"); a reset after the request left keeps the careful path (UNKNOWN, not rung). Three
// certain failures within the window mark the branch's link OFFLINE: one alert, new orders (pickups and deliveries)
// straight to the tablet, queued ones fall back without a call; a probe closes it with one "back online" note.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const mock = new MockDragontail();
const RUN = nanoid(6).toLowerCase();
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'kitchen-outage-fixture');
const DAY = 86_400_000;
const STORE_NO = 1_000_000 + Math.floor(Math.random() * 800_000);
const AT = { lat: 3.9 + Math.random() * 0.3, lng: -59.1 + Math.random() * 0.3 };
const userIds: string[] = [];
const vendorIds: string[] = [];

type Actor = { userId: string; token: string };
let owner: Actor;
let opsAdminId = '';
let customerId = '';
let vendorId = '';
let integrationId = '';
let itemId = '';
/** A local port nothing listens on: a real ECONNREFUSED. */
let closedUrl = '';

const deps = (): KitchenDeps => ({ prisma: app.prisma, io: app.io, redis: app.redis, client: { backoffMs: 1 } });

function setEnv(opts: { on?: boolean; url?: string } = {}) {
  process.env['DRAGONTAIL_INTEGRATION'] = opts.on === false ? '' : '1';
  process.env['DRAGONTAIL_API_URL'] = opts.url ?? mock.url;
  process.env['DRAGONTAIL_CREDENTIALS'] = JSON.stringify({
    [kitchenLoginRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { userName: 'pos-outage', password: 'pw-outage' },
    [kitchenWebhookRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { webhookSecret: `whs-${nanoid(24)}` },
  });
  for (const key of ['DRAGONTAIL_ACCEPT_ON', 'DRAGONTAIL_TIMEOUT_MS', 'DRAGONTAIL_BREAKER_FAILURES', 'DRAGONTAIL_BREAKER_WINDOW_SECONDS', 'DRAGONTAIL_BREAKER_PROBE_SECONDS']) delete process.env[key];
}

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Out', lastName: `A${RUN}`, roles, activeRole, status: 'ACTIVE', isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `kx-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

async function makeOrder(fulfillment: 'DELIVERY' | 'PICKUP' = 'DELIVERY') {
  return sys(() => app.prisma.order.create({
    data: {
      orderNumber: `KX-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'PENDING', fulfillment,
      deliveryAddress: '9 Test Street', deliveryLat: AT.lat + 0.004, deliveryLng: AT.lng, pickupAddress: 'store', pickupLat: AT.lat, pickupLng: AT.lng,
      subtotalBase: 3500, subtotalMarkup: 0, subtotalCustomer: 3500, deliveryFee: 800, totalAmount: 4300, paymentMethod: 'CASH',
      holdExpiresAt: new Date(Date.now() - 1_000),
      items: { create: [{ itemId, name: 'Pan Pizza XL', quantity: 1, basePrice: 3500, markedUpPrice: 3500, markupAmount: 0, totalBase: 3500, totalMarkup: 0, totalCustomer: 3500 }] },
      statusHistory: { create: { status: 'PENDING', changedBy: customerId, note: 'placed (test)' } },
    },
  }));
}

const syncOf = (orderId: string) => app.prisma.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } } });
const link = () => app.prisma.vendorIntegration.findUniqueOrThrow({ where: { id: integrationId } });
const ringsOf = (orderId: string) => app.prisma.notification.count({ where: { userId: owner.userId, title: { contains: 'New' }, data: { path: ['orderId'], equals: orderId } } });
/** Operations notes about this order (per-order pages). */
const orderPages = (orderId: string) => app.prisma.notification.count({ where: { userId: opsAdminId, data: { path: ['orderId'], equals: orderId } } });
/** Operations notes about the branch's link. */
const linkNotes = (words: string) => app.prisma.notification.count({ where: { userId: opsAdminId, title: { contains: words }, data: { path: ['vendorIntegrationId'], equals: integrationId } } });
const release = () => new OrderService(app.prisma, app.io).releaseDueHeldOrders(async () => {});

/** A send with a token already cached (so the INSERT itself meets the refused connection). */
async function warmToken() {
  setEnv();
  const order = await makeOrder('PICKUP');
  await release();
  await drainKitchenSyncs(deps(), { orderIds: [order.id] });
  expect((await syncOf(order.id))?.state).toBe('SENT');
}

/** One claimed order whose insert meets a refused connection. */
async function refusedSend() {
  const order = await makeOrder();
  await release();
  expect((await syncOf(order.id))?.state).toBe('QUEUED');
  setEnv({ url: closedUrl });
  await drainKitchenSyncs(deps(), { orderIds: [order.id] });
  setEnv();
  return order;
}

beforeAll(async () => {
  await mock.start();
  mock.users.set('pos-outage', 'pw-outage');
  const spare = http.createServer();
  await new Promise<void>((r) => spare.listen(0, '127.0.0.1', r));
  closedUrl = `http://127.0.0.1:${(spare.address() as AddressInfo).port}`;
  await new Promise<void>((r) => spare.close(() => r()));
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  opsAdminId = (await makeUser(['ADMIN'], 'ADMIN')).userId;
  customerId = (await makeUser(['CUSTOMER'], 'CUSTOMER')).userId;
  await sys(async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: `Outage Diner ${wordFreeTag()}`, slug: `kx-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926990002',
        addressLine1: '1 Kitchen St', city: 'Lethem', region: 'Upper Takutu', latitude: AT.lat, longitude: AT.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, selfDeliveryEnabled: true,
      },
    });
    vendorId = vendor.id;
    vendorIds.push(vendor.id);
    const category = await app.prisma.category.create({ data: { vendorId, name: 'Pizza' } });
    itemId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Pan Pizza XL', basePrice: 3500, externalItemNo: '8' } })).id;
  });
  process.env['DRAGONTAIL_INTEGRATION'] = '1';
  integrationId = (await putKitchenIntegration(app.prisma, vendorId, { enabled: true, externalStoreNo: STORE_NO })).connection!.id;
}, 120_000);

beforeEach(async () => {
  mock.reset();
  setEnv();
  forgetKitchenTokens();
  await sys(() => app.prisma.vendorIntegration.update({
    where: { id: integrationId },
    data: { linkFailures: 0, linkFirstFailureAt: null, linkOfflineAt: null, linkProbeAt: null },
  }));
});

afterAll(async () => {
  for (const key of ['DRAGONTAIL_INTEGRATION', 'DRAGONTAIL_API_URL', 'DRAGONTAIL_CREDENTIALS', 'DRAGONTAIL_TIMEOUT_MS', 'DRAGONTAIL_BREAKER_FAILURES', 'DRAGONTAIL_BREAKER_WINDOW_SECONDS', 'DRAGONTAIL_BREAKER_PROBE_SECONDS']) delete process.env[key];
  await sys(async () => {
    const ids = (await app.prisma.order.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((o) => o.id);
    if (ids.length) {
      await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: ids } } });
      await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
    }
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

describe('[DT-OUTAGE] a send that certainly never arrived', () => {
  it('a REFUSED connection on the insert: the tablet rings at once, no page for the order, never "may have arrived"', async () => {
    await warmToken();
    const order = await refusedSend();
    const sync = await syncOf(order.id);
    expect(sync?.state, sync?.lastError ?? '').toBe('FALLBACK');
    expect(sync?.lastError).toContain('nothing was sent');
    expect(await ringsOf(order.id)).toBe(1);
    expect(await orderPages(order.id), 'no page per order').toBe(0);
    expect((await link()).linkFailures, 'counted toward the breaker').toBe(1);
    expect((await link()).linkOfflineAt).toBeNull();
  });

  it('5xx answers after the spec’s retries: the same (rung, counted, no page)', async () => {
    const order = await makeOrder();
    await release();
    mock.failNext('/PosInsertOrders', [500, 502, 503, 504]);
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(await ringsOf(order.id)).toBe(1);
    expect(await orderPages(order.id)).toBe(0);
    expect((await link()).linkFailures).toBe(1);
  });

  it('an order Dragontail refuses (validation) is not a link failure: rung and paged as before, not counted', async () => {
    const order = await makeOrder();
    await release();
    mock.refuse('/PosInsertOrders', 200, { status: 'validationError' });
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(await orderPages(order.id)).toBe(1);
    expect((await link()).linkFailures).toBe(0);
  });
});

describe('[DT-OUTAGE] a send that MAY have arrived keeps the careful path', () => {
  it('the connection cut AFTER the request reached Dragontail: UNKNOWN, the tablet NOT rung, not counted', async () => {
    const order = await makeOrder();
    await release();
    mock.destroyPaths.add('/PosInsertOrders');
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect(mock.count('/PosInsertOrders'), 'the request did arrive').toBe(1);
    expect((await syncOf(order.id))?.state).toBe('UNKNOWN');
    expect(await ringsOf(order.id)).toBe(0);
    expect((await link()).linkFailures).toBe(0);
  });
});

describe('[DT-OUTAGE] the branch breaker', () => {
  it('3 certain failures in the window: OFFLINE once, ONE alert; then new orders (delivery and pickup) go straight to the tablet', async () => {
    await warmToken();
    const failed = [await refusedSend(), await refusedSend(), await refusedSend()];
    for (const o of failed) expect((await syncOf(o.id))?.state).toBe('FALLBACK');
    const after = await link();
    expect(after.linkOfflineAt).not.toBeNull();
    expect(await linkNotes('Kitchen link offline, orders on tablet')).toBe(1);
    for (const o of failed) expect(await orderPages(o.id)).toBe(0);


    mock.reset();
    for (const fulfillment of ['DELIVERY', 'PICKUP'] as const) {
      const order = await makeOrder(fulfillment);
      await release();
      expect(await syncOf(order.id), `${fulfillment}: never claimed while offline`).toBeNull();
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).kitchenRoute).toBeNull();
      expect(await ringsOf(order.id), `${fulfillment}: rung on the tablet`).toBe(1);
    }
    expect(mock.requests, 'nothing is sent to an offline link').toHaveLength(0);

    // The branch sees it.
    const view = await app.inject({ method: 'GET', url: '/api/v1/vendor/kitchen-overflow', headers: { authorization: `Bearer ${owner.token}`, 'x-vendor-id': vendorId } });
    expect(view.json().data).toMatchObject({ available: true, linkOffline: true });
  });

  it('an order queued before the link went offline falls back without any call', async () => {
    const order = await makeOrder();
    await release();
    expect((await syncOf(order.id))?.state).toBe('QUEUED');
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkOfflineAt: new Date(), linkProbeAt: new Date() } }));
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(await ringsOf(order.id)).toBe(1);
    expect(mock.requests).toHaveLength(0);
  });

  it('failures spread wider than the window, or broken by a success, never open it', async () => {
    await warmToken();
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkFailures: 2, linkFirstFailureAt: new Date(Date.now() - 3 * 60_000) } }));
    await refusedSend();
    expect(await link()).toMatchObject({ linkFailures: 1, linkOfflineAt: null });

    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkFailures: 2, linkFirstFailureAt: new Date() } }));
    const ok = await makeOrder();
    await release();
    await drainKitchenSyncs(deps(), { orderIds: [ok.id] });
    expect((await syncOf(ok.id))?.state).toBe('SENT');
    expect(await link()).toMatchObject({ linkFailures: 0, linkOfflineAt: null });
  });

  it('the probe: still down → stays offline; Dragontail back → closes with ONE "back online" note; claims resume', async () => {
    const since = new Date(Date.now() - 5 * 60_000);
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkOfflineAt: since, linkProbeAt: since, linkFailures: 3 } }));
    setEnv({ url: closedUrl });
    expect(await probeOfflineKitchenLinks(deps())).toBe(0);
    expect((await link()).linkOfflineAt).not.toBeNull();
    // Cool-down: probed a moment ago, not probed again.
    setEnv();
    expect(await probeOfflineKitchenLinks(deps())).toBe(0);
    expect(mock.count('/login')).toBe(0);

    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkProbeAt: since } }));
    expect(await probeOfflineKitchenLinks(deps())).toBe(1);
    expect(await link()).toMatchObject({ linkOfflineAt: null, linkFailures: 0 });
    expect(await linkNotes('Kitchen link back online')).toBe(1);
    const order = await makeOrder();
    expect(await claimForKitchen(app.prisma, order.id)).toBe(true);
  });

  it('switch OFF: no probe, no call', async () => {
    await sys(() => app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { linkOfflineAt: new Date(0), linkProbeAt: new Date(0) } }));
    setEnv({ on: false });
    expect(await probeOfflineKitchenLinks(deps())).toBe(0);
    expect(mock.requests).toHaveLength(0);
  });
});
