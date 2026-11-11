import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Prisma, UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { parseCsv } from '../utils/csv';
import { ORDER_EXPORT_AUDIT_ACTION, ORDER_EXPORT_COLUMNS, guyanaStamp } from '../modules/vendor/order-export';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [ORDER-EXPORT · owner 11 Nov 2026] GET /vendor/orders/export — a store's order
// history as a CSV for finance reconciliation.
//  - owner and manager only (staff 403: staff never see revenue);
//  - one branch, or every branch the caller may see sales for (branch=all);
//  - never another owner's store, never an order outside the range;
//  - finance columns only, no customer name / phone / address / note;
//  - formula-safe text cells; a range of at most 366 Guyana days;
//  - an audit row for each export (who, range, branches).
// ---------------------------------------------------------------------------

const DAY = 864e5;
let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
const ownerIds: string[] = [];
const orderIds: string[] = [];
const promoIds: string[] = [];

// Fixed Guyana days, well inside the past: 1-10 Oct 2026.
const IN_RANGE = new Date('2026-10-05T15:30:00.000Z'); // 11:30 in Guyana
const BEFORE = new Date('2026-09-30T03:59:00.000Z'); // 23:59 on 29 Sep in Guyana
const RANGE = 'from=2026-10-01&to=2026-10-10';

const CUSTOMER_FIRST = `Zelda${wordFreeTag(6)}`;
const CUSTOMER_LAST = `Quill${wordFreeTag(6)}`;
const ADDRESS = `77 Secret Lane ${wordFreeTag(6)}`;
const NOTE = `ring the bell ${wordFreeTag(6)}`;
let customerPhone = '';

async function makeUser(roles: UserRole[], activeRole: UserRole, first = 'Export', last = `Person${userIds.length}`) {
  const phone = testPhone();
  const user = await app.prisma.user.create({ data: {
    phone, firstName: first, lastName: last, roles, activeRole, isPhoneVerified: true,
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'order-export', deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token, phone };
}

async function store(ownerId: string, name: string) {
  const v = await app.prisma.vendor.create({ data: {
    ownerId, name, slug: `order-export-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Export Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  vendorIds.push(v.id);
  return v;
}

async function order(vendorId: string, customerId: string, extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const o = await app.prisma.order.create({ data: {
    orderNumber: `OEX-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'DELIVERED', fulfillment: 'DELIVERY',
    deliveryAddress: ADDRESS, deliveryLat: 6.81, deliveryLng: -58.16, deliveryInstructions: NOTE,
    pickupAddress: '1 Export Street', pickupLat: 6.8, pickupLng: -58.15,
    subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, tipAmount: 100, discount: 0, totalAmount: 2600,
    paymentMethod: 'CASH', placedAt: IN_RANGE,
    ...extra,
  } });
  orderIds.push(o.id);
  return o;
}

const get = (token: string, url: string, vendorId?: string) => app.inject({
  method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...(vendorId ? { 'x-vendor-id': vendorId } : {}) },
});

/** The CSV as rows of objects keyed by the header. */
function rowsOf(body: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(body.replace(/^\uFEFF/, ''));
  return rows.map((cells) => Object.fromEntries(header!.map((h, i) => [h, cells[i] ?? ''])));
}

let owner: Awaited<ReturnType<typeof makeUser>>;
let customer: Awaited<ReturnType<typeof makeUser>>;
let north: { id: string; name: string };
let camp: { id: string; name: string };
let foreign: { id: string };
let northDelivered: { id: string; orderNumber: string };
let campMmg: { id: string; orderNumber: string };
let northCancelled: { id: string; orderNumber: string };
let northInjected: { id: string; orderNumber: string };
let northBefore: { id: string };
let foreignOrder: { id: string };
let heldOrder: { id: string };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  ownerIds.push(vo.id);
  north = await store(vo.id, `Royal North ${wordFreeTag(5)}`);
  camp = await store(vo.id, `+Camp ${wordFreeTag(5)}`); // a name a spreadsheet would read as a formula

  const other = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const ovo = await app.prisma.vendorOwner.create({ data: { userId: other.userId } });
  ownerIds.push(ovo.id);
  foreign = await store(ovo.id, `Other Owner ${wordFreeTag(5)}`);

  customer = await makeUser(['CUSTOMER'], 'CUSTOMER', CUSTOMER_FIRST, CUSTOMER_LAST);
  customerPhone = customer.phone;

  const promo = await app.prisma.promoCode.create({ data: {
    code: `OEX${wordFreeTag(6).toUpperCase()}`, description: 'export test', vendorId: north.id, discountType: 'FIXED_AMOUNT',
    discountValue: 200, applicableTo: ['FOOD_DELIVERY'], validFrom: new Date(Date.now() - 400 * DAY), validUntil: new Date(Date.now() + DAY),
    funder: 'VENDOR',
  } });
  promoIds.push(promo.id);

  northDelivered = await order(north.id, customer.userId, {
    acceptedAt: new Date(IN_RANGE.getTime() + 60_000), readyAt: new Date(IN_RANGE.getTime() + 20 * 60_000),
    deliveredAt: new Date(IN_RANGE.getTime() + 45 * 60_000), discount: 200, totalAmount: 2400, promoCodeId: promo.id,
    vatAmount: 245.61, fulfillmentMode: 'VENDOR_DELIVERY',
  });
  await app.prisma.orderItem.create({ data: {
    orderId: northDelivered.id, itemId: 'export-item', name: 'Chicken', quantity: 3,
    basePrice: 500, markedUpPrice: 500, markupAmount: 0, totalBase: 1500, totalMarkup: 0, totalCustomer: 1500,
  } });
  await app.prisma.orderItem.create({ data: {
    orderId: northDelivered.id, itemId: 'export-item-2', name: 'Fries', quantity: 2,
    basePrice: 250, markedUpPrice: 250, markupAmount: 0, totalBase: 500, totalMarkup: 0, totalCustomer: 500,
  } });
  campMmg = await order(camp.id, customer.userId, {
    paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', fulfillment: 'PICKUP',
    mmgAttestedRef: `=REF${nanoid(6)}`, mmgAttestedAt: IN_RANGE, mmgAttestedAmount: 2600, mmgAttestedById: owner.userId,
    customerPaymentRef: `CUSTREF${nanoid(6)}`,
  });
  northCancelled = await order(north.id, customer.userId, {
    status: 'CANCELLED', cancelledAt: new Date(IN_RANGE.getTime() + 5 * 60_000), cancelledBy: owner.userId,
    cancellationReason: '-1+1 kitchen closed early', refundOwedAmount: 2600, refundOwedAt: IN_RANGE,
  });
  northInjected = await order(north.id, customer.userId, { orderNumber: `@OEX-${nanoid(8)}` });
  northBefore = await order(north.id, customer.userId, { placedAt: BEFORE });
  foreignOrder = await order(foreign.id, customer.userId);
  // Still inside the customer's free-cancel hold: the store has never seen it.
  heldOrder = await order(north.id, customer.userId, { status: 'PENDING', holdExpiresAt: new Date(Date.now() + 10 * 60_000) });
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.promoCode.deleteMany({ where: { id: { in: promoIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const numbersOf = (rows: Array<Record<string, string>>) => new Set(rows.map((r) => r['order_number']!.replace(/^'/, '')));

describe('[ORDER-EXPORT] who may export', () => {
  it('a staff member is refused (403), even for their own store', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    for (const q of [RANGE, `${RANGE}&branch=all`, `${RANGE}&branch=${north.id}`]) {
      const res = await get(member.token, `/api/v1/vendor/orders/export?${q}`, north.id);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('STAFF_FORBIDDEN');
    }
  });

  it('a customer with no store is refused', async () => {
    const res = await get(customer.token, `/api/v1/vendor/orders/export?${RANGE}`);
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(northDelivered.orderNumber);
  });

  it('a manager exports their store; all branches means only the stores they manage', async () => {
    const manager = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: manager.userId, role: 'MANAGER', invitedBy: owner.userId } });
    await app.prisma.vendorStaff.create({ data: { vendorId: camp.id, userId: manager.userId, role: 'STAFF', invitedBy: owner.userId } });
    const one = await get(manager.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id);
    expect(one.statusCode, one.body).toBe(200);
    expect(numbersOf(rowsOf(one.body))).toContain(northDelivered.orderNumber);
    const all = await get(manager.token, `/api/v1/vendor/orders/export?${RANGE}&branch=all`, north.id);
    expect(all.statusCode, all.body).toBe(200);
    expect(numbersOf(rowsOf(all.body))).not.toContain(campMmg.orderNumber);
    // Camp, where they are only staff: refused, named or selected.
    expect((await get(manager.token, `/api/v1/vendor/orders/export?${RANGE}&branch=${camp.id}`, north.id)).statusCode).toBe(403);
    expect((await get(manager.token, `/api/v1/vendor/orders/export?${RANGE}`, camp.id)).statusCode).toBe(403);
  });
});

describe('[ORDER-EXPORT] which orders', () => {
  it('one branch: that branch only, inside the range, never a held order', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}&branch=${north.id}`, camp.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="swift-orders-2026-10-01-to-2026-10-10.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    const got = numbersOf(rowsOf(res.body));
    expect(got).toEqual(new Set([northDelivered.orderNumber, northCancelled.orderNumber, northInjected.orderNumber]));
    for (const id of [northBefore.id, foreignOrder.id, heldOrder.id]) expect(res.body).not.toContain(id);
  });

  it('the selected store is the default branch', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}`, camp.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(numbersOf(rowsOf(res.body))).toEqual(new Set([campMmg.orderNumber]));
  });

  it('a chain owner exports all branches in one file, each row naming its branch; never another owner\'s store', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}&branch=all`, north.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toContain('swift-orders-all-branches-2026-10-01-to-2026-10-10.csv');
    const rows = rowsOf(res.body);
    expect(numbersOf(rows)).toEqual(new Set([northDelivered.orderNumber, northCancelled.orderNumber, northInjected.orderNumber, campMmg.orderNumber]));
    const byNumber = new Map(rows.map((r) => [r['order_number']!.replace(/^'/, ''), r]));
    expect(byNumber.get(northDelivered.orderNumber)!['branch']).toBe(north.name);
    expect(byNumber.get(campMmg.orderNumber)!['branch']).toBe(`'${camp.name}`);
    expect(res.body).not.toContain(foreignOrder.id);
  });

  it('naming another owner\'s store is refused, never answered with its orders', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}&branch=${foreign.id}`, north.id);
    expect(res.statusCode, res.body).toBe(403);
  });

  it('the Guyana day decides the range: 23:59 on the day before is out, the first second of the day is in', async () => {
    const res = await get(owner.token, '/api/v1/vendor/orders/export?from=2026-09-29&to=2026-09-29', north.id);
    expect(res.statusCode, res.body).toBe(200);
    const rows = rowsOf(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['placed_at_guyana']).toBe('2026-09-29 23:59:00');
  });
});

describe('[ORDER-EXPORT] the columns', () => {
  it('has exactly the finance columns and no customer details', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}&branch=all`, north.id);
    expect(res.statusCode, res.body).toBe(200);
    const [header] = parseCsv(res.body.replace(/^\uFEFF/, ''));
    expect(header).toEqual([...ORDER_EXPORT_COLUMNS]);
    for (const pii of [CUSTOMER_FIRST, CUSTOMER_LAST, customerPhone, ADDRESS, NOTE, customer.userId, 'CUSTREF', '6.81', '-58.16']) {
      expect(res.body, pii).not.toContain(pii);
    }
    for (const col of header!) expect(col).not.toMatch(/customer|phone|address|email|(^|_)(lat|lng|latitude|longitude|first_name|last_name|instructions)(_|$)/);
  });

  it('writes the money, times, fulfilment, items and promo of a delivered order', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}&branch=${north.id}`, north.id);
    const row = rowsOf(res.body).find((r) => r['order_number'] === northDelivered.orderNumber)!;
    expect(row).toMatchObject({
      branch: north.name, branch_city: 'Georgetown', order_status: 'delivered', fulfilment: 'own_delivery',
      placed_at_guyana: '2026-10-05 11:30:00', placed_at_iso: IN_RANGE.toISOString(),
      accepted_at_guyana: '2026-10-05 11:31:00', ready_at_guyana: '2026-10-05 11:50:00',
      completed_at_guyana: '2026-10-05 12:15:00', completed_at_iso: new Date(IN_RANGE.getTime() + 45 * 60_000).toISOString(),
      cancelled_at_guyana: '', payment_method: 'cash', mmg_paid_claim: '', mmg_store_reference: '',
      item_count: '5', currency: 'GYD', food_subtotal: '2000.00', delivery_fee: '500.00', service_fee: '0.00', tip: '100.00',
      discount: '200.00', vat_included: '245.61', total: '2400.00', cancelled_by: '', refund_amount: '', refund_note: '',
    });
    expect(row['promo_code']).toMatch(/^OEX/);
  });

  it('MMG: the store\'s claim and its own reference (formula-safe), never the customer\'s reference', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}`, camp.id);
    const row = rowsOf(res.body)[0]!;
    expect(row).toMatchObject({ payment_method: 'mmg', payment_status: 'claimed', mmg_paid_claim: 'store_confirmed', fulfilment: 'pickup' });
    expect(row['mmg_store_reference']).toMatch(/^'=REF/);
  });

  it('a store cancel: the actor, the store\'s reason (formula-safe) and the refund owed', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id);
    const row = rowsOf(res.body).find((r) => r['order_number'] === northCancelled.orderNumber)!;
    expect(row).toMatchObject({
      order_status: 'cancelled', cancelled_by: 'store', cancellation_reason: "'-1+1 kitchen closed early",
      cancelled_at_guyana: '2026-10-05 11:35:00', refund_amount: '2600.00', refund_note: 'Refund owed 2600.00: not paid back yet',
    });
  });

  it('every cell a spreadsheet would run as a formula starts with an apostrophe', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}&branch=all`, north.id);
    const rows = rowsOf(res.body);
    expect(rows.find((r) => r['order_number'] === `'${northInjected.orderNumber}`)).toBeDefined();
    for (const row of rows) {
      for (const [col, cell] of Object.entries(row)) {
        if (/^-?\d+\.\d{2}$/.test(cell)) continue; // a number Swift wrote
        expect(cell, `${col}=${cell}`).not.toMatch(/^[=+\-@\t\r]/);
      }
    }
  });
});

describe('[ORDER-EXPORT] the range', () => {
  it.each([
    ['', 'EXPORT_RANGE_INVALID'],
    ['from=2026-10-01', 'EXPORT_RANGE_INVALID'],
    ['from=2026-10-10&to=2026-10-01', 'EXPORT_RANGE_INVALID'],
    ['from=2026-02-30&to=2026-03-01', 'EXPORT_RANGE_INVALID'],
    ['from=01-10-2026&to=2026-10-10', 'EXPORT_RANGE_INVALID'],
    ['from=2099-01-01&to=2099-01-02', 'EXPORT_RANGE_INVALID'],
    ['from=2025-01-01&to=2026-01-02', 'EXPORT_RANGE_TOO_LONG'],
  ])('refuses %s (%s)', async (q, code) => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${q}`, north.id);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe(code);
  });

  it('takes exactly 366 days', async () => {
    const res = await get(owner.token, '/api/v1/vendor/orders/export?from=2025-10-10&to=2026-10-10', north.id);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('[ORDER-EXPORT] the audit row', () => {
  it('records who exported, the range and the branches; a refused export records nothing', async () => {
    const since = new Date();
    const res = await get(owner.token, '/api/v1/vendor/orders/export?from=2026-10-02&to=2026-10-09&branch=all', north.id);
    expect(res.statusCode, res.body).toBe(200);
    const rows = await app.prisma.auditLog.findMany({ where: { userId: owner.userId, action: ORDER_EXPORT_AUDIT_ACTION, createdAt: { gte: since } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changes).toMatchObject({ from: '2026-10-02', to: '2026-10-09', scope: 'all', role: 'OWNER' });
    expect(new Set((rows[0]!.changes as { vendorIds: string[] }).vendorIds)).toEqual(new Set([north.id, camp.id]));

    const refused = await get(owner.token, '/api/v1/vendor/orders/export?from=2025-01-01&to=2026-10-09', north.id);
    expect(refused.statusCode).toBe(400);
    expect(await app.prisma.auditLog.count({ where: { userId: owner.userId, action: ORDER_EXPORT_AUDIT_ACTION, createdAt: { gte: since } } })).toBe(1);
  });
});

describe('[ORDER-EXPORT] large exports', () => {
  it('pages through more orders than one batch without losing or repeating one', async () => {
    const vo = await app.prisma.vendorOwner.findFirstOrThrow({ where: { userId: owner.userId } });
    const big = await store(vo.id, `Big Branch ${wordFreeTag(5)}`);
    const at = new Date('2026-10-07T16:00:00.000Z');
    const rows = Array.from({ length: 1203 }, (_, i) => ({
      orderNumber: `OEXB-${nanoid(10)}`, orderType: 'FOOD_DELIVERY' as const, customerId: customer.userId, vendorId: big.id,
      status: 'DELIVERED' as const, fulfillment: 'PICKUP' as const, deliveryAddress: 'counter', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 100, subtotalMarkup: 0, subtotalCustomer: 100, deliveryFee: 0, totalAmount: 100, paymentMethod: 'CASH' as const,
      placedAt: new Date(at.getTime() + (i % 7) * 1000), // ties on placedAt across page edges
    }));
    await app.prisma.order.createMany({ data: rows });
    const created = await app.prisma.order.findMany({ where: { vendorId: big.id }, select: { id: true } });
    orderIds.push(...created.map((o) => o.id));
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}&branch=${big.id}`, north.id);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const got = rowsOf(res.body).map((r) => r['order_number']);
    expect(got).toHaveLength(1203);
    expect(new Set(got)).toEqual(new Set(rows.map((r) => r.orderNumber)));
  });
});

describe('[ORDER-EXPORT] guyanaStamp', () => {
  it('is the Guyana wall clock, UTC-4', () => {
    expect(guyanaStamp(new Date('2026-01-01T03:00:00.000Z'))).toBe('2025-12-31 23:00:00');
  });
});
