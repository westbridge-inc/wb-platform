import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { OUT_OF_STOCK_REASON, PickingService, sweepSubstitutionDeadlines } from '../modules/order/picking.service';
import { OrderService } from '../modules/order/order.service';
import { LAST_ITEM_SWAP_COPY } from '../modules/order/substitution-view';

// ---------------------------------------------------------------------------
// [OOS-FLOW · owner 8 Nov 2026] "i said out of stock in dashboard but customer
// sees it but order doesnt get cancelled nor can they get a replacement".
//
// Prod: a one-item cash pickup order, PREPARING; the store removed its only line
// as out of stock (200), then Ready was refused (409): the order stayed in
// preparation with nothing in it. The rule now: after acceptance NO removal
// empties an order. The last item still coming ends the order through the one
// canonical cancellation seam: the store's removal = the store's decline "Out of
// stock"; the customer's "No thanks" or no answer = a system close. A partial
// removal keeps the order and lowers the total the customer pays.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_620_000_000 + Math.floor(Math.random() * 300_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Oos', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'oos-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

let owner: { userId: string; token: string };
let vendorId: string;
let customer: { userId: string; token: string };
let categoryId: string;

let itemSeq = 0;
const itemName = (prefix: string) => `${prefix} ${(itemSeq += 1)}`;

async function makeItem(name: string, price = 500, stock: number | null = 10) {
  return app.prisma.item.create({
    data: { vendorId, categoryId, name, basePrice: price, isAvailable: true, stockQuantity: stock },
  });
}

async function makeOrder(
  lines: Array<{ itemId: string; name: string; qty: number; price: number }>,
  opts: { status?: string; fulfillment?: 'DELIVERY' | 'PICKUP'; method?: 'CASH' | 'MOBILE_MONEY'; payStatus?: 'PENDING' | 'CAPTURED'; riderId?: string } = {},
) {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const pickup = opts.fulfillment === 'PICKUP';
  const fee = pickup ? 0 : 300;
  return app.prisma.order.create({
    data: {
      orderNumber: `OOS-${nanoid(8)}`,
      orderType: 'GROCERY_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status: (opts.status ?? 'PREPARING') as never,
      fulfillment: pickup ? 'PICKUP' : 'DELIVERY',
      deliveryAddress: pickup ? '1 Oos St (collect)' : 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: subtotal, subtotalMarkup: 0, subtotalCustomer: subtotal,
      deliveryFee: fee, totalAmount: subtotal + fee,
      paymentMethod: opts.method ?? 'CASH',
      ...(opts.payStatus ? { paymentStatus: opts.payStatus as never } : {}),
      acceptedAt: new Date(), preparingAt: new Date(),
      ...(opts.riderId ? { riderId: opts.riderId } : {}),
      items: {
        create: lines.map((l) => ({
          itemId: l.itemId, name: l.name, quantity: l.qty,
          basePrice: l.price, markedUpPrice: l.price, markupAmount: 0,
          totalBase: l.qty * l.price, totalMarkup: 0, totalCustomer: l.qty * l.price,
        })),
      },
    },
    include: { items: true },
  });
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
  });
}

const removeLine = (orderId: string, lineId: string) => inject('POST', `/api/v1/vendor/orders/${orderId}/items/${lineId}/refund-line`, owner.token, {});
const offerSwap = (orderId: string, lineId: string, substituteItemId: string) =>
  inject('POST', `/api/v1/vendor/orders/${orderId}/items/${lineId}/substitute`, owner.token, { substituteItemId });
const decide = (orderId: string, lineId: string, approve: boolean) =>
  inject('POST', `/api/v1/customer/orders/${orderId}/items/${lineId}/substitution`, customer.token, { approve });
const customerView = (orderId: string) => inject('GET', `/api/v1/customer/orders/${orderId}?swapDecisions=v2`, customer.token);

async function latestNotice(userId: string) {
  return app.prisma.notification.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Oos Store ${seq}`, slug: `oos-store-${nanoid(8).toLowerCase()}`, vendorType: 'STORE',
      phone: `+5920008${String(seq).padStart(3, '0')}`, addressLine1: '1 Oos St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Shelves', sortOrder: 0 } });
  categoryId = category.id;
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.stockAdjustment.deleteMany({ where: { item: { vendorId } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('the store removes an item as out of stock after accepting', () => {
  it('the prod case: the only item of a cash pickup order → the order is declined "Out of stock", the customer told, stock back once', async () => {
    const vest = await makeItem(itemName('Vest'), 1500, 4);
    const order = await makeOrder([{ itemId: vest.id, name: vest.name, qty: 1, price: 1500 }], { fulfillment: 'PICKUP' });

    const res = await removeLine(order.id, order.items[0]!.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.subStatus).toBe('REFUNDED');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, statusHistory: true } });
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelledBy).toBe(owner.userId); // the store's decline: the same record a reject writes
    expect(after.cancellationReason).toBe(OUT_OF_STOCK_REASON);
    expect(after.cancelledAt).not.toBeNull();
    expect(after.items[0]!.subStatus).toBe('REFUNDED');
    expect(after.statusHistory.some((row) => row.status === 'CANCELLED' && row.note?.includes(vest.name))).toBe(true);
    // The unit went back exactly once (4 → 5), never twice.
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: vest.id } })).stockQuantity).toBe(5);

    const push = await latestNotice(customer.userId);
    expect(push?.title).toBe('Order declined');
    expect(push?.body).toContain('declined by the store. Out of stock');
    expect(push?.body).toContain('Nothing was charged.');

    // Ready on the closed order: refused as a closed order, not an empty bag.
    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token, {});
    expect(ready.statusCode).not.toBe(200);
    expect(ready.json().error.code).not.toBe('NOTHING_TO_HAND_OVER');
  });

  it('a partial removal keeps the order and lowers the totals both sides read (cash due at the counter)', async () => {
    const a = await makeItem(itemName('Shirt'), 1000);
    const b = await makeItem(itemName('Socks'), 400);
    const order = await makeOrder([
      { itemId: a.id, name: a.name, qty: 2, price: 1000 },
      { itemId: b.id, name: b.name, qty: 1, price: 400 },
    ], { fulfillment: 'PICKUP' });

    const res = await removeLine(order.id, order.items[1]!.id);
    expect(res.statusCode, res.body).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('PREPARING');
    expect(Number(after.subtotalCustomer)).toBe(2000);
    expect(Number(after.totalAmount)).toBe(2000);

    const seen = await customerView(order.id);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().data.totalAmount).toBe(2000);
    const storeSeen = await inject('GET', `/api/v1/vendor/orders/${order.id}`, owner.token);
    expect(Number(storeSeen.json().data.totalAmount)).toBe(2000);

    // The second (now last) item: the order ends instead of going out empty.
    const last = await removeLine(order.id, order.items[0]!.id);
    expect(last.statusCode, last.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
  });

  it('a delivery order a rider already took: the rider is released with their float, and told the store cancelled it', async () => {
    const item = await makeItem(itemName('Cap'), 800, 3);
    const riderUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await app.prisma.rider.create({ data: { userId: riderUser.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', isAvailable: false } });
    const order = await makeOrder([{ itemId: item.id, name: item.name, qty: 1, price: 800 }], { status: 'RIDER_ASSIGNED', riderId: rider.id });
    await app.prisma.rider.update({ where: { id: rider.id }, data: { floatLimit: 100_000, committedFloat: 800, currentOrderId: order.id } });

    const res = await removeLine(order.id, order.items[0]!.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    const freed = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(freed.currentOrderId).toBeNull();
    expect(Number(freed.committedFloat)).toBe(0);
    const told = await app.prisma.notification.findFirst({ where: { userId: riderUser.userId, title: 'Delivery cancelled' } });
    expect(told?.body).toContain(`Order #${order.orderNumber} was cancelled: the store is out of stock.`);
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: order.id } });
    await app.prisma.rider.delete({ where: { id: rider.id } }).catch(() => undefined);
  });

  it('paid MMG: the last item cannot end the order in the app (the reject rule), and nothing changes', async () => {
    const item = await makeItem(itemName('Belt'), 900);
    const order = await makeOrder([{ itemId: item.id, name: item.name, qty: 1, price: 900 }], { method: 'MOBILE_MONEY', payStatus: 'CAPTURED' });
    const res = await removeLine(order.id, order.items[0]!.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MMG_CANCEL_UNAVAILABLE');
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(after.status).toBe('PREPARING');
    expect(after.items[0]!.subStatus).toBe('NONE');
  });

  it('without the cancellation seam the service never empties an order: it tells the store to reject instead', async () => {
    const item = await makeItem(itemName('Scarf'), 700);
    const order = await makeOrder([{ itemId: item.id, name: item.name, qty: 1, price: 700 }]);
    await expect(new PickingService(app.prisma, app.io).refundLine(order.id, order.items[0]!.id, owner.userId))
      .rejects.toMatchObject({ code: 'REJECT_INSTEAD' });
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(after.status).toBe('PREPARING');
    expect(after.items[0]!.subStatus).toBe('NONE');
    expect(Number(after.totalAmount)).toBe(1000);
  });

  it('an order emptied before this fix: Ready says what to do, and never promises a refund', async () => {
    const item = await makeItem(itemName('Tie'), 600);
    const order = await makeOrder([{ itemId: item.id, name: item.name, qty: 1, price: 600 }], { fulfillment: 'PICKUP' });
    await app.prisma.orderItem.update({ where: { id: order.items[0]!.id }, data: { subStatus: 'REFUNDED' } });
    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token, {});
    expect(ready.statusCode).toBe(409);
    expect(ready.json().error.code).toBe('NOTHING_TO_HAND_OVER');
    expect(ready.json().error.message).toContain('Reject the order with the reason "Out of stock"');
    expect(ready.json().error.message).not.toMatch(/refund/i);
    // The store's way out works: reject "Out of stock".
    const rejected = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, owner.token, { reason: OUT_OF_STOCK_REASON });
    expect(rejected.statusCode, rejected.body).toBe(200);
  });
});

describe('the store offers a replacement after accepting', () => {
  it('the only item: the customer is told "no thanks" cancels; approve swaps it and adjusts the total', async () => {
    const orig = await makeItem(itemName('Jacket'), 2000);
    const sub = await makeItem(itemName('Coat'), 2500);
    const order = await makeOrder([{ itemId: orig.id, name: orig.name, qty: 1, price: 2000 }], { fulfillment: 'PICKUP' });
    const offered = await offerSwap(order.id, order.items[0]!.id, sub.id);
    expect(offered.statusCode, offered.body).toBe(200);

    const view = (await customerView(order.id)).json().data.items[0].substitution;
    expect(view).toMatchObject({ kind: 'SWAP', lastItem: true, decisions: { approve: true, reject: true }, settlementGuidance: LAST_ITEM_SWAP_COPY, ifNoAnswer: 'CANCEL' });
    expect(typeof view.decideBy).toBe('string');
    // The push says the same: a yes or the order is cancelled (never "it comes off your order").
    const asked = await latestNotice(customer.userId);
    expect(asked?.body).toContain(`the only item left on order #${order.orderNumber}`);
    expect(asked?.body).toContain('or the order is cancelled. Nothing has been charged.');
    expect(asked?.body).not.toContain('comes off your order');

    const yes = await decide(order.id, order.items[0]!.id, true);
    expect(yes.statusCode, yes.body).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(after.status).toBe('PREPARING');
    expect(after.items[0]!.subStatus).toBe('APPROVED');
    expect(Number(after.totalAmount)).toBe(2500);
  });

  it('the only item: "No thanks" cancels the order as a system close (never the customer\'s), store and customer told', async () => {
    const orig = await makeItem(itemName('Hat'), 1200);
    const sub = await makeItem(itemName('Beanie'), 1100);
    const order = await makeOrder([{ itemId: orig.id, name: orig.name, qty: 1, price: 1200 }]);
    expect((await offerSwap(order.id, order.items[0]!.id, sub.id)).statusCode).toBe(200);

    const no = await decide(order.id, order.items[0]!.id, false);
    expect(no.statusCode, no.body).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelledBy).toBeNull();
    expect(after.cancellationReason).toContain('Out of stock');
    expect(after.items[0]!.subStatus).toBe('REJECTED');
    const push = await latestNotice(customer.userId);
    expect(push?.title).toBe(`Order #${order.orderNumber} cancelled`);
    expect(push?.body).toContain('Nothing was charged.');
    expect((await latestNotice(owner.userId))?.title).toBe(`Order #${order.orderNumber} cancelled`);
  });

  it('not the only item: "No thanks" removes just that line and lowers the total', async () => {
    const a = await makeItem(itemName('Shoe'), 3000);
    const b = await makeItem(itemName('Lace'), 200);
    const sub = await makeItem(itemName('Cord'), 250);
    const order = await makeOrder([
      { itemId: a.id, name: a.name, qty: 1, price: 3000 },
      { itemId: b.id, name: b.name, qty: 1, price: 200 },
    ]);
    expect((await offerSwap(order.id, order.items[1]!.id, sub.id)).statusCode).toBe(200);
    expect((await latestNotice(customer.userId))?.body).toContain('If you don\'t answer, it comes off your order and your total goes down.');
    const view = (await customerView(order.id)).json().data.items.find((i: { id: string }) => i.id === order.items[1]!.id).substitution;
    expect(view.lastItem).toBeUndefined();
    expect(view.ifNoAnswer).toBe('REMOVE');
    expect((await decide(order.id, order.items[1]!.id, false)).statusCode).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('PREPARING');
    expect(Number(after.totalAmount)).toBe(3300);
  });

  it('the only item, no answer in time: the deadline sweep cancels the order (never an empty one)', async () => {
    const orig = await makeItem(itemName('Glove'), 500);
    const sub = await makeItem(itemName('Mitten'), 500);
    const order = await makeOrder([{ itemId: orig.id, name: orig.name, qty: 1, price: 500 }]);
    expect((await offerSwap(order.id, order.items[0]!.id, sub.id)).statusCode).toBe(200);
    const later = new Date(Date.now() + 60 * 60_000);
    const swept = await sweepSubstitutionDeadlines(app.prisma, app.io, {
      now: later,
      orderService: new OrderService(app.prisma, app.io, undefined, undefined, app.redis),
    });
    expect(swept.cancelled).toBeGreaterThanOrEqual(1);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(after.status).toBe('CANCELLED');
    expect(after.cancelledBy).toBeNull();
    expect(after.cancellationReason).toBe(`Out of stock: ${orig.name} was the only item and the customer did not answer in time`);
    expect(after.items[0]!.subStatus).toBe('REFUNDED');
  });

  it('not the only item, no answer in time: the line comes off and the order goes on', async () => {
    const a = await makeItem(itemName('Bag'), 1000);
    const b = await makeItem(itemName('Pin'), 100);
    const sub = await makeItem(itemName('Clip'), 100);
    const order = await makeOrder([
      { itemId: a.id, name: a.name, qty: 1, price: 1000 },
      { itemId: b.id, name: b.name, qty: 1, price: 100 },
    ]);
    expect((await offerSwap(order.id, order.items[1]!.id, sub.id)).statusCode).toBe(200);
    const outcome = await new PickingService(app.prisma, app.io).expireSubstitution(order.items[1]!.id, new Date(Date.now() + 60 * 60_000));
    expect(outcome).toBe('removed');
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('PREPARING');
    expect(Number(after.totalAmount)).toBe(1300);
  });
});
