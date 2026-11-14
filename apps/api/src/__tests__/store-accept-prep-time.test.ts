import { beforeEach, describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerTenantHeaderScope } from '../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { hashVelocityId } from '../modules/integrity/velocity';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { freshOrderPlaceBudget } from './helpers/order-place-budget';

// ---------------------------------------------------------------------------
// [APP-PREPTIME · owner 14 Nov 2026] Staff accept with a preparation time (10
// to 60 minutes) on the website AND on the store app (tablet). Both send the
// same field on PUT /vendor/orders/:id/accept: { estimatedPrepTime }. The API
// stores it on the order on the accept's own locked commit, the store's and
// the customer's order reads carry it, and the time the clients pre-select
// lands when the staff do not change it ([ROUND 2 · owner 14 Nov] the store's
// own declared prep time, or the closest choice). A body with no minutes keeps the
// time the order was placed with (the store's declared prep time); a time
// outside 1..480 whole minutes is refused and the order stays waiting.
// Real customer + vendor routes, the production request composition.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920337';
const FIXTURE = 'app-preptime-accept-fixture';
const CLIENT_IP = '10.20.33.7';
const DAY = 24 * 60 * 60 * 1000;
const HOME = { lat: 6.8045, lng: -58.1553 };
const STORE = { lat: 6.8013, lng: -58.1551 };

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
let customer: Actor;
let owner: Actor;
let vendorId: string;
let itemId: string;

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Prep${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `apt-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url, remoteAddress: CLIENT_IP,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  } as InjectOptions);
}
const store = () => ({ 'x-vendor-id': vendorId });
const orderRow = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
async function placeOrder(fulfillment: 'DELIVERY' | 'PICKUP' = 'PICKUP') {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const body = { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: fulfillment } };
  const res = await call('POST', '/api/v1/customer/checkout', customer.token, body, { 'idempotency-key': `apt-${nanoid(10)}` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as { order: { id: string } }).order.id;
}
/** The store's Accept, with the body the website / app sends (undefined = no body at all). */
const accept = (orderId: string, body?: unknown) => call('PUT', `/api/v1/vendor/orders/${orderId}/accept`, owner.token, body, store());
const customerView = async (orderId: string) => {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown>;
};
const storeView = async (orderId: string) => {
  const res = await call('GET', `/api/v1/vendor/orders/${orderId}`, owner.token, undefined, store());
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown>;
};

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const orderIds = (await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }] }, select: { id: true } })).map((o) => o.id);
    const sessionIds = (await app.prisma.session.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((s) => s.id);
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: [...orderIds, ...vendorIds] } }, { userId: { in: ids } }] }, 'APP-PREPTIME accept fixture cleanup');
    await app.prisma.supportTicket.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { userId: { in: ids } }] } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    const wanted = new Set([...ids, ...sessionIds, ...vendorIds, ...orderIds, ...[...ids, CLIENT_IP].map((a) => hashVelocityId(a))]);
    let cursor = '0';
    do {
      const [next, keys] = await app.redis.scan(cursor, 'COUNT', 1000);
      cursor = next;
      const mine = keys.filter((k) => k.split(':').some((part) => wanted.has(part)));
      if (mine.length > 0) await app.redis.del(...mine);
    } while (cursor !== '0');
  });
}

beforeEach(() => freshOrderPlaceBudget(app.redis));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerTenantHeaderScope(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await purgeFixtures();

  customer = await makeUser('Rani', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '9 Prep Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
  }));
  owner = await makeUser('Ravi', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  vendorId = (await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: 'Prep Diner', slug: `apt-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: 'Diner Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    },
  }))).id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } }));
  itemId = (await sys(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Cook-up', basePrice: 2500, isAvailable: true } }))).id;
});

afterAll(async () => {
  try { await purgeFixtures(); } finally { await app.close(); }
});

describe('[APP-PREPTIME] Accept with a preparation time: the website and the store app send the same field', () => {
  it('a chosen 20: stored on the order, in the answer, and on both order reads', async () => {
    const orderId = await placeOrder();
    expect((await orderRow(orderId)).estimatedPrepTime).toBe(30); // placed with the store's declared time
    const res = await accept(orderId, { estimatedPrepTime: 20 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: orderId, estimatedPrepTime: 20 });
    const row = await orderRow(orderId);
    expect(row.estimatedPrepTime).toBe(20);
    expect(row.acceptedAt).toBeInstanceOf(Date);
    expect(['ACCEPTED', 'PREPARING']).toContain(row.status);
    expect((await storeView(orderId))['estimatedPrepTime']).toBe(20);
    expect((await customerView(orderId))['estimatedPrepTime']).toBe(20);
  });

  it('every choice on the screens (10, 15, 30, 45, 60) is stored as chosen', async () => {
    for (const minutes of [10, 15, 30, 45, 60]) {
      const orderId = await placeOrder();
      const res = await accept(orderId, { estimatedPrepTime: minutes });
      expect(res.statusCode, res.body).toBe(200);
      expect((await orderRow(orderId)).estimatedPrepTime).toBe(minutes);
    }
  });

  it('a delivery order takes the chosen time too', async () => {
    const orderId = await placeOrder('DELIVERY');
    const res = await accept(orderId, { estimatedPrepTime: 45 });
    expect(res.statusCode, res.body).toBe(200);
    expect((await orderRow(orderId)).estimatedPrepTime).toBe(45);
  });

  it('no minutes (a booking, an older app): the time the order was placed with stays', async () => {
    const bare = await placeOrder();
    expect((await accept(bare)).statusCode).toBe(200);
    expect((await orderRow(bare)).estimatedPrepTime).toBe(30);
    const empty = await placeOrder();
    expect((await accept(empty, {})).statusCode).toBe(200);
    expect((await orderRow(empty)).estimatedPrepTime).toBe(30);
  });

  it('a time outside 1..480 whole minutes is refused and the order stays waiting, untouched', async () => {
    for (const bad of [0, 481, 12.5, '20']) {
      const orderId = await placeOrder();
      const res = await accept(orderId, { estimatedPrepTime: bad });
      expect(res.statusCode, `${bad}: ${res.body}`).toBe(400);
      const row = await orderRow(orderId);
      expect(row.status).toBe('PENDING');
      expect(row.estimatedPrepTime).toBe(30);
      expect(row.acceptedAt).toBeNull();
    }
  });
});
