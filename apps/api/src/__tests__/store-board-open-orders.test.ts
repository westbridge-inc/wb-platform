import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes, OPEN_BOARD_CAP } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { LIVE_ORDER_STATUSES, TERMINAL_ORDER_STATUSES } from '../modules/order/order-status';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [STORE-BOARD S1 · parity audit 14 Nov 2026, A1] The store's live board could lose an open order.
//
// The app asked GET /vendor/orders with no page size: the server's default page is the newest 20 orders of ANY
// status, and the board then hid the finished ones. An order still cooking, or out for delivery, with 20 newer
// orders behind it silently left the board. The website asked for 100 (capped at 50) — the same hole, later.
//
// GET /vendor/orders/open answers EVERY open order of the store (every non-finished status of the order state
// machine), scoped exactly like GET /vendor/orders (the caller's stores, the selected branch, or scope=all), with
// no silent cap: past OPEN_BOARD_CAP the answer says how many it did not send. GET /vendor/orders is unchanged
// (history pages, and the store app builds already in people's hands).
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
let customerId = '';

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Board', lastName: `Person${userIds.length}`, roles, activeRole, isPhoneVerified: true,
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'board-open', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function makeOwner() {
  const u = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: u.userId } });
  ownerIds.push(vo.id);
  return { ...u, ownerId: vo.id };
}

async function store(ownerId: string, name = `Board Kitchen ${wordFreeTag(5)}`) {
  const v = await app.prisma.vendor.create({ data: {
    ownerId, name, slug: `board-open-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Board Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  vendorIds.push(v.id);
  return v;
}

/** `minutesAgo` sets placedAt, so "newer" is exact. Pickup by default: no rider journal read per row. */
function orderData(vendorId: string, status: OrderStatus, minutesAgo: number, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}): Prisma.OrderUncheckedCreateInput {
  return {
    orderNumber: `BOP-${nanoid(10).replace(/[^a-zA-Z0-9]/g, '0')}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status, fulfillment: 'PICKUP',
    deliveryAddress: '1 Board Street', deliveryLat: 6.8, deliveryLng: -58.15, pickupAddress: '1 Board Street', pickupLat: 6.8, pickupLng: -58.15,
    subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000,
    paymentMethod: 'CASH', placedAt: new Date(Date.now() - minutesAgo * 60_000),
    ...extra,
  };
}
async function order(vendorId: string, status: OrderStatus, minutesAgo: number, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return app.prisma.order.create({ data: orderData(vendorId, status, minutesAgo, extra) });
}
/** Many orders at once; `startMinutesAgo` is the newest, each next one a minute older. */
async function orders(vendorId: string, status: OrderStatus, count: number, startMinutesAgo: number) {
  await app.prisma.order.createMany({ data: Array.from({ length: count }, (_, i) => orderData(vendorId, status, startMinutesAgo + i)) });
}

const put = (token: string, url: string, payload: unknown, vendorId?: string) => app.inject({
  method: 'PUT', url, payload: payload as Record<string, unknown>, headers: { authorization: `Bearer ${token}`, ...(vendorId ? { 'x-vendor-id': vendorId } : {}) },
});
const get = (token: string, url: string, vendorId?: string) => app.inject({
  method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...(vendorId ? { 'x-vendor-id': vendorId } : {}) },
});
type Row = { id: string; status: string; vendorId: string };
const ids = (res: { json: () => { data: Row[] } }) => new Set(res.json().data.map((r) => r.id));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  customerId = customer.userId;
});

afterAll(async () => {
  if (vendorIds.length) {
    await app.prisma.orderStatusLog.deleteMany({ where: { order: { vendorId: { in: vendorIds } } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  }
  if (ownerIds.length) await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  if (userIds.length) {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('[STORE-BOARD S1] the defect: the page the app asked for', () => {
  it('GET /vendor/orders with no page size (the app board\'s call) leaves out an order still cooking behind 20 newer finished orders', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    const cooking = await order(v.id, 'PREPARING', 120);
    await orders(v.id, 'DELIVERED', 20, 1);
    const page = await get(owner.token, '/api/v1/vendor/orders', v.id);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().data).toHaveLength(20);
    // This is the old route's documented behaviour (kept for history pages and old app builds): the open order is
    // not in the page — the board built on it lost the order.
    expect(ids(page).has(cooking.id)).toBe(false);
  });
});

describe('[STORE-BOARD S1] GET /vendor/orders/open — every open order of the store', () => {
  it('the order still cooking behind 20 newer finished orders is on the open board', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    const cooking = await order(v.id, 'PREPARING', 120);
    await orders(v.id, 'DELIVERED', 20, 1);
    const res = await get(owner.token, '/api/v1/vendor/orders/open', v.id);
    expect(res.statusCode, res.body).toBe(200);
    expect([...ids(res)]).toEqual([cooking.id]);
    expect(res.json().meta).toEqual({ total: 1, shown: 1, notShown: 0, cap: OPEN_BOARD_CAP });
  });

  it('every non-finished status of the state machine is open; every finished one is not', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    const live = new Map<string, string>();
    for (const [i, s] of LIVE_ORDER_STATUSES.entries()) live.set((await order(v.id, s, 200 + i)).id, s);
    for (const [i, s] of TERMINAL_ORDER_STATUSES.entries()) await order(v.id, s, 1 + i);
    const res = await get(owner.token, '/api/v1/vendor/orders/open', v.id);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as Row[];
    expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(live);
    // The census: the two sets partition the state machine (a new status must be classified, never skipped).
    expect(LIVE_ORDER_STATUSES.length + TERMINAL_ORDER_STATUSES.length).toBeGreaterThan(20);
  });

  it('more than 20 and more than 50 open orders: all of them, none hidden (60 open behind 25 newer finished)', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    await orders(v.id, 'ACCEPTED', 30, 100);
    await orders(v.id, 'READY_FOR_PICKUP', 30, 200);
    await orders(v.id, 'COMPLETED', 25, 1);
    const res = await get(owner.token, '/api/v1/vendor/orders/open', v.id);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as Row[];
    expect(rows).toHaveLength(60);
    expect(rows.every((r) => r.status === 'ACCEPTED' || r.status === 'READY_FOR_PICKUP')).toBe(true);
    expect(res.json().meta).toEqual({ total: 60, shown: 60, notShown: 0, cap: OPEN_BOARD_CAP });
    // A page size or page number in the address does not shorten the open board.
    const asked = await get(owner.token, '/api/v1/vendor/orders/open?limit=5&page=3', v.id);
    expect(asked.json().data).toHaveLength(60);
  });

  it('past the cap, nothing is silent: the answer says how many it did not send, and decisions (New) are sent first', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    await orders(v.id, 'PREPARING', OPEN_BOARD_CAP, 10);
    // The newest orders are the decisions waiting for Accept: they must never be the ones left out.
    await orders(v.id, 'PENDING', 3, 1);
    const res = await get(owner.token, '/api/v1/vendor/orders/open', v.id);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as Row[];
    expect(rows).toHaveLength(OPEN_BOARD_CAP);
    expect(res.json().meta).toEqual({ total: OPEN_BOARD_CAP + 3, shown: OPEN_BOARD_CAP, notShown: 3, cap: OPEN_BOARD_CAP });
    expect(rows.filter((r) => r.status === 'PENDING')).toHaveLength(3);
  });

  it('a held order (still inside its hold) is not the store\'s yet: not on the open board', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    const held = await order(v.id, 'PENDING', 1, { holdExpiresAt: new Date(Date.now() + 10 * 60_000) });
    const open = await order(v.id, 'PENDING', 2);
    const res = await get(owner.token, '/api/v1/vendor/orders/open', v.id);
    expect(ids(res).has(held.id)).toBe(false);
    expect(ids(res).has(open.id)).toBe(true);
  });

  it('each row is shaped exactly as the board row of GET /vendor/orders (money, store money, answer clock, redaction)', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    const o = await order(v.id, 'PENDING', 1, { fulfillment: 'DELIVERY', deliveryAddress: '2 Door Street', deliveryLat: 6.81, deliveryLng: -58.16, deliveryFee: 500, tipAmount: 300, totalAmount: 2800 });
    const open = (await get(owner.token, '/api/v1/vendor/orders/open', v.id)).json().data as Array<Record<string, unknown>>;
    const page = (await get(owner.token, '/api/v1/vendor/orders', v.id)).json().data as Array<Record<string, unknown>>;
    const a = open.find((r) => r['id'] === o.id);
    const b = page.find((r) => r['id'] === o.id);
    expect(a).toBeTruthy();
    expect(a).toEqual(b);
    expect(typeof a!['totalAmount']).toBe('number');
    expect(a!['storeMoney']).toBeTruthy();
    expect(a!['pickupCode']).toBeUndefined();
  });
});

describe('[STORE-BOARD S1] the open board is scoped exactly like GET /vendor/orders', () => {
  it('another owner\'s open orders never appear, even when the request names their store', async () => {
    const a = await makeOwner();
    const b = await makeOwner();
    const mine = await store(a.ownerId);
    const theirs = await store(b.ownerId);
    const myOrder = await order(mine.id, 'PREPARING', 5);
    const theirOrder = await order(theirs.id, 'PREPARING', 5);
    for (const [url, header] of [['/api/v1/vendor/orders/open', mine.id], ['/api/v1/vendor/orders/open', undefined], ['/api/v1/vendor/orders/open?scope=all', mine.id]] as const) {
      const res = await get(a.token, url, header);
      expect(res.statusCode, `${url} ${header} ${res.body}`).toBe(200);
      expect(ids(res).has(myOrder.id), url).toBe(true);
      expect(ids(res).has(theirOrder.id), url).toBe(false);
    }
    // A store the caller does not work in is never selected (pickVendorId falls back to the caller's own store, as
    // on every vendor read): the answer is the caller's own board, the same as GET /vendor/orders gives.
    const spoof = await get(a.token, '/api/v1/vendor/orders/open', theirs.id);
    expect(spoof.body).not.toContain(theirOrder.id);
    expect(ids(spoof)).toEqual(new Set([myOrder.id]));
    expect((await get(a.token, '/api/v1/vendor/orders', theirs.id)).body).not.toContain(theirOrder.id);
  });

  it('one branch selected: that branch only; scope=all: every branch of this login; no header: every branch (as GET /vendor/orders)', async () => {
    const owner = await makeOwner();
    const north = await store(owner.ownerId);
    const south = await store(owner.ownerId);
    const n = await order(north.id, 'ACCEPTED', 3);
    const s = await order(south.id, 'ACCEPTED', 3);
    expect(ids(await get(owner.token, '/api/v1/vendor/orders/open', north.id))).toEqual(new Set([n.id]));
    expect(ids(await get(owner.token, '/api/v1/vendor/orders/open?scope=all', north.id))).toEqual(new Set([n.id, s.id]));
    const none = ids(await get(owner.token, '/api/v1/vendor/orders/open'));
    const legacy = ids(await get(owner.token, '/api/v1/vendor/orders'));
    expect(none).toEqual(new Set([n.id, s.id]));
    expect(none).toEqual(legacy);
  });

  it('staff of one branch see that branch\'s open board and nothing of the other branch', async () => {
    const owner = await makeOwner();
    const north = await store(owner.ownerId);
    const south = await store(owner.ownerId);
    const n = await order(north.id, 'PREPARING', 3);
    const s = await order(south.id, 'PREPARING', 3);
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    const res = await get(member.token, '/api/v1/vendor/orders/open', north.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(ids(res)).toEqual(new Set([n.id]));
    const all = await get(member.token, '/api/v1/vendor/orders/open?scope=all', north.id);
    expect(ids(all).has(s.id)).toBe(false);
    // Naming the branch they do not work in still answers only their own branch.
    const other = await get(member.token, '/api/v1/vendor/orders/open', south.id);
    expect(ids(other)).toEqual(new Set([n.id]));
  });

  it('a signed-in customer with no store is refused', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await get(c.token, '/api/v1/vendor/orders/open');
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('[STORE-PREP · owner ruling 14 Nov 2026] the usual preparation time the app and website cards set', () => {
  it('the owner and a manager set it (PUT /vendor/profile estimatedPrepTime); staff cannot; it must be a sane number of minutes', async () => {
    const owner = await makeOwner();
    const v = await store(owner.ownerId);
    const ok = await put(owner.token, '/api/v1/vendor/profile', { estimatedPrepTime: 45 }, v.id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } })).estimatedPrepTime).toBe(45);
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: v.id, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } });
    expect((await put(manager.token, '/api/v1/vendor/profile', { estimatedPrepTime: 20 }, v.id)).statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } })).estimatedPrepTime).toBe(20);
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: v.id, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } });
    expect((await put(staff.token, '/api/v1/vendor/profile', { estimatedPrepTime: 60 }, v.id)).statusCode).toBe(403);
    expect((await put(owner.token, '/api/v1/vendor/profile', { estimatedPrepTime: 481 }, v.id)).statusCode).toBe(400);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } })).estimatedPrepTime).toBe(20);
    // The profile read the cards draw from carries it.
    const profile = await get(owner.token, '/api/v1/vendor/profile', v.id);
    expect((profile.json().data.vendors as Array<{ id: string; estimatedPrepTime: number }>).find((s) => s.id === v.id)?.estimatedPrepTime).toBe(20);
  });
});
