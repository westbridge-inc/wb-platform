import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerTenantHeaderScope } from '../plugins/tenant-header-scope';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { loginWithOtp } from './helpers/otp';
import { injectWithApproval } from './helpers/admin-approval';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [COORD ruling 8 Nov 2026 on #2412] Swift support's cancel says two things,
// kept apart: what the customer sees (one fixed reason the operator picks) and
// an internal note (the operator's own words, Swift only). The note used to be
// the order's `cancellationReason`, its history step's note and the customer's
// push ("Your order … has been cancelled. <note>"). Now it lives only on the
// audit record. These drive the real admin cancel and every customer read on
// the test database, for a store order, an older console's call, a ride and a
// parcel, and look for the note in every customer channel: the notification
// row (the push is sent from it: NotificationService.publishPersisted reads
// its title and body), the order, ride and parcel reads, the order row and its
// history. The audit row is the one place it is kept.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const GT = { lat: 6.8013, lng: -58.1553 };
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:admin-cancel-internal-note');
const MARK = `NOTE${nanoid(6).replace(/[^a-zA-Z0-9]/g, '0')}`;
/** The operator's own words: what Swift must never tell the customer or the store. */
const NOTE = `${MARK} store owner says this customer is a scammer, call him on 6001234`;

let app: FastifyInstance;
let adminToken: string;
let vendorId: string;
const userIds: string[] = [];
const orderIds: string[] = [];

async function makeCustomer() {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Note', lastName: `Keep${userIds.length}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', customer: { create: {} },
    } as never,
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'admin-cancel-note-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token };
}

async function makeOrder(customerId: string, kind: 'FOOD' | 'TAXI' | 'COURIER') {
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `ACN-${nanoid(8)}`, customerId,
      orderType: kind === 'FOOD' ? 'FOOD_DELIVERY' : kind,
      status: kind === 'FOOD' ? 'ACCEPTED' : kind === 'TAXI' ? 'PENDING' : 'READY_FOR_PICKUP',
      ...(kind === 'FOOD' ? { vendorId } : {}),
      pickupAddress: 'A', pickupLat: GT.lat, pickupLng: GT.lng,
      deliveryAddress: 'B', deliveryLat: 6.8143, deliveryLng: -58.1443,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    } as never,
  }));
  orderIds.push(order.id);
  return order;
}

const cancel = (id: string, payload: Record<string, unknown>, headers: Record<string, string> = { 'x-swift-reason': NOTE }) =>
  injectWithApproval(app, {
    method: 'PUT', url: `/api/v1/admin/orders/${id}/cancel`,
    headers: { ...headers, authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload,
  });

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

/** Every customer channel this order reaches: no trace of the internal note. */
async function expectNoteNowhereForCustomer(orderId: string, customer: { userId: string; token: string }, reads: string[]) {
  const told = await sys(() => app.prisma.notification.findMany({ where: { userId: customer.userId }, select: { title: true, body: true, data: true } }));
  expect(told.length).toBeGreaterThan(0);
  expect(JSON.stringify(told)).not.toContain(MARK);
  for (const url of reads) {
    const res = await get(url, customer.token);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    expect(res.body, url).not.toContain(MARK);
    expect(res.body, url).not.toContain('6001234');
  }
  const row = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { cancellationReason: true } }));
  expect(row.cancellationReason ?? '').not.toContain(MARK);
  const steps = await sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId }, select: { note: true } }));
  expect(JSON.stringify(steps)).not.toContain(MARK);
  return told;
}

/** The one place the note is kept: Swift's own audit row for the cancel. */
async function expectNoteOnTheAuditRecord(orderId: string, customerReason: string) {
  const trail = await sys(() => app.prisma.auditLog.findMany({ where: { entityId: orderId, action: 'CANCEL_ORDER' }, select: { changes: true } }));
  expect(trail).toHaveLength(1);
  expect(trail[0]!.changes).toMatchObject({ reason: NOTE, customerReason });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerTenantHeaderScope(app);
  await registerAuthRoutes(app);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();

  const admin = await sys(() => app.prisma.user.create({
    data: { phone: testPhone(), firstName: 'Note', lastName: 'Admin', roles: ['ADMIN'] as UserRole[], activeRole: 'ADMIN', isPhoneVerified: true } as never,
  }));
  userIds.push(admin.id);
  adminToken = (await loginWithOtp(app, admin.phone)).json().data.tokens.accessToken;
  const vendors = await sys(() => app.prisma.vendor.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 1 }));
  if (!vendors[0]) throw new Error('seeded ACTIVE vendor required');
  vendorId = vendors[0].id;
});

afterAll(async () => {
  await sys(async () => {
    if (orderIds.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    if (userIds.length > 0) {
      await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: orderIds } }] }, 'test-cleanup:admin-cancel-internal-note');
      await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });
  await app.close();
});

describe('[COORD 8 Nov 2026] Swift support’s internal note never reaches the customer', () => {
  it('a store order: the customer is told the fixed reason, everywhere; the note stays on Swift’s audit record', async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.userId, 'FOOD');
    const res = await cancel(order.id, { customerReason: 'SUPPORT_STORE_CLOSED' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(MARK);

    const row = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, cancellationReason: true } }));
    expect(row).toEqual({ status: 'CANCELLED', cancellationReason: 'SUPPORT_STORE_CLOSED' });
    const step = await sys(() => app.prisma.orderStatusLog.findFirstOrThrow({ where: { orderId: order.id, status: 'CANCELLED' }, select: { note: true } }));
    expect(step.note).toBe('Cancelled by Swift support');

    const told = await expectNoteNowhereForCustomer(order.id, customer, ['/api/v1/customer/orders', `/api/v1/customer/orders/${order.id}`]);
    expect(told.map((n) => n.body)).toContain(`Order ${order.orderNumber}: Swift support cancelled this order because the store is closed.`);
    const detail = (await get(`/api/v1/customer/orders/${order.id}`, customer.token)).json().data;
    expect(detail.cancellation).toEqual({ by: 'SWIFT', reason: 'SUPPORT_STORE_CLOSED' });
    await expectNoteOnTheAuditRecord(order.id, 'SUPPORT_STORE_CLOSED');
  });

  it('an older console sending only `reason`: that is the internal note; the customer is told only that Swift support cancelled it', async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.userId, 'FOOD');
    const res = await cancel(order.id, { reason: NOTE }, {});
    expect(res.statusCode, res.body).toBe(200);
    const row = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { cancellationReason: true } }));
    expect(row.cancellationReason).toBe('SUPPORT_OTHER');
    const told = await expectNoteNowhereForCustomer(order.id, customer, ['/api/v1/customer/orders', `/api/v1/customer/orders/${order.id}`]);
    expect(told.map((n) => n.body)).toContain(`Order ${order.orderNumber}: Swift support cancelled this order.`);
    await expectNoteOnTheAuditRecord(order.id, 'SUPPORT_OTHER');
  });

  it('a fixed reason outside the list is refused, and nothing changes', async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.userId, 'FOOD');
    const res = await cancel(order.id, { customerReason: NOTE });
    expect(res.statusCode).toBe(400);
    const row = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } }));
    expect(row.status).toBe('ACCEPTED');
  });

  it('a ride: the passenger’s push and ride screen say the fixed reason, never the note', async () => {
    const passenger = await makeCustomer();
    const ride = await makeOrder(passenger.userId, 'TAXI');
    const res = await cancel(ride.id, { customerReason: 'SUPPORT_SAFETY' });
    expect(res.statusCode, res.body).toBe(200);
    const told = await expectNoteNowhereForCustomer(ride.id, passenger, [`/api/v1/rides/${ride.id}`]);
    expect(told.map((n) => n.body)).toContain('Swift support cancelled this ride because of a safety concern. There is no fee. If you have a question, open Get Help.');
    expect((await get(`/api/v1/rides/${ride.id}`, passenger.token)).json().data.cancellation).toEqual({ by: 'SWIFT', reason: 'SUPPORT_SAFETY' });
    await expectNoteOnTheAuditRecord(ride.id, 'SUPPORT_SAFETY');
  });

  it('a parcel: the sender’s push and parcel screens say the fixed reason, never the note', async () => {
    const sender = await makeCustomer();
    const parcel = await makeOrder(sender.userId, 'COURIER');
    const res = await cancel(parcel.id, { customerReason: 'SUPPORT_DELIVERY_NOT_POSSIBLE' });
    expect(res.statusCode, res.body).toBe(200);
    const told = await expectNoteNowhereForCustomer(parcel.id, sender, ['/api/v1/courier/orders', `/api/v1/courier/order/${parcel.id}`]);
    expect(told.map((n) => n.body)).toContain(`Order ${parcel.orderNumber}: Swift support cancelled this request because the delivery is not possible.`);
    expect((await get(`/api/v1/courier/order/${parcel.id}`, sender.token)).json().data.cancellation).toEqual({ by: 'SWIFT', reason: 'SUPPORT_DELIVERY_NOT_POSSIBLE' });
    await expectNoteOnTheAuditRecord(parcel.id, 'SUPPORT_DELIVERY_NOT_POSSIBLE');
  });

  it('nobody at all is sent the note: no notification row anywhere carries it', async () => {
    const anywhere = await sys(() => app.prisma.notification.count({ where: { body: { contains: MARK } } }));
    expect(anywhere).toBe(0);
  });
});
