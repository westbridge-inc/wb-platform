import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';
import { MockDragontail } from './helpers/mock-dragontail';
import { claimForKitchen, kitchenDefersStoreAlert } from '../modules/kitchen/kitchen-claim';
import {
  applyKitchenEvents,
  drainKitchenSyncs,
  forgetKitchenTokens,
  KITCHEN_TICK_LOCK,
  kitchenLadderStep,
  kitchenBackstopSweep,
  pollKitchenIntegrations,
  propagateKitchenCancellations,
  resolveUnknownKitchenSyncs,
  runKitchenTick,
  type KitchenDeps,
} from '../modules/kitchen/kitchen-sync';
import { KITCHEN_STUCK_MS } from '../modules/kitchen/kitchen-switch';
import { kitchenLoginRef, kitchenWebhookRef } from '../modules/kitchen/kitchen-credentials';
import { putKitchenIntegration, getKitchenIntegration, setKitchenItemNumbers, testKitchenConnection } from '../modules/kitchen/kitchen-admin';
import { kitchenWebhookRoutes, kitchenWebhookSignature } from '../modules/kitchen/kitchen-webhook.routes';
import type { KitchenEvent } from '../modules/kitchen/kitchen-provider';

// ---------------------------------------------------------------------------
// [KITCHEN-INTEGRATION · owner 11 Nov 2026] The integration against a real database and a mock Dragontail:
// switch OFF changes nothing and calls nothing; ON, the store's ring becomes the kitchen insert at the hold
// release, success accepts the order as the store's own delivery, ANY failure rings the tablet instead (never
// lost, never sent twice); every kitchen action maps through the order state machine; the webhook refuses a
// wrong proof; the poller catches up; a cancel reaches the kitchen; the tenant wall and the credential keys hold.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const mock = new MockDragontail();
const userIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_300_000_000 + Math.floor(Math.random() * 600_000_000);
const STORE_NO = 40_000 + Math.floor(Math.random() * 50_000);
const WEBHOOK_SECRET = `whs-${nanoid(32)}`;

let ownerUserId = '';
let customerId = '';
let vendorId = '';
let integrationId = '';
let itemId = '';
let unmappedItemId = '';
/** The test's own operations admin: pages are counted on this one inbox (a seeded database has other admins). */
let opsAdminId = '';

const deps = (): KitchenDeps => ({ prisma: app.prisma, io: app.io, redis: app.redis, client: { backoffMs: 1 } });

function setEnv(on: boolean) {
  process.env['DRAGONTAIL_INTEGRATION'] = on ? '1' : '';
  process.env['DRAGONTAIL_API_URL'] = mock.url;
  process.env['DRAGONTAIL_CREDENTIALS'] = JSON.stringify({
    [kitchenLoginRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { userName: 'pos-swift', password: 'pw-swift' },
    [kitchenWebhookRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { webhookSecret: WEBHOOK_SECRET },
  });
  for (const key of ['DRAGONTAIL_ACCEPT_ON', 'DRAGONTAIL_WEBHOOK_CHECK', 'DRAGONTAIL_POLL_QUEUE', 'DRAGONTAIL_ORDER_ID_BASE', 'DRAGONTAIL_TIMEOUT_MS', 'CALL_RELAY', 'COUNTERPART_PHONES_TO_OLD_APPS']) delete process.env[key];
}

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Kit', lastName: `Chen${seq}`, roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  return user.id;
}

async function makeStore(selfDelivery = true) {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Kitchen Diner ${seq}`, slug: `kitchen-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `+5920077${String(seq).padStart(3, '0')}`, addressLine1: '1 Kitchen St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      selfDeliveryEnabled: selfDelivery,
    },
  });
  vendorIds.push(vendor.id);
  return { ownerUserId: owner, vendorId: vendor.id };
}

async function makeOrder(opts: { fulfillment?: 'DELIVERY' | 'PICKUP'; mapped?: boolean; paymentMethod?: 'CASH' | 'MOBILE_MONEY'; store?: string } = {}) {
  const fulfillment = opts.fulfillment ?? 'DELIVERY';
  const lineItem = opts.mapped === false ? unmappedItemId : itemId;
  return app.prisma.order.create({
    data: {
      orderNumber: `KIT-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId: opts.store ?? vendorId,
      status: 'PENDING',
      fulfillment,
      deliveryAddress: '9 Test Street', deliveryLat: 6.81, deliveryLng: -58.16, deliveryInstructions: 'Blue gate',
      pickupAddress: 'store', pickupLat: 6.8, pickupLng: -58.15,
      subtotalBase: 3500, subtotalMarkup: 0, subtotalCustomer: 3500, deliveryFee: 800, totalAmount: 4300,
      paymentMethod: opts.paymentMethod ?? 'CASH',
      holdExpiresAt: new Date(Date.now() - 1_000),
      items: {
        create: [{
          itemId: lineItem, name: 'Pan Pizza XL', quantity: 1, basePrice: 3500, markedUpPrice: 3500, markupAmount: 0,
          totalBase: 3500, totalMarkup: 0, totalCustomer: 3500, specialInstructions: 'well done',
          selectedOptions: { create: [{ optionGroupName: 'Toppings', optionName: 'green pepper', basePrice: 0, markedUpPrice: 0, markupAmount: 0 }] },
        }],
      },
      statusHistory: { create: { status: 'PENDING', changedBy: customerId, note: 'placed (test)' } },
    },
  });
}

/** Operations pages about this order whose title contains `words`. */
const opsPages = (orderId: string, words: string) => app.prisma.notification.count({ where: { userId: opsAdminId, title: { contains: words }, data: { path: ['orderId'], equals: orderId } } });
const ringsFor = (userId: string) => app.prisma.notification.count({ where: { userId, title: { contains: 'New' } } });
const syncOf = (orderId: string) => app.prisma.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } } });
const orderOf = (orderId: string) => app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
const integration = () => app.prisma.vendorIntegration.findUniqueOrThrow({ where: { id: integrationId } });
const event = (externalOrderId: number, kind: KitchenEvent['kind'], action: string, extra: Partial<KitchenEvent> = {}): KitchenEvent => ({
  storeNo: STORE_NO, externalOrderId, kind, action, at: new Date(), etaSeconds: null, ...extra,
});

async function releaseOnly() {
  await new OrderService(app.prisma, app.io).releaseDueHeldOrders(async () => {});
}

/** A released, sent, accepted order (the happy path), for the action tests. */
async function sentOrder(fulfillment: 'DELIVERY' | 'PICKUP' = 'DELIVERY') {
  const order = await makeOrder({ fulfillment });
  await releaseOnly();
  await drainKitchenSyncs(deps(), { orderIds: [order.id] });
  const sync = await syncOf(order.id);
  expect(sync?.state).toBe('SENT');
  return { order, sync: sync! };
}

beforeAll(async () => {
  // NODE_ENV stays 'test' (vitest pins it): only a test run may point the kitchen client at the loopback mock.
  await mock.start();
  mock.users.set('pos-swift', 'pw-swift');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(kitchenWebhookRoutes, { prefix: '/api/v1/integrations/dragontail' });
  await app.ready();

  ({ ownerUserId, vendorId } = await makeStore(true));
  // An operations admin, so the kitchen pages land somewhere the tests can count.
  opsAdminId = await makeUser(['ADMIN'], 'ADMIN');
  customerId = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Pizza' } });
  const item = await app.prisma.item.create({
    data: {
      vendorId, categoryId: category.id, name: 'Pan Pizza XL', basePrice: 3500, externalItemNo: '8',
      optionGroups: { create: [{ name: 'Toppings', options: { create: [{ name: 'green pepper', externalItemNo: '121' }] } }] },
    },
  });
  itemId = item.id;
  const unmapped = await app.prisma.item.create({
    data: {
      vendorId, categoryId: category.id, name: 'Pan Pizza XL', basePrice: 3500,
      optionGroups: { create: [{ name: 'Toppings', options: { create: [{ name: 'green pepper' }] } }] },
    },
  });
  unmappedItemId = unmapped.id;
  // The console writes a connection only while the switch is on (review A S3-2).
  process.env['DRAGONTAIL_INTEGRATION'] = '1';
  const view = await putKitchenIntegration(app.prisma, vendorId, { enabled: true, externalStoreNo: STORE_NO });
  integrationId = view.connection!.id;
});

beforeEach(async () => {
  mock.reset();
  setEnv(true);
  forgetKitchenTokens();
  await app.redis.del(KITCHEN_TICK_LOCK);
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const key of ['DRAGONTAIL_INTEGRATION', 'DRAGONTAIL_API_URL', 'DRAGONTAIL_CREDENTIALS', 'DRAGONTAIL_ACCEPT_ON', 'DRAGONTAIL_WEBHOOK_CHECK', 'DRAGONTAIL_POLL_QUEUE', 'DRAGONTAIL_ORDER_ID_BASE', 'DRAGONTAIL_TIMEOUT_MS', 'CALL_RELAY', 'COUNTERPART_PHONES_TO_OLD_APPS']) delete process.env[key];
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: userIds } }, select: { id: true } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  await mock.stop();
});

describe('[KITCHEN] switch OFF: unchanged behaviour, zero calls', () => {
  it('the release rings the tablet as today; no claim, no call, no deferral', async () => {
    setEnv(false);
    const before = await ringsFor(ownerUserId);
    const order = await makeOrder();
    await releaseOnly();
    await drainKitchenSyncs(deps());
    await propagateKitchenCancellations(deps());
    await pollKitchenIntegrations(deps());
    expect(await syncOf(order.id)).toBeNull();
    expect(mock.requests).toEqual([]);
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
    expect(await kitchenDefersStoreAlert(app.prisma, order.id)).toBe(false);
    expect(await claimForKitchen(app.prisma, order.id)).toBe(false);
    expect((await orderOf(order.id)).status).toBe('PENDING');
  });
});

describe('[KITCHEN] outbound: the insert replaces the ring', () => {
  it('claims at the release (no ring), sends once, accepts as the store own delivery', async () => {
    const before = await ringsFor(ownerUserId);
    const order = await makeOrder();
    await releaseOnly();
    const queued = await syncOf(order.id);
    expect(queued).toMatchObject({ state: 'QUEUED', provider: 'DRAGONTAIL' });
    expect(await kitchenDefersStoreAlert(app.prisma, order.id), 'the ladder waits while the kitchen is being given it').toBe(true);
    expect(await ringsFor(ownerUserId), 'no tablet ring for a claimed order').toBe(before);

    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    const sent = await syncOf(order.id);
    expect(sent?.lastError ?? null).toBeNull();
    expect(sent).toMatchObject({ state: 'SENT', attempts: 1, promiseSeconds: mock.promiseTimeSeconds });
    expect(mock.count('/PosInsertOrders')).toBe(1);
    const body = mock.inserted[0] as { orders: Array<Record<string, unknown>>; ordersItems: Array<Record<string, unknown>> };
    expect(body.orders[0]).toMatchObject({ storeNo: STORE_NO, orderId: queued!.externalOrderId, saleType: 2, paymentMethod: 0, cash: 4300, carrierInstructions: 'Blue gate', firstName: 'Kit' });
    expect(body.orders[0], 'never the last name').not.toHaveProperty('lastName');
    expect(body.orders[0]!['phone'], 'owner ruling 12 Nov: a delivery carries the phone for the store own driver').toMatch(/^\+592/);
    expect(body.ordersItems.map((r) => [r['Position'], r['ItemNo']])).toEqual([['001', '8'], ['001001', '121']]);

    const accepted = await orderOf(order.id);
    expect(accepted.status).toBe('PREPARING');
    expect(accepted.fulfillmentMode, 'own delivery: never Swift rider dispatch').toBe('VENDOR_DELIVERY');
    expect(accepted.riderId).toBeNull();
    expect(await ringsFor(ownerUserId)).toBe(before);
    expect(await kitchenDefersStoreAlert(app.prisma, order.id)).toBe(false);
  });

  it('idempotent: a second drain, a second claim and a replayed release send nothing more', async () => {
    const order = await makeOrder();
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect(await claimForKitchen(app.prisma, order.id)).toBe(true);
    await releaseOnly();
    await drainKitchenSyncs(deps());
    const externalId = (await syncOf(order.id))!.externalOrderId;
    expect(mock.inserted.filter((b) => (b as { orders: Array<{ orderId: number }> }).orders[0]!.orderId === externalId)).toHaveLength(1);
    expect(await app.prisma.orderIntegrationSync.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('a line with no kitchen item number: nothing is sent, the tablet rings (never lost)', async () => {
    const before = await ringsFor(ownerUserId);
    const order = await makeOrder({ mapped: false });
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    const sync = await syncOf(order.id);
    expect(sync).toMatchObject({ state: 'FALLBACK' });
    expect(sync!.lastError).toMatch(/kitchen item number/);
    expect(mock.count('/PosInsertOrders')).toBe(0);
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
    expect((await orderOf(order.id)).status).toBe('PENDING');
    expect(await kitchenDefersStoreAlert(app.prisma, order.id), 'a fallen-back order rings like any store').toBe(false);
    expect((await integration()).lastError).toMatch(/kitchen item number/);
  });

  it('Dragontail down after the spec 3 retries: the tablet rings; one insert attempt chain, never a second send', async () => {
    const before = await ringsFor(ownerUserId);
    const order = await makeOrder();
    await releaseOnly();
    mock.failNext('/PosInsertOrders', [500, 500, 500, 500]);
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(mock.count('/PosInsertOrders')).toBe(4);
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect(mock.count('/PosInsertOrders'), 'a fallen-back order is never sent later').toBe(4);
  });

  it('no login in the secret: the tablet rings', async () => {
    const order = await makeOrder();
    await releaseOnly();
    process.env['DRAGONTAIL_CREDENTIALS'] = '{}';
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.lastError).toMatch(/login/);
    expect(mock.requests).toEqual([]);
  });

  it('MMG orders and stores that do not deliver themselves are not claimed (the tablet rings)', async () => {
    const mmg = await makeOrder({ paymentMethod: 'MOBILE_MONEY' });
    await releaseOnly();
    expect(await syncOf(mmg.id)).toBeNull();
    const other = await makeStore(false);
    const otherOrder = await makeOrder({ store: other.vendorId });
    await releaseOnly();
    expect(await syncOf(otherOrder.id)).toBeNull();
  });

  it('a lapsed SENDING lease is never re-sent blind, nor rung: it may be in the kitchen (UNKNOWN, operations paged)', async () => {
    const before = await ringsFor(ownerUserId);
    const order = await makeOrder();
    await releaseOnly();
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { state: 'SENDING', leaseUntil: new Date(Date.now() - 1000) } });
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state).toBe('UNKNOWN');
    expect(mock.count('/PosInsertOrders')).toBe(0);
    expect(await ringsFor(ownerUserId)).toBe(before);
    expect(await opsPages(order.id, 'MAY be in the kitchen')).toBe(1);
  });
});

describe('[KITCHEN] inbound: every action through the state machine', () => {
  it('delivery: Prepared (no-op on PREPARING) → Pack → Dispatched → ETA → Delivered; late and unknown actions change nothing', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    const int = await integration();
    const id = sync.externalOrderId;
    expect(await applyKitchenEvents(deps(), int, [event(id, 'PREPARED', 'Prepared')])).toEqual(['unchanged']);
    expect(await applyKitchenEvents(deps(), int, [event(id, 'PACKED', 'Pack')])).toEqual(['applied']);
    expect((await orderOf(order.id)).status).toBe('READY_FOR_PICKUP');
    expect(await applyKitchenEvents(deps(), int, [event(id, 'DISPATCHED', 'Dispatched')])).toEqual(['applied']);
    expect((await syncOf(order.id))?.dispatchedAt).toBeTruthy();
    const pushed = await app.prisma.notification.findFirst({ where: { userId: customerId, title: 'Your order is on its way' }, orderBy: { createdAt: 'desc' } });
    expect(pushed?.body).toMatch(/store's own driver/);
    expect(await applyKitchenEvents(deps(), int, [event(id, 'DISPATCHED', 'Dispatched')]), 'a repeat is a no-op').toEqual(['unchanged']);
    expect(await applyKitchenEvents(deps(), int, [event(id, 'ETA', 'ETA', { etaSeconds: 900 })])).toEqual(['applied']);
    expect((await orderOf(order.id)).estimatedDeliveryTime).toBe(15);
    expect(await applyKitchenEvents(deps(), int, [event(id, 'DELIVERED', 'Delivered')])).toEqual(['applied']);
    expect((await orderOf(order.id)).status).toBe('DELIVERED');
    expect((await syncOf(order.id))?.state).toBe('DONE');
    expect(await applyKitchenEvents(deps(), int, [event(id, 'PREPARED', 'Prepared')]), 'out of order after the end').toEqual(['unchanged']);
    expect(await applyKitchenEvents(deps(), int, [event(id, 'IGNORED', 'SomethingNew')])).toEqual(['ignored']);
    expect(await applyKitchenEvents(deps(), int, [event(999_999_999, 'PACKED', 'Pack')])).toEqual(['unknown-order']);
    expect(await applyKitchenEvents(deps(), int, [{ ...event(id, 'PACKED', 'Pack'), storeNo: STORE_NO + 1 }]), 'another store number').toEqual(['unknown-order']);
  });

  it('Delivered straight after Dispatched walks the declared edges (PREPARING → READY → DELIVERED)', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    await applyKitchenEvents(deps(), await integration(), [event(sync.externalOrderId, 'DELIVERED', 'Delivered')]);
    const log = await app.prisma.orderStatusLog.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' }, select: { status: true } });
    expect(log.map((l) => l.status)).toEqual(['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERED']);
  });

  it('pickup: Pack → ready for the customer; Dispatched, ETA and Delivered do not apply', async () => {
    const { order, sync } = await sentOrder('PICKUP');
    const int = await integration();
    expect((await orderOf(order.id)).fulfillmentMode).toBeNull();
    expect(await applyKitchenEvents(deps(), int, [event(sync.externalOrderId, 'PACKED', 'Pack')])).toEqual(['applied']);
    expect((await orderOf(order.id)).status).toBe('READY_FOR_PICKUP');
    expect(await applyKitchenEvents(deps(), int, [
      event(sync.externalOrderId, 'DISPATCHED', 'Dispatched'), event(sync.externalOrderId, 'ETA', 'ETA', { etaSeconds: 60 }), event(sync.externalOrderId, 'DELIVERED', 'Delivered'),
    ])).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect((await orderOf(order.id)).status).toBe('READY_FOR_PICKUP');
  });

  it('Undelivered / Unassigned are operations matters: logged and paged, the order is not moved', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    expect(await applyKitchenEvents(deps(), await integration(), [event(sync.externalOrderId, 'UNDELIVERED', 'Undelivered'), event(sync.externalOrderId, 'UNASSIGNED', 'Unassigned')])).toEqual(['applied', 'applied']);
    expect((await orderOf(order.id)).status).toBe('PREPARING');
    expect((await syncOf(order.id))?.lastAction).toBe('Unassigned');
  });

  it('KITCHEN_ACTION mode: the insert does not accept; the first kitchen action does', async () => {
    process.env['DRAGONTAIL_ACCEPT_ON'] = 'KITCHEN_ACTION';
    const order = await makeOrder();
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await orderOf(order.id)).status).toBe('PENDING');
    expect(await kitchenDefersStoreAlert(app.prisma, order.id), 'the ladder waits for the kitchen within its time').toBe(true);
    const sync = (await syncOf(order.id))!;
    await applyKitchenEvents(deps(), await integration(), [event(sync.externalOrderId, 'MAKE_LINE', 'ReachedTheMakeLine')]);
    const after = await orderOf(order.id);
    expect(after.status).toBe('PREPARING');
    expect(after.fulfillmentMode).toBe('VENDOR_DELIVERY');
  });

  it('the poller catches up from GetPosNotification and GetOrderUpdatesForPos, and keeps the stamp', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    process.env['DRAGONTAIL_POLL_QUEUE'] = '1';
    await app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { lastPolledAt: null, pollUpdateStamp: 0 } });
    mock.updates = [{ stamp: 41, storeNo: STORE_NO, orderId: sync.externalOrderId, reachedTheMakeLineTime: '2026-11-11 12:00:00', packTime: '2026-11-11 12:10:00', dispatchTime: '', deliveryTime: '' }];
    mock.pending = [{ storeNo: STORE_NO, orderId: sync.externalOrderId, action: 'Dispatched', actionTime: '2026-11-11 12:12:00', deviceId: 'dispatch1' }];
    expect(await pollKitchenIntegrations(deps())).toBe(1);
    expect(mock.requests.find((r) => r.path === '/GetPosNotification')?.search, 'Swift reads only its own consumer queue').toContain('id=swift');
    expect((await orderOf(order.id)).status).toBe('READY_FOR_PICKUP');
    expect((await syncOf(order.id))?.dispatchedAt).toBeTruthy();
    const int = await integration();
    expect(int.pollUpdateStamp).toBe(41n);
    expect(int.lastHealthyAt).toBeTruthy();
    expect(await pollKitchenIntegrations(deps()), 'not again inside the interval').toBe(0);
  });
});

describe('[KITCHEN] the webhook', () => {
  const post = (payload: string, headers: Record<string, string>) => app.inject({
    method: 'POST', url: `/api/v1/integrations/dragontail/notifications/${integrationId}`,
    payload, headers: { 'content-type': 'application/json', ...headers },
  });

  it('refuses a missing or wrong proof (nothing recorded), accepts the right one and applies it', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    const body = JSON.stringify({ time: '2026-11-11 12:00:00', orders: [{ storeNo: STORE_NO, orderId: sync.externalOrderId, action: 'Pack', actionTime: '2026-11-11 12:00:00', deviceId: 'pack1' }] });
    expect((await post(body, {})).statusCode).toBe(403);
    expect((await post(body, { 'x-dragontail-shared': 'wrong-secret-wrong-secret' })).statusCode).toBe(403);
    expect((await orderOf(order.id)).status).toBe('PREPARING');
    const ok = await post(body, { 'x-dragontail-shared': WEBHOOK_SECRET });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', rowCount: 1 });
    expect((await orderOf(order.id)).status).toBe('READY_FOR_PICKUP');
  });

  it('signature mode: the HMAC of the raw body', async () => {
    process.env['DRAGONTAIL_WEBHOOK_CHECK'] = 'signature';
    const body = JSON.stringify({ time: 'x', orders: [] });
    expect((await post(body, { 'x-dragontail-shared': WEBHOOK_SECRET })).statusCode).toBe(403);
    expect((await post(body, { 'x-dragontail-signature': kitchenWebhookSignature(WEBHOOK_SECRET, body) })).statusCode).toBe(200);
  });

  it('switch off, unknown or disabled connection: 404; no secret: 503', async () => {
    setEnv(false);
    expect((await post('{}', { 'x-dragontail-shared': WEBHOOK_SECRET })).statusCode).toBe(404);
    setEnv(true);
    expect((await app.inject({ method: 'POST', url: '/api/v1/integrations/dragontail/notifications/cnope0000000000000000000', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
    process.env['DRAGONTAIL_CREDENTIALS'] = '{}';
    expect((await post('{}', { 'x-dragontail-shared': WEBHOOK_SECRET })).statusCode).toBe(503);
  });
});

describe('[KITCHEN] a cancellation reaches the kitchen', () => {
  it('a sent order cancelled on Swift is re-sent with every item removed, once', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    await new OrderService(app.prisma, app.io).transitionOrderAtomically({
      orderId: order.id, target: 'CANCELLED', allowedFrom: ['PREPARING'], changedBy: null, note: 'test cancel',
      cancellation: { by: null, reason: 'test cancel' },
    });
    mock.reset();
    expect(await propagateKitchenCancellations(deps())).toBeGreaterThanOrEqual(1);
    const cancel = mock.inserted.find((b) => (b as { orders: Array<{ orderId: number }> }).orders[0]!.orderId === sync.externalOrderId) as { ordersItems: Array<Record<string, unknown>> };
    expect(cancel.ordersItems.every((r) => r['ItemsActions'] === 2)).toBe(true);
    expect((await syncOf(order.id))?.state).toBe('CANCELLED');
    mock.reset();
    await propagateKitchenCancellations(deps());
    expect(mock.count('/PosInsertOrders')).toBe(0);
  });

  it('an order cancelled before the send is never sent', async () => {
    const order = await makeOrder();
    await releaseOnly();
    await new OrderService(app.prisma, app.io).transitionOrderAtomically({
      orderId: order.id, target: 'CANCELLED', allowedFrom: ['PENDING'], changedBy: null, note: 'test cancel',
      cancellation: { by: null, reason: 'test cancel' },
    });
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect(mock.count('/PosInsertOrders')).toBe(0);
    expect((await syncOf(order.id))?.state).toBe('DONE');
  });
});

describe('[KITCHEN · security review] walls: tenant lineage and credential keys', () => {
  it('a sync row naming another store connection is refused by the database', async () => {
    const other = await makeStore(true);
    const otherConn = await putKitchenIntegration(app.prisma, other.vendorId, { externalStoreNo: STORE_NO + 7 });
    const order = await makeOrder();
    await expect(app.prisma.orderIntegrationSync.create({
      data: { orderId: order.id, vendorIntegrationId: otherConn.connection!.id, provider: 'DRAGONTAIL', externalOrderId: 1_999_999_001, externalStoreNo: STORE_NO + 7, dailyNo: 1 },
    })).rejects.toThrow(/lineage|check_violation|tenant/i);
    // …and moving a valid row onto it is refused too
    await releaseOnly();
    await expect(app.prisma.orderIntegrationSync.update({
      where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } },
      data: { vendorIntegrationId: otherConn.connection!.id },
    })).rejects.toThrow();
  });

  it('a request can never name a credential key; keys are derived, unique, and only the connection own', async () => {
    await expect(putKitchenIntegration(app.prisma, vendorId, { secretRef: kitchenLoginRef({ id: 'cother0000000000000000000', provider: 'DRAGONTAIL' }) })).rejects.toThrow();
    await expect(putKitchenIntegration(app.prisma, vendorId, { webhookSecretRef: 'anything' })).rejects.toThrow();
    const mine = await integration();
    expect(mine.secretRef).toBe(kitchenLoginRef(mine));
    expect(mine.webhookSecretRef).toBe(kitchenWebhookRef(mine));
    const other = await makeStore(true);
    const otherConn = (await putKitchenIntegration(app.prisma, other.vendorId, {})).connection!;
    // the database refuses another connection's key (unique) and any key that is not the row own (check)
    await expect(app.prisma.vendorIntegration.update({ where: { id: otherConn.id }, data: { secretRef: mine.secretRef } })).rejects.toThrow();
    await expect(app.prisma.vendorIntegration.update({ where: { id: otherConn.id }, data: { webhookSecretRef: 'kitchen/dragontail/cxxxxxxxxxxxxxxxxxxxxxxxx/webhook' } })).rejects.toThrow();
    const view = await getKitchenIntegration(app.prisma, vendorId);
    expect(JSON.stringify(view)).not.toContain('pw-swift');
    expect(JSON.stringify(view)).not.toContain(WEBHOOK_SECRET);
  });

  it('enabling needs the store own delivery and a store number; a store number is one store only', async () => {
    const noDelivery = await makeStore(false);
    await expect(putKitchenIntegration(app.prisma, noDelivery.vendorId, { enabled: true, externalStoreNo: STORE_NO + 9 })).rejects.toThrow(/own delivery/);
    const another = await makeStore(true);
    await expect(putKitchenIntegration(app.prisma, another.vendorId, { externalStoreNo: STORE_NO })).rejects.toThrow(/already uses/);
    await expect(putKitchenIntegration(app.prisma, another.vendorId, { enabled: true })).rejects.toThrow(/store number/);
  });

  it('item numbers are set only on the store own listings', async () => {
    const other = await makeStore(true);
    const cat = await app.prisma.category.create({ data: { vendorId: other.vendorId, name: 'x' } });
    const foreign = await app.prisma.item.create({ data: { vendorId: other.vendorId, categoryId: cat.id, name: 'x', basePrice: 1 } });
    await expect(setKitchenItemNumbers(app.prisma, vendorId, { items: [{ itemId: foreign.id, externalItemNo: '1' }] })).rejects.toThrow(/not this store/);
    expect(await setKitchenItemNumbers(app.prisma, vendorId, { items: [{ itemId, externalItemNo: '8' }] })).toEqual({ items: 1, options: 0 });
  });
});

describe('[KITCHEN · reviews A and B] failure isolation, the tablet backstop, the store gate, privacy', () => {
  it('[A S2-1 · B S3-8] a claim that throws never stops the hold release: that order rings, the next is claimed', async () => {
    const counter = await app.prisma.kitchenOrderCounter.findUniqueOrThrow({ where: { provider_externalStoreNo: { provider: 'DRAGONTAIL', externalStoreNo: STORE_NO } } });
    // A row already holding the id the next claim will take: that claim hits the unique index and throws.
    const blocker = await makeOrder();
    await app.prisma.order.update({ where: { id: blocker.id }, data: { holdExpiresAt: null } });
    await app.prisma.orderIntegrationSync.create({ data: { orderId: blocker.id, vendorIntegrationId: integrationId, provider: 'DRAGONTAIL', externalOrderId: counter.orderIdBase + counter.next, externalStoreNo: STORE_NO, dailyNo: 1, state: 'DONE' } });
    const before = await ringsFor(ownerUserId);
    const first = await makeOrder();
    await releaseOnly();
    const second = await makeOrder();
    await releaseOnly();
    expect((await orderOf(first.id)).holdExpiresAt, 'the order whose claim failed is released').toBeNull();
    expect(await syncOf(first.id)).toBeNull();
    expect(await ringsFor(ownerUserId), 'and the store is rung for it').toBe(before + 1);
    expect((await syncOf(second.id))?.state, 'the next order is claimed as usual').toBe('QUEUED');
    await drainKitchenSyncs(deps());
  });

  it('[A S2-1 · B S4-1] the id base is frozen per store number; a recreated connection continues the counter', async () => {
    const a = await makeOrder();
    await releaseOnly();
    const firstId = (await syncOf(a.id))!.externalOrderId;
    process.env['DRAGONTAIL_ORDER_ID_BASE'] = '1000';
    const b = await makeOrder();
    await releaseOnly();
    const secondId = (await syncOf(b.id))!.externalOrderId;
    expect(secondId, 'a changed base never moves an existing store counter').toBe(firstId + 1);
    await drainKitchenSyncs(deps());
  });

  it('[A S2-3] a held store: nothing goes to the kitchen (the tablet rings); its kitchen events move nothing', async () => {
    const held = await makeStore(true);
    const conn = await putKitchenIntegration(app.prisma, held.vendorId, { enabled: true, externalStoreNo: STORE_NO + 31 });
    process.env['DRAGONTAIL_CREDENTIALS'] = JSON.stringify({
      ...JSON.parse(process.env['DRAGONTAIL_CREDENTIALS']!),
      [kitchenLoginRef({ id: conn.connection!.id, provider: 'DRAGONTAIL' })]: { userName: 'pos-swift', password: 'pw-swift' },
    });
    const cat = await app.prisma.category.create({ data: { vendorId: held.vendorId, name: 'Pizza' } });
    const item = await app.prisma.item.create({ data: { vendorId: held.vendorId, categoryId: cat.id, name: 'Pan Pizza XL', basePrice: 3500, externalItemNo: '8', optionGroups: { create: [{ name: 'Toppings', options: { create: [{ name: 'green pepper', externalItemNo: '121' }] } }] } } });
    const order = await app.prisma.order.update({ where: { id: (await makeOrder({ store: held.vendorId })).id }, data: { items: { updateMany: { where: {}, data: { itemId: item.id } } } } });
    await app.prisma.vendor.update({ where: { id: held.vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'ADMIN' } });
    const before = await ringsFor(held.ownerUserId);
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    const sync = await syncOf(order.id);
    expect(sync?.state).toBe('FALLBACK');
    expect(sync?.lastError).toMatch(/may not take new orders/);
    expect(mock.count('/PosInsertOrders')).toBe(0);
    // Back to the tablet path exactly as for any store (a held store's own alerts follow the store rules).
    expect(sync?.fallbackAt).toBeTruthy();
    expect(await ringsFor(held.ownerUserId)).toBeGreaterThanOrEqual(before);
    // An order already with the kitchen at a store that is then held: its events move nothing.
    await app.prisma.vendor.update({ where: { id: held.vendorId }, data: { status: 'ACTIVE', suspensionSource: null } });
    const live = await app.prisma.order.update({ where: { id: (await makeOrder({ store: held.vendorId })).id }, data: { items: { updateMany: { where: {}, data: { itemId: item.id } } } } });
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [live.id] });
    const liveSync = (await syncOf(live.id))!;
    expect(liveSync.state).toBe('SENT');
    await app.prisma.vendor.update({ where: { id: held.vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'ADMIN' } });
    const heldConn = await app.prisma.vendorIntegration.findUniqueOrThrow({ where: { id: conn.connection!.id } });
    expect(await applyKitchenEvents(deps(), heldConn, [event(liveSync.externalOrderId, 'PACKED', 'Pack', { storeNo: STORE_NO + 31 })])).toEqual(['unchanged']);
    expect((await orderOf(live.id)).status).toBe('PREPARING');
  });

  it('[B S2-1a] the switch turned OFF with a claim waiting: the ladder rings the tablet', async () => {
    const order = await makeOrder();
    await releaseOnly();
    setEnv(false);
    const before = await ringsFor(ownerUserId);
    expect(await kitchenLadderStep(deps(), order.id)).toBe('RANG');
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
    expect(await kitchenLadderStep(deps(), order.id), 'once rung, the ladder carries on as for any store').toBe('GO');
  });

  it('[B S2-1a · S3-3] a SENDING claim inside its lease waits; once the lease lapses it may have landed: UNKNOWN, never rung', async () => {
    const order = await makeOrder();
    await releaseOnly();
    const id = { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' as const } };
    await app.prisma.orderIntegrationSync.update({ where: id, data: { state: 'SENDING', leaseUntil: new Date(Date.now() + 60_000) } });
    setEnv(false);
    const before = await ringsFor(ownerUserId);
    expect(await kitchenLadderStep(deps(), order.id)).toBe('WAIT');
    await app.prisma.orderIntegrationSync.update({ where: id, data: { leaseUntil: new Date(Date.now() - 1_000) } });
    expect(await kitchenLadderStep(deps(), order.id)).toBe('WAIT');
    expect((await syncOf(order.id))?.state).toBe('UNKNOWN');
    expect(await ringsFor(ownerUserId), 'the kitchen may be making it: no tablet ring').toBe(before);
    expect(await opsPages(order.id, 'MAY be in the kitchen')).toBe(1);
  });

  it('[B S2-1b] switch ON but no sender running: a claim older than the cap is rung, a younger one waits', async () => {
    const order = await makeOrder();
    await releaseOnly();
    expect(await kitchenLadderStep(deps(), order.id)).toBe('WAIT');
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { createdAt: new Date(Date.now() - KITCHEN_STUCK_MS - 1_000) } });
    expect(await kitchenLadderStep(deps(), order.id)).toBe('RANG');
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
  });

  it('[B S2-1c] the kitchen took it but the accept was refused: the tablet rings at once', async () => {
    const order = await makeOrder();
    await releaseOnly();
    const before = await ringsFor(ownerUserId);
    vi.spyOn(OrderService.prototype, 'updateStatus').mockRejectedValueOnce(new Error('injected: accept refused'));
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    const sync = await syncOf(order.id);
    expect(sync?.state, 'the kitchen has it').toBe('SENT');
    expect(sync?.fallbackAt).toBeTruthy();
    expect((await orderOf(order.id)).status).toBe('PENDING');
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
  });

  /** An order whose insert timed out (the kitchen may have it). */
  async function timedOutOrder() {
    process.env['DRAGONTAIL_TIMEOUT_MS'] = '500';
    const order = await makeOrder();
    await releaseOnly();
    mock.pathDelays.set('/PosInsertOrders', 1_500);
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    mock.pathDelays.delete('/PosInsertOrders');
    const sync = (await syncOf(order.id))!;
    return { order, sync };
  }
  const insertsOf = (externalOrderId: number) => mock.requests
    .filter((r) => r.path === '/PosInsertOrders' && (r.body as { orders: Array<{ orderId: number }> }).orders[0]!.orderId === externalOrderId)
    .map((r) => (r.body as { ordersItems: Array<{ ItemsActions: number }> }).ordersItems[0]!.ItemsActions);
  const pastVerifyWindow = (syncId: string) => app.prisma.orderIntegrationSync.update({ where: { id: syncId }, data: { leaseUntil: new Date(Date.now() - 1_000) } });

  it('[B S3-3] an insert that timed out is UNKNOWN: never re-sent, the tablet NOT rung, operations paged', async () => {
    const before = await ringsFor(ownerUserId);
    const { order, sync } = await timedOutOrder();
    expect(sync.state).toBe('UNKNOWN');
    expect(sync.lastError).toMatch(/may have arrived/);
    expect(insertsOf(sync.externalOrderId), 'one insert, no blind cancel yet').toEqual([0]);
    expect(await ringsFor(ownerUserId), 'no double-make').toBe(before);
    expect(await opsPages(order.id, 'MAY be in the kitchen')).toBe(1);
    expect(await kitchenDefersStoreAlert(app.prisma, order.id), 'the ladder waits; it never rings an UNKNOWN order').toBe(true);
    expect(await kitchenLadderStep(deps(), order.id)).toBe('WAIT');
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect(insertsOf(sync.externalOrderId), 'never sent twice').toEqual([0]);
  });

  it('[B S3-3] verified through the order updates: the kitchen has it -> SENT and accepted, the tablet never rung', async () => {
    const before = await ringsFor(ownerUserId);
    const { order, sync } = await timedOutOrder();
    await app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { lastPolledAt: null, pollUpdateStamp: 0 } });
    // The store's own POS orders come in the same answer; only Swift's are looked at.
    mock.updates = [
      { stamp: 7, storeNo: STORE_NO, orderId: 123, reachedTheMakeLineTime: '2026-11-11 12:00:00' },
      { stamp: 8, storeNo: STORE_NO, orderId: sync.externalOrderId, reachedTheMakeLineTime: '' },
    ];
    expect(await pollKitchenIntegrations(deps())).toBe(1);
    expect((await syncOf(order.id))?.state).toBe('SENT');
    expect((await orderOf(order.id)).status, 'accepted on the store behalf as any sent order').toBe('PREPARING');
    expect(await ringsFor(ownerUserId)).toBe(before);
    expect(await opsPages(order.id, 'IS in the kitchen')).toBe(1);
    expect(insertsOf(sync.externalOrderId)).toEqual([0]);
  });

  it('[B S3-3] a kitchen event for an UNKNOWN order also confirms it', async () => {
    const { order, sync } = await timedOutOrder();
    expect(await applyKitchenEvents(deps(), await integration(), [event(sync.externalOrderId, 'PACKED', 'Pack')])).toEqual(['applied']);
    expect((await syncOf(order.id))?.state).toBe('SENT');
    expect((await orderOf(order.id)).status).toBe('READY_FOR_PICKUP');
  });

  it('[B S3-3] no sign of it past the verify window: cancelled at the kitchen first, THEN the tablet rings', async () => {
    const before = await ringsFor(ownerUserId);
    const { order, sync } = await timedOutOrder();
    await pastVerifyWindow(sync.id);
    expect(await resolveUnknownKitchenSyncs(deps())).toBeGreaterThanOrEqual(1);
    expect(insertsOf(sync.externalOrderId), 'the insert, then one cancel (every item removed)').toEqual([0, 2]);
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
  });

  it('[B S3-3] the cancel does not go through: still UNKNOWN, never rung; operations told to call the store; retried', async () => {
    const before = await ringsFor(ownerUserId);
    const { order, sync } = await timedOutOrder();
    await pastVerifyWindow(sync.id);
    mock.failNext('/PosInsertOrders', [500, 500, 500, 500]);
    await resolveUnknownKitchenSyncs(deps());
    const after = await syncOf(order.id);
    expect(after?.state).toBe('UNKNOWN');
    expect(after?.lastError).toMatch(/cancel at the kitchen did not go through/);
    expect(await ringsFor(ownerUserId)).toBe(before);
    expect(await opsPages(order.id, 'CALL THE STORE')).toBe(1);
    await pastVerifyWindow(sync.id);
    await resolveUnknownKitchenSyncs(deps());
    expect((await syncOf(order.id))?.state, 'the retried cancel went through').toBe('FALLBACK');
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
  });

  it('[B S3-3] an UNKNOWN order cancelled on Swift: the kitchen is told (harmless if it never had it)', async () => {
    const { order, sync } = await timedOutOrder();
    await new OrderService(app.prisma, app.io).transitionOrderAtomically({
      orderId: order.id, target: 'CANCELLED', allowedFrom: ['PENDING'], changedBy: null, note: 'test cancel',
      cancellation: { by: null, reason: 'test cancel' },
    });
    await propagateKitchenCancellations(deps());
    expect((await syncOf(order.id))?.state).toBe('CANCELLED');
    expect(insertsOf(sync.externalOrderId)).toEqual([0, 2]);
  });

  it('[A S3-1 · B S3-1/S3-2] a row leased by another sender is left alone; one tick at a time', async () => {
    const order = await makeOrder();
    await releaseOnly();
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { state: 'SENDING', leaseUntil: new Date(Date.now() + 60_000) } });
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state, 'not stolen while its lease runs').toBe('SENDING');
    await app.redis.set(KITCHEN_TICK_LOCK, 'another-tick', 'PX', 60_000);
    expect(await runKitchenTick(deps())).toBe('skipped');
    expect(mock.requests).toEqual([]);
    await app.redis.del(KITCHEN_TICK_LOCK);
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { leaseUntil: new Date(Date.now() - 1_000) } });
    expect(await runKitchenTick(deps())).toBe('ran');
    expect(await app.redis.get(KITCHEN_TICK_LOCK), 'the tick released its own lock').toBeNull();
  });

  it('[A S4-4 · B S3-4] the token is reused across sends (one login)', async () => {
    const a = await makeOrder();
    const b = await makeOrder();
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [a.id] });
    await drainKitchenSyncs(deps(), { orderIds: [b.id] });
    expect(mock.count('/PosInsertOrders')).toBe(2);
    expect(mock.count('/login')).toBe(1);
  });

  it('[A S2-2 · owner ruling 12 Nov] a delivery: first name, phone, address (even with numbers retired elsewhere); a pickup: first name only; never the last name', async () => {
    process.env['CALL_RELAY'] = '1';
    process.env['COUNTERPART_PHONES_TO_OLD_APPS'] = '0';
    const order = await makeOrder();
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    const body = mock.inserted.at(-1) as { orders: Array<Record<string, unknown>> };
    expect(body.orders[0]!['phone'], 'the store own driver must reach the customer').toMatch(/^\+592/);
    expect(body.orders[0]).not.toHaveProperty('lastName');
    expect(body.orders[0]).toMatchObject({ firstName: 'Kit', street: '9 Test Street', lat: 6.81, lng: -58.16 });
    const pickup = await makeOrder({ fulfillment: 'PICKUP' });
    await releaseOnly();
    await drainKitchenSyncs(deps(), { orderIds: [pickup.id] });
    const pickupRow = (mock.inserted.at(-1) as { orders: Array<Record<string, unknown>> }).orders[0]!;
    expect(pickupRow['firstName']).toBe('Kit');
    for (const field of ['lastName', 'phone', 'street', 'lat', 'lng', 'carrierInstructions']) expect(pickupRow, field).not.toHaveProperty(field);
  });

  it('[A S3-2] while the switch is off the test and both writing routes are refused (no call, no write)', async () => {
    setEnv(false);
    const before = await integration();
    await expect(testKitchenConnection(app.prisma, vendorId)).rejects.toThrow(/switch/);
    await expect(putKitchenIntegration(app.prisma, vendorId, { enabled: false })).rejects.toMatchObject({ code: 'KITCHEN_SWITCH_OFF' });
    await expect(setKitchenItemNumbers(app.prisma, vendorId, { items: [{ itemId, externalItemNo: '99' }] })).rejects.toMatchObject({ code: 'KITCHEN_SWITCH_OFF' });
    expect((await integration()).enabled).toBe(before.enabled);
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: itemId } })).externalItemNo).toBe('8');
    expect(mock.requests).toEqual([]);
    setEnv(true);
    expect(await testKitchenConnection(app.prisma, vendorId)).toEqual({ ok: true, problem: null });
  });

  it('[B S4-1] the store number cannot change while the kitchen still holds orders', async () => {
    const order = await makeOrder();
    await releaseOnly();
    await expect(putKitchenIntegration(app.prisma, vendorId, { externalStoreNo: STORE_NO + 77 })).rejects.toThrow(/still with the kitchen/);
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
  });

  it('[B S3-7] repeated ETAs past the promise revise it once per slip window', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    await app.prisma.order.update({ where: { id: order.id }, data: { promisedAt: new Date(Date.now() - 60_000) } });
    await app.redis.del(`eta:slip:${order.id}`);
    const int = await integration();
    await applyKitchenEvents(deps(), int, [event(sync.externalOrderId, 'ETA', 'ETA', { etaSeconds: 1_200 })]);
    await applyKitchenEvents(deps(), int, [event(sync.externalOrderId, 'ETA', 'ETA', { etaSeconds: 1_800 })]);
    expect((await orderOf(order.id)).promiseRevisions).toBe(1);
  });

  it('[A S4-6] a kitchen action for an order still being sent waits for its sender', async () => {
    const order = await makeOrder();
    await releaseOnly();
    const sync = (await syncOf(order.id))!;
    await app.prisma.orderIntegrationSync.update({ where: { id: sync.id }, data: { state: 'SENDING', leaseUntil: new Date(Date.now() + 60_000) } });
    expect(await applyKitchenEvents(deps(), await integration(), [event(sync.externalOrderId, 'PACKED', 'Pack')])).toEqual(['unchanged']);
    expect((await orderOf(order.id)).status).toBe('PENDING');
  });

  it('[B S2-1a] the switch turned OFF with orders waiting: the backstop sweep rings every one; no outside call', async () => {
    const queued = [await makeOrder(), await makeOrder()];
    await releaseOnly();
    const accepting = await makeOrder();
    await releaseOnly();
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: accepting.id, provider: 'DRAGONTAIL' } }, data: { state: 'SENT', sentAt: new Date(Date.now() - 60_000) } });
    const inFlight = await makeOrder();
    await releaseOnly();
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: inFlight.id, provider: 'DRAGONTAIL' } }, data: { state: 'SENDING', leaseUntil: new Date(Date.now() + 60_000) } });
    setEnv(false);
    const before = await ringsFor(ownerUserId);
    await kitchenBackstopSweep({ prisma: app.prisma, io: app.io });
    for (const o of queued) expect((await syncOf(o.id))?.state, 'a waiting claim falls back').toBe('FALLBACK');
    expect((await syncOf(accepting.id))?.fallbackAt, 'a sent order not accepted is rung too').toBeTruthy();
    expect((await syncOf(inFlight.id))?.state, 'a send still inside its lease is left to its sender').toBe('SENDING');
    expect(await ringsFor(ownerUserId)).toBe(before + 3);
    expect(mock.requests).toEqual([]);
    await kitchenBackstopSweep({ prisma: app.prisma, io: app.io });
    expect(await ringsFor(ownerUserId), 'once').toBe(before + 3);
  });

  it('[B S2-1b] switch ON: a claim past the time limit is rung by the sweep; a younger one is left to the sender', async () => {
    const old = await makeOrder();
    const young = await makeOrder();
    await releaseOnly();
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: old.id, provider: 'DRAGONTAIL' } }, data: { createdAt: new Date(Date.now() - KITCHEN_STUCK_MS - 1_000) } });
    const before = await ringsFor(ownerUserId);
    await kitchenBackstopSweep({ prisma: app.prisma, io: app.io });
    expect((await syncOf(old.id))?.state).toBe('FALLBACK');
    expect((await syncOf(young.id))?.state).toBe('QUEUED');
    expect(await ringsFor(ownerUserId)).toBe(before + 1);
    await drainKitchenSyncs(deps(), { orderIds: [young.id] });
  });

  it('[A S3-1 · B S3-1] a row leased late in a slow drain keeps its own lease: a parallel tick cannot take it', async () => {
    const a = await makeOrder();
    const b = await makeOrder();
    await releaseOnly();
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    const before = await ringsFor(ownerUserId);
    let seenB: { state: string; leaseUntil: Date | null } | null = null;
    try {
      const syncB = (await syncOf(b.id))!;
      mock.onRequest = async (r) => {
        if (r.path !== '/PosInsertOrders') return;
        const id = (r.body as { orders: Array<{ orderId: number }> }).orders[0]!.orderId;
        if (id !== syncB.externalOrderId) {
          // The first send is slow: 100 s pass (longer than a whole lease) before b is even leased.
          vi.setSystemTime(start + 100_000);
          return;
        }
        // b is being sent now. A parallel tick (no tick lock in this race) and the sweeper look at it.
        await drainKitchenSyncs(deps(), { orderIds: [b.id] });
        await kitchenBackstopSweep({ prisma: app.prisma, io: app.io });
        const row = (await syncOf(b.id))!;
        seenB = { state: row.state, leaseUntil: row.leaseUntil };
      };
      // (A window long enough that the slow first send does not end the drain before b.)
      await drainKitchenSyncs(deps(), { orderIds: [a.id, b.id], until: start + 10 * 60_000 });
    } finally {
      vi.useRealTimers();
      mock.onRequest = null;
    }
    expect(seenB, 'b was sent').not.toBeNull();
    expect(seenB!.state, 'not taken by the parallel tick').toBe('SENDING');
    expect(seenB!.leaseUntil!.getTime(), 'its lease counts from its own start').toBeGreaterThanOrEqual(start + 100_000 + 60_000);
    expect((await syncOf(a.id))?.state).toBe('SENT');
    expect((await syncOf(b.id))?.state).toBe('SENT');
    expect(await ringsFor(ownerUserId), 'nothing rang the tablet').toBe(before);
    expect(mock.count('/PosInsertOrders'), 'each sent once').toBe(2);
  });

  it('[B S3-2] a tick part stops taking work once its window closes', async () => {
    const order = await makeOrder();
    await releaseOnly();
    expect(await drainKitchenSyncs(deps(), { orderIds: [order.id], until: Date.now() - 1 })).toEqual([]);
    expect((await syncOf(order.id))?.state).toBe('QUEUED');
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
  });

  it('[A S4-5] enabling or renumbering hands the audit row its before and after (no person data)', async () => {
    const store = await makeStore(true);
    const facts: Array<Record<string, unknown>> = [];
    const audit = async (_tx: unknown, _id: string, f: Record<string, unknown>) => { facts.push(f); };
    await putKitchenIntegration(app.prisma, store.vendorId, { externalStoreNo: STORE_NO + 41 }, audit);
    await putKitchenIntegration(app.prisma, store.vendorId, { enabled: true }, audit);
    expect(facts).toEqual([
      { enabledBefore: null, enabledAfter: false, storeNoBefore: null, storeNoAfter: STORE_NO + 41, created: true },
      { enabledBefore: false, enabledAfter: true, storeNoBefore: STORE_NO + 41, storeNoAfter: STORE_NO + 41, created: false },
    ]);
  });

  it('[A S4-1] with a replay window set, a webhook whose signed time is stale is refused (nothing applied)', async () => {
    const { order, sync } = await sentOrder('DELIVERY');
    process.env['DRAGONTAIL_WEBHOOK_MAX_AGE_SECONDS'] = '300';
    try {
      const body = JSON.stringify({ time: '2026-01-01 00:00:00', orders: [{ storeNo: STORE_NO, orderId: sync.externalOrderId, action: 'Pack', actionTime: '2026-01-01 00:00:00', deviceId: 'pack1' }] });
      const res = await app.inject({
        method: 'POST', url: `/api/v1/integrations/dragontail/notifications/${integrationId}`,
        payload: body, headers: { 'content-type': 'application/json', 'x-dragontail-shared': WEBHOOK_SECRET },
      });
      expect(res.statusCode).toBe(403);
      expect((await orderOf(order.id)).status).toBe('PREPARING');
    } finally {
      delete process.env['DRAGONTAIL_WEBHOOK_MAX_AGE_SECONDS'];
    }
  });

  it('[scan 1] an UNKNOWN order confirmed by the kitchen at a store that may no longer take new orders: SENT, NOT accepted; rung and paged', async () => {
    const { order, sync } = await timedOutOrder();
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'ADMIN' } });
    const before = await ringsFor(ownerUserId);
    try {
      expect(await applyKitchenEvents(deps(), await integration(), [{ ...event(sync.externalOrderId, 'SEEN', 'OrderUpdate'), at: null }])).toEqual(['applied']);
      const after = (await syncOf(order.id))!;
      expect(after.state, 'the kitchen has it').toBe('SENT');
      expect(after.lastError).toMatch(/not accepted: the store may not take new orders/);
      expect((await orderOf(order.id)).status, 'never accepted past the store gate').toBe('PENDING');
      expect(after.fallbackAt, 'back to the tablet path (a held store follows its own alert rules there)').toBeTruthy();
      expect(await ringsFor(ownerUserId)).toBeGreaterThanOrEqual(before);
      expect(await opsPages(order.id, 'store may not take it')).toBe(1);
    } finally {
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE', suspensionSource: null } });
    }
  });

  it('[scan 1] an action Swift does not act on (a print request) is no proof the order landed', async () => {
    const { order, sync } = await timedOutOrder();
    expect(await applyKitchenEvents(deps(), await integration(), [event(sync.externalOrderId, 'IGNORED', 'PrintRequest')])).toEqual(['ignored']);
    expect((await syncOf(order.id))?.state).toBe('UNKNOWN');
    expect((await orderOf(order.id)).status).toBe('PENDING');
  });

  it('[scan 2] renumbering is refused while an UNKNOWN order exists; send, cancel and events use the number frozen at the claim', async () => {
    const { order, sync } = await timedOutOrder();
    expect(sync.externalStoreNo).toBe(STORE_NO);
    await expect(putKitchenIntegration(app.prisma, vendorId, { externalStoreNo: STORE_NO + 88 })).rejects.toMatchObject({ code: 'KITCHEN_ORDERS_LIVE' });
    // Even if the connection's number moved (by hand), the cancel names the store the order went to ...
    const live = await app.prisma.orderIntegrationSync.findMany({ where: { vendorIntegrationId: integrationId, state: { in: ['QUEUED', 'SENDING', 'SENT', 'UNKNOWN', 'CANCEL_QUEUED'] } }, select: { id: true, state: true } });
    await app.prisma.orderIntegrationSync.updateMany({ where: { id: { in: live.map((r) => r.id) } }, data: { state: 'DONE' } });
    await app.prisma.orderIntegrationSync.update({ where: { id: sync.id }, data: { state: 'UNKNOWN' } });
    await app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { externalStoreNo: STORE_NO + 88 } });
    try {
      // ... events under the new number do not touch it; under its own number they do
      const int = await integration();
      expect(await applyKitchenEvents(deps(), int, [{ ...event(sync.externalOrderId, 'PACKED', 'Pack'), storeNo: STORE_NO + 88 }])).toEqual(['unknown-order']);
      await pastVerifyWindow(sync.id);
      await resolveUnknownKitchenSyncs(deps());
      const cancel = mock.requests.filter((r) => r.path === '/PosInsertOrders').at(-1)!.body as { storeNo: number; orders: Array<{ storeNo: number }>; ordersItems: Array<{ StoreNo: number; ItemsActions: number }> };
      expect(cancel.ordersItems[0]!.ItemsActions).toBe(2);
      expect([cancel.storeNo, cancel.orders[0]!.storeNo, cancel.ordersItems[0]!.StoreNo]).toEqual([STORE_NO, STORE_NO, STORE_NO]);
      expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    } finally {
      await app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { externalStoreNo: STORE_NO } });
      await app.prisma.orderIntegrationSync.updateMany({ where: { id: { in: live.map((r) => r.id) } }, data: { state: 'DONE' } });
    }
  });
});
