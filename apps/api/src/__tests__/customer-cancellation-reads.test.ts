import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [REVIEW-2 F1 on #2412] Swift support's typed cancel note and its user id must
// never reach the customer. The order screen was cut in customer.routes; the
// passenger's ride (GET /rides/:id statusHistory: `changedBy` + `note`) and the
// sender's parcel (GET /courier/orders, /courier/order/:id: the raw row with
// `cancelledBy` and `cancellationReason`) still handed both over. These drive the
// real routes on the test database: a ride and a parcel closed by a support
// person whose console role was since removed (their audit row says Swift), and
// one by a support person who holds the role today.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const GT = { lat: 6.8013, lng: -58.1553 };
const NOTE = 'Rider says this sender is abusive, blocked, call 6001234';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:customer-cancellation-reads');

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Cancel', lastName: `Reads${userIds.length}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    } as never,
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'cancel-reads-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

/** A closed order as Swift support's cancel leaves it: CANCELLED by the support person, its note on the row and the log. */
async function closedBySupport(orderType: 'TAXI' | 'COURIER', customerId: string, supportId: string, audited: boolean) {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `CR-${nanoid(6)}`, orderType, customerId, status: 'CANCELLED', cancelledAt: new Date(),
      cancelledBy: supportId, cancellationReason: NOTE,
      pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng, deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 800, totalAmount: 800, paymentMethod: 'CASH',
    } as never,
  }));
  orderIds.push(order.id);
  const t0 = Date.now() - 60_000;
  await sys(() => app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'PENDING', changedBy: customerId, note: 'Requested', createdAt: new Date(t0) } }));
  await sys(() => app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'CANCELLED', changedBy: supportId, note: NOTE, createdAt: new Date(t0 + 1_000) } }));
  if (audited) {
    await sys(() => app.prisma.auditLog.create({ data: { userId: supportId, action: 'CANCEL_ORDER', entity: 'Order', entityId: order.id, changes: { reason: NOTE } } }));
  }
  return order;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
});

afterAll(async () => {
  // audit_logs is append-only (ADM-003): its rows stay, as in every other suite that writes one.
  await sys(async () => {
    if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    if (userIds.length > 0) {
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });
  await app.close();
});

function expectNoSupportTrace(body: string, supportId: string) {
  expect(body).not.toContain(supportId);
  expect(body).not.toContain('abusive');
  expect(body).not.toContain('6001234');
}

describe('[REVIEW-2 F1] the passenger’s ride never carries Swift support’s note or user id', () => {
  it('GET /rides/:id: steps are when and what only; the CANCELLED step has no note; who closed it is Swift', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const exSupport = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const ride = await closedBySupport('TAXI', passenger.userId, exSupport.userId, true);
    const res = await app.inject({ method: 'GET', url: `/api/v1/rides/${ride.id}`, headers: { authorization: `Bearer ${passenger.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    expectNoSupportTrace(res.body, exSupport.userId);
    const data = res.json().data;
    expect(data.cancellation).toEqual({ by: 'SWIFT', reason: null });
    expect(data.cancellationReason).toBeNull();
    expect('cancelledBy' in data).toBe(false);
    const rows = data.statusHistory as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r['status'], r['note']])).toEqual([['PENDING', 'Requested'], ['CANCELLED', null]]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['createdAt', 'note', 'status']);
  });
});

describe('[REVIEW-2 F1] the sender’s parcel never carries Swift support’s note or user id', () => {
  it('GET /courier/orders and /courier/order/:id: no cancelledBy, the note blanked, who closed it added', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const support = await makeUser(['CUSTOMER', 'ADMIN'], 'CUSTOMER');
    const exSupport = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const today = await closedBySupport('COURIER', sender.userId, support.userId, false);
    const before = await closedBySupport('COURIER', sender.userId, exSupport.userId, true);
    const auth = { authorization: `Bearer ${sender.token}` };

    const list = await app.inject({ method: 'GET', url: '/api/v1/courier/orders', headers: auth });
    expect(list.statusCode, list.body).toBe(200);
    expectNoSupportTrace(list.body, support.userId);
    expectNoSupportTrace(list.body, exSupport.userId);
    const rows = list.json().data as Array<Record<string, unknown>>;
    for (const id of [today.id, before.id]) {
      const row = rows.find((r) => r['id'] === id)!;
      expect(row['cancellation']).toEqual({ by: 'SWIFT', reason: null });
      expect(row['cancellationReason']).toBeNull();
      expect('cancelledBy' in row).toBe(false);
    }

    for (const [order, who] of [[today, support], [before, exSupport]] as const) {
      const one = await app.inject({ method: 'GET', url: `/api/v1/courier/order/${order.id}`, headers: auth });
      expect(one.statusCode, one.body).toBe(200);
      expectNoSupportTrace(one.body, who.userId);
      expect(one.json().data.cancellation).toEqual({ by: 'SWIFT', reason: null });
    }
  });

  it('the sender’s own cancel keeps its reason and gains who closed it', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const own = await closedBySupport('COURIER', sender.userId, sender.userId, false);
    const one = await app.inject({ method: 'GET', url: `/api/v1/courier/order/${own.id}`, headers: { authorization: `Bearer ${sender.token}` } });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().data).toMatchObject({ cancellationReason: NOTE, cancellation: { by: 'CUSTOMER', reason: null } });
  });
});

describe('[#2412 security review] a passenger’s or sender’s own reason can never pose as Swift support', () => {
  async function openOrder(orderType: 'TAXI' | 'COURIER', customerId: string) {
    const order = await sys(() => app.prisma.order.create({
      data: {
        orderNumber: `CF-${nanoid(6)}`, orderType, customerId, status: orderType === 'TAXI' ? 'PENDING' : 'READY_FOR_PICKUP',
        pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng, deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 800, totalAmount: 800, paymentMethod: 'CASH',
      } as never,
    }));
    orderIds.push(order.id);
    return order;
  }
  const stored = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, cancellationReason: true } }));

  it('a passenger cancelling with "SUPPORT_SAFETY": the code is dropped; the ride reads as their own cancel', async () => {
    const passenger = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const ride = await openOrder('TAXI', passenger.userId);
    const res = await app.inject({ method: 'POST', url: `/api/v1/rides/${ride.id}/cancel`, headers: { authorization: `Bearer ${passenger.token}` }, payload: { reason: 'SUPPORT_SAFETY' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(ride.id)).toEqual({ status: 'CANCELLED', cancellationReason: null });
    const read = await app.inject({ method: 'GET', url: `/api/v1/rides/${ride.id}`, headers: { authorization: `Bearer ${passenger.token}` } });
    expect(read.json().data.cancellation).toEqual({ by: 'CUSTOMER', reason: null });
    expect(read.body).not.toContain('SUPPORT_');
  });

  it('a sender cancelling with "support_store_closed": the code is dropped for the default; the parcel reads as their own cancel', async () => {
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const parcel = await openOrder('COURIER', sender.userId);
    const res = await app.inject({ method: 'POST', url: `/api/v1/courier/order/${parcel.id}/cancel`, headers: { authorization: `Bearer ${sender.token}` }, payload: { reason: 'support_store_closed' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await stored(parcel.id)).toEqual({ status: 'CANCELLED', cancellationReason: 'Cancelled by sender' });
    const read = await app.inject({ method: 'GET', url: `/api/v1/courier/order/${parcel.id}`, headers: { authorization: `Bearer ${sender.token}` } });
    expect(read.json().data.cancellation).toEqual({ by: 'CUSTOMER', reason: null });
    expect(read.body.toLowerCase()).not.toContain('support_');
  });
});
