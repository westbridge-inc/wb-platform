import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService } from '../modules/notification/notification.service';
import { loadStoreMoney } from '../modules/billing/store-money';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [STORE-MONEY · owner bug 11 Nov 2026] When a customer tips the rider, the store's ringing new-order screen showed a
// total with the rider's tip (and delivery fee) in it. Every store-facing order read now carries the server's
// `storeMoney` (billing/store-money.ts, the sales statement's law), and the store's new-order push names the store's
// food money — never the tip.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token = '';
let ownerUserId = '';
let vendorId = '';
let customerId = '';
const userIds: string[] = [];
const orderIds: string[] = [];
let promoId = '';

async function makeOrder(over: Record<string, unknown> = {}) {
  const o = await app.prisma.order.create({ data: {
    orderNumber: `SMN-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'PENDING', fulfillment: 'DELIVERY',
    deliveryAddress: '1 Door Street', deliveryLat: 6.81, deliveryLng: -58.16, pickupAddress: 'store', pickupLat: 6.8, pickupLng: -58.15,
    subtotalBase: 4000, subtotalMarkup: 0, subtotalCustomer: 4000, deliveryFee: 500, tipAmount: 300, totalAmount: 4800,
    paymentMethod: 'CASH', ...over,
  } });
  orderIds.push(o.id);
  return o;
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Money', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
  } });
  ownerUserId = owner.id;
  userIds.push(owner.id);
  token = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token, refreshToken: nanoid(48), deviceId: 'smn', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: 'Money Kitchen', slug: `smn-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Money Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  vendorId = vendor.id;
  const customer = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Tipping', lastName: 'Customer', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} },
  } });
  customerId = customer.id;
  userIds.push(customer.id);
  const promo = await app.prisma.promoCode.create({ data: {
    code: `SMN${nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, description: 'fixture', discountType: 'FIXED_AMOUNT', discountValue: 400,
    validFrom: new Date(Date.now() - 86_400_000), validUntil: new Date(Date.now() + 86_400_000), isActive: false,
  } });
  promoId = promo.id;
});

afterAll(async () => {
  await app.prisma.alertDelivery.deleteMany({ where: { subjectId: { in: orderIds } } }).catch(() => {});
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.promoRedemption.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.promoCode.deleteMany({ where: { id: promoId } }).catch(() => {});
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: ownerUserId } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[STORE-MONEY] store order reads carry the store\'s own money', () => {
  it('a tipped Swift-rider cash order: board and detail say food $4,000, the rider\'s $800 not yours', async () => {
    const o = await makeOrder();
    const detail = await get(`/api/v1/vendor/orders/${o.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const money = detail.json().data.storeMoney;
    expect(money).toMatchObject({ food: 4000, delivery: 'SWIFT_RIDER', payment: 'CASH', riderFeeAndTip: 800, yoursFeeAndTip: 0, customerPaysYou: null });
    expect(money.lines).toEqual(["Rider's delivery fee & tip: $800 (not yours)"]);

    const board = await get('/api/v1/vendor/orders');
    expect(board.statusCode, board.body).toBe(200);
    const row = (board.json().data as Array<{ id: string; storeMoney: unknown }>).find((r) => r.id === o.id);
    expect(row?.storeMoney).toEqual(money);
  });

  it('an MMG order with a Swift rider: the customer pays the store $4,800, $800 of it the rider\'s', async () => {
    const o = await makeOrder({ paymentMethod: 'MOBILE_MONEY' });
    const money = (await get(`/api/v1/vendor/orders/${o.id}`)).json().data.storeMoney;
    expect(money).toMatchObject({ food: 4000, payment: 'MMG', customerPaysYou: 4800, riderFeeAndTip: 800 });
    expect(money.lines).toEqual(["Customer pays you $4,800 by MMG — $800 of it is the rider's, pay it at pickup"]);
  });

  it('the store\'s own rider delivers: the fee and tip are the store\'s', async () => {
    const o = await makeOrder({ fulfillmentMode: 'VENDOR_DELIVERY' });
    const money = (await get(`/api/v1/vendor/orders/${o.id}`)).json().data.storeMoney;
    expect(money).toMatchObject({ food: 4000, delivery: 'STORE_RIDER', yoursFeeAndTip: 800, riderFeeAndTip: 0 });
  });

  it('a pickup: the food only', async () => {
    const o = await makeOrder({ fulfillment: 'PICKUP', deliveryFee: 0, tipAmount: 0, totalAmount: 4000 });
    const money = (await get(`/api/v1/vendor/orders/${o.id}`)).json().data.storeMoney;
    expect(money).toMatchObject({ food: 4000, delivery: 'PICKUP', lines: [] });
  });

  it('a Swift-funded goods discount: the food stays whole, "Swift pays you" names that part (from the redemption snapshot)', async () => {
    const o = await makeOrder({ discount: 400, totalAmount: 4400 });
    await app.prisma.promoRedemption.create({ data: {
      orderId: o.id, promoCodeId: promoId, termsVersion: 1, discountType: 'FIXED_AMOUNT', discountValue: 400, funder: 'PLATFORM', goodsDiscount: 400, deliveryDiscount: 0,
    } });
    const detail = (await get(`/api/v1/vendor/orders/${o.id}`)).json().data;
    expect(detail.storeMoney).toMatchObject({ food: 4000, swiftPaysYou: 400 });
    expect(detail.storeMoney.lines).toContain('Swift pays you $400 (a Swift discount the customer got)');
    expect(detail.promoRedemption, 'the snapshot is read, never shipped').toBeUndefined();
  });
});

describe('[STORE-MONEY] the store\'s new-order push never shows the rider\'s tip as store money', () => {
  it('the push and the alert event carry the food, not the customer\'s total', async () => {
    const o = await makeOrder();
    const notifications = new NotificationService(app.prisma, app.io);
    const money = await loadStoreMoney(app.prisma, o.id);
    await notifications.newOrderForVendor(ownerUserId, o.orderNumber, 2, money!, o.id);
    const row = await app.prisma.notification.findFirst({
      where: { userId: ownerUserId, AND: [{ data: { path: ['kind'], equals: 'vendor_order_alert' } }, { data: { path: ['orderId'], equals: o.id } }] },
    });
    expect(row!.body).toBe(`Order ${o.orderNumber} — 2 item(s). Food: $4,000 GYD`);
    expect(row!.body).not.toContain('4,800');
  });

  it('both callers (checkout and the hold release) hand the push the store\'s money, never order.totalAmount', () => {
    const src = readFileSync(join(__dirname, '../modules/order/order.service.ts'), 'utf8');
    const calls = src.split('this.notifications.newOrderForVendor(').slice(1).map((rest) => rest.slice(0, rest.indexOf(');')));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).not.toContain('totalAmount');
      expect(call).toContain('loadStoreMoney(this.prisma, order.id)');
    }
  });
});
