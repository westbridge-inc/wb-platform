import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  pollKitchenIntegrations,
  propagateKitchenCancellations,
  type KitchenDeps,
} from '../modules/kitchen/kitchen-sync';
import { kitchenLoginRef, kitchenWebhookRef } from '../modules/kitchen/kitchen-credentials';
import { putKitchenIntegration, getKitchenIntegration, setKitchenItemNumbers } from '../modules/kitchen/kitchen-admin';
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

const deps = (): KitchenDeps => ({ prisma: app.prisma, io: app.io, client: { backoffMs: 1 } });

function setEnv(on: boolean) {
  process.env['DRAGONTAIL_INTEGRATION'] = on ? '1' : '';
  process.env['DRAGONTAIL_API_URL'] = mock.url;
  process.env['DRAGONTAIL_CREDENTIALS'] = JSON.stringify({
    [kitchenLoginRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { userName: 'pos-swift', password: 'pw-swift' },
    [kitchenWebhookRef({ id: integrationId, provider: 'DRAGONTAIL' })]: { webhookSecret: WEBHOOK_SECRET },
  });
  delete process.env['DRAGONTAIL_ACCEPT_ON'];
  delete process.env['DRAGONTAIL_WEBHOOK_CHECK'];
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
  process.env['NODE_ENV'] = 'development';
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
  const view = await putKitchenIntegration(app.prisma, vendorId, { enabled: true, externalStoreNo: STORE_NO });
  integrationId = view.connection!.id;
});

beforeEach(() => {
  mock.reset();
  setEnv(true);
});

afterAll(async () => {
  for (const key of ['DRAGONTAIL_INTEGRATION', 'DRAGONTAIL_API_URL', 'DRAGONTAIL_CREDENTIALS', 'DRAGONTAIL_ACCEPT_ON', 'DRAGONTAIL_WEBHOOK_CHECK']) delete process.env[key];
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
    expect(sent).toMatchObject({ state: 'SENT', attempts: 1, promiseSeconds: mock.promiseTimeSeconds });
    expect(mock.count('/PosInsertOrders')).toBe(1);
    const body = mock.inserted[0] as { orders: Array<Record<string, unknown>>; ordersItems: Array<Record<string, unknown>> };
    expect(body.orders[0]).toMatchObject({ storeNo: STORE_NO, orderId: queued!.externalOrderId, saleType: 2, paymentMethod: 0, cash: 4300, carrierInstructions: 'Blue gate' });
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

  it('a lapsed SENDING lease is never re-sent blind: it falls back to the tablet', async () => {
    const order = await makeOrder();
    await releaseOnly();
    await app.prisma.orderIntegrationSync.update({ where: { orderId_provider: { orderId: order.id, provider: 'DRAGONTAIL' } }, data: { state: 'SENDING', leaseUntil: new Date(Date.now() - 1000) } });
    await drainKitchenSyncs(deps(), { orderIds: [order.id] });
    expect((await syncOf(order.id))?.state).toBe('FALLBACK');
    expect(mock.count('/PosInsertOrders')).toBe(0);
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
    await app.prisma.vendorIntegration.update({ where: { id: integrationId }, data: { lastPolledAt: null, pollUpdateStamp: 0 } });
    mock.updates = [{ stamp: 41, storeNo: STORE_NO, orderId: sync.externalOrderId, reachedTheMakeLineTime: '2026-11-11 12:00:00', packTime: '2026-11-11 12:10:00', dispatchTime: '', deliveryTime: '' }];
    mock.pending = [{ storeNo: STORE_NO, orderId: sync.externalOrderId, action: 'Dispatched', actionTime: '2026-11-11 12:12:00', deviceId: 'dispatch1' }];
    expect(await pollKitchenIntegrations(deps())).toBe(1);
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
      data: { orderId: order.id, vendorIntegrationId: otherConn.connection!.id, provider: 'DRAGONTAIL', externalOrderId: 1_999_999_001, dailyNo: 1 },
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

