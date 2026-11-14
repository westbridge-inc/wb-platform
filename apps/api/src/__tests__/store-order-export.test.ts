import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { ORDER_EXPORT_AUDIT_ACTION, ORDER_EXPORT_COLUMNS, ORDER_EXPORT_LOCK_PREFIX, guyanaStamp, orderExportLines, orderExportPageWhere, orderExportStream, releaseOrderExportLock } from '../modules/vendor/order-export';
import { tenantContext } from '../plugins/tenant-context';
import { aggregateSalesComponents } from '../modules/billing/sales-components';
import { VENDOR_NO_RESPONSE_REASON } from '../modules/order/customer-cancellation';
import { endOfGuyanaDay, startOfGuyanaDay } from '../utils/guyana-day';
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
// [REVIEW-2485-B] The finance fixtures: a third branch, orders placed 20-26 Oct (outside RANGE).
let ledger: { id: string; name: string };
const L: Record<string, { id: string; orderNumber: string }> = {};
let vendorCode = '';
let platformCode = '';
const LEDGER_RANGE = 'from=2026-10-20&to=2026-10-25';
const LEDGER_AT = new Date('2026-10-21T15:00:00.000Z');

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
    // [MENU-OPTIONS] the choices the line was made with (zero-priced here: the order money above stays as it was).
    selectedOptions: { create: [
      { optionGroupName: 'Size', optionName: 'Large', basePrice: 0, markedUpPrice: 0, markupAmount: 0, plainGroupName: 'Size', plainOptionName: 'Large', setsPrice: true, listedPrice: 500 },
      { optionGroupName: 'Toppings', optionName: 'Pepper (left half)', basePrice: 0, markedUpPrice: 0, markupAmount: 0, plainGroupName: 'Toppings', plainOptionName: 'Pepper', placement: 'LEFT', listedPrice: 0 },
    ] },
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

  // ---- [REVIEW-2485-B] finance fixtures on the ledger branch ----
  ledger = await store(vo.id, `Ledger Branch ${wordFreeTag(5)}`);
  const code = async (funder: 'VENDOR' | 'PLATFORM') => {
    const p = await app.prisma.promoCode.create({ data: {
      code: `OEX${funder[0]}${wordFreeTag(6).toUpperCase()}`, description: 'export funder test', vendorId: funder === 'VENDOR' ? ledger.id : null,
      discountType: 'FIXED_AMOUNT', discountValue: 300, applicableTo: ['FOOD_DELIVERY'], validFrom: new Date(Date.now() - 400 * DAY), validUntil: new Date(Date.now() + DAY), funder,
    } });
    promoIds.push(p.id);
    return p;
  };
  const vendorPromo = await code('VENDOR');
  const platformPromo = await code('PLATFORM');
  vendorCode = vendorPromo.code;
  platformCode = platformPromo.code;
  const redeem = (orderId: string, promoCodeId: string, funder: 'VENDOR' | 'PLATFORM', goodsDiscount: number, deliveryDiscount: number) =>
    app.prisma.promoRedemption.create({ data: { orderId, promoCodeId, termsVersion: 1, discountType: 'FIXED_AMOUNT', discountValue: goodsDiscount + deliveryDiscount, funder, goodsDiscount, deliveryDiscount } });
  // L1: Swift rider, cash collected, express, the store's own code, lines removed at substitution.
  L['vendorPromo'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, deliveredAt: new Date(LEDGER_AT.getTime() + 40 * 60_000), fulfillmentMode: 'PLATFORM_RIDER', isExpress: true,
    subtotalBase: 3000, subtotalCustomer: 3000, discount: 300, deliveryFee: 1500, tipAmount: 100, totalAmount: 4300,
    paymentStatus: 'CAPTURED', promoCodeId: vendorPromo.id,
  });
  await redeem(L['vendorPromo'].id, vendorPromo.id, 'VENDOR', 300, 0);
  for (const [qty, subStatus] of [[2, 'NONE'], [1, 'REFUNDED'], [4, 'REJECTED']] as const) {
    await app.prisma.orderItem.create({ data: {
      orderId: L['vendorPromo'].id, itemId: `ledger-${subStatus}`, name: `Line ${subStatus}`, quantity: qty, subStatus,
      basePrice: 100, markedUpPrice: 100, markupAmount: 0, totalBase: 100 * qty, totalMarkup: 0, totalCustomer: 100 * qty,
    } });
  }
  // L2: the store's own delivery, a Swift-funded code carried by the redemption only (multi-store basket), cash never recorded.
  L['platformPromo'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, deliveredAt: new Date(LEDGER_AT.getTime() + 30 * 60_000), fulfillmentMode: 'VENDOR_DELIVERY',
    subtotalBase: 2000, subtotalCustomer: 2000, discount: 450, deliveryFee: 500, tipAmount: 0, totalAmount: 2050,
  });
  await redeem(L['platformPromo'].id, platformPromo.id, 'PLATFORM', 250, 200);
  // L3: a pickup completed before discounts had a funding record, with a service fee.
  L['legacy'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, status: 'COMPLETED', fulfillment: 'PICKUP',
    subtotalBase: 1000, subtotalCustomer: 1000, discount: 100, deliveryFee: 0, tipAmount: 0, serviceFee: 50, totalAmount: 950,
  });
  // L4: MMG confirmed by the provider, with tax.
  L['mmg'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, status: 'COMPLETED', fulfillment: 'PICKUP', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED',
    subtotalBase: 1500, subtotalCustomer: 1500, deliveryFee: 0, tipAmount: 0, taxAmount: 15, totalAmount: 1515,
  });
  // L5: a system close (too old to deliver), the cash refund already handed back.
  L['tooOld'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, status: 'CANCELLED', cancelledAt: new Date(LEDGER_AT.getTime() + 90 * 60_000), cancellationReason: 'FOOD_TOO_OLD',
    refundOwedAmount: 1000, refundOwedAt: LEDGER_AT, refundSettledAt: new Date(LEDGER_AT.getTime() + DAY), refundPaidAmount: 1000, refundRef: `OEXR-${nanoid(8)}`,
  });
  // L6: the store never answered.
  L['noResponse'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, status: 'CANCELLED', cancelledAt: new Date(LEDGER_AT.getTime() + 10 * 60_000), cancellationReason: VENDOR_NO_RESPONSE_REASON,
  });
  // L7 / L8: the last instant of 25 Oct in Guyana (in), and the first of 26 Oct (out).
  L['lastInstant'] = await order(ledger.id, customer.userId, { placedAt: new Date('2026-10-26T03:59:59.999Z'), deliveredAt: new Date('2026-10-26T04:30:00.000Z'), tipAmount: 0, totalAmount: 2500 });
  L['nextDay'] = await order(ledger.id, customer.userId, { placedAt: new Date('2026-10-26T04:00:00.000Z') });
  // [REVIEW-2485-DELTA S2-1] A Swift-funded code on an order that never became a sale: cancelled, and still in progress.
  L['cancelledPromo'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, status: 'CANCELLED', cancelledAt: new Date(LEDGER_AT.getTime() + 15 * 60_000), cancelledBy: owner.userId,
    cancellationReason: 'Kitchen closed', subtotalBase: 2000, subtotalCustomer: 2000, discount: 300, deliveryFee: 500, tipAmount: 0, totalAmount: 2200,
  });
  await redeem(L['cancelledPromo'].id, platformPromo.id, 'PLATFORM', 300, 0);
  L['inFlightPromo'] = await order(ledger.id, customer.userId, {
    placedAt: LEDGER_AT, status: 'PREPARING', acceptedAt: LEDGER_AT, subtotalBase: 1000, subtotalCustomer: 1000, discount: 150,
    deliveryFee: 500, tipAmount: 0, totalAmount: 1350,
  });
  await redeem(L['inFlightPromo'].id, platformPromo.id, 'PLATFORM', 100, 50);
  // [REVIEW-2485-DELTA S3-2 / S4-5] 27 Oct (its own day): cash handed over short, a card order, a bank transfer.
  const day27 = new Date('2026-10-27T15:00:00.000Z');
  L['shortCash'] = await order(ledger.id, customer.userId, {
    placedAt: day27, deliveredAt: day27, fulfillmentMode: 'PLATFORM_RIDER', paymentStatus: 'CAPTURED',
    doorCashCollectedAmount: 2000, doorCashShortfallAmount: 600, doorCashMismatchAt: day27,
  });
  L['card'] = await order(ledger.id, customer.userId, { placedAt: day27, deliveredAt: day27, paymentMethod: 'CARD', paymentStatus: 'CAPTURED' });
  L['bank'] = await order(ledger.id, customer.userId, { placedAt: day27, status: 'PENDING', paymentMethod: 'BANK_TRANSFER' });
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
    expect(header).toEqual([
      'order_number', 'branch', 'branch_city', 'order_status', 'fulfilment', 'express',
      'placed_at_guyana', 'placed_at_iso', 'accepted_at_guyana', 'accepted_at_iso', 'ready_at_guyana', 'ready_at_iso',
      'completed_at_guyana', 'completed_at_iso', 'cancelled_at_guyana', 'cancelled_at_iso',
      'payment_method', 'payment_status', 'payment_note', 'mmg_paid_claim', 'mmg_store_reference', 'item_count', 'currency',
      'food_subtotal', 'discount', 'discount_store_funded', 'discount_swift_funded_goods', 'discount_swift_funded_delivery', 'discount_estimated', 'promo_code',
      'delivery_fee', 'service_fee', 'tip', 'tax', 'vat_included', 'total',
      'store_goods_net', 'store_delivery_fee_and_tip', 'rider_delivery_fee_and_tip',
      'cancelled_by', 'cancellation_reason', 'refund_owed', 'refund_paid', 'refund_note',
      'items',
      // [STORE-VAT-EXCLUSIVE · REVIEW-A F1] How the VAT relates to the prices (last: every earlier column keeps its place).
      'vat_basis',
    ]);
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
      cancelled_at_guyana: '', payment_method: 'cash', payment_status: 'cash_to_store_not_recorded_by_swift',
      payment_note: 'Cash to the store, not recorded by Swift', mmg_paid_claim: '', mmg_store_reference: '', express: 'no',
      item_count: '5', currency: 'GYD', food_subtotal: '2000.00', delivery_fee: '500.00', service_fee: '0.00', tip: '100.00', tax: '0.00',
      discount: '200.00', discount_store_funded: '200.00', discount_swift_funded_goods: '0.00', discount_swift_funded_delivery: '0.00',
      discount_estimated: 'yes', store_goods_net: '1800.00', store_delivery_fee_and_tip: '600.00', rider_delivery_fee_and_tip: '0.00',
      vat_included: '245.61', total: '2400.00', cancelled_by: '', refund_owed: '', refund_paid: '', refund_note: '',
      // [MENU-OPTIONS] what was ordered, each line with its choices
      items: '3× Chicken [Size: Large; Toppings: Pepper (left half)] | 2× Fries',
    });
    expect(row['promo_code']).toMatch(/^OEX/);
  });

  it('MMG: the store\'s claim and its own reference (formula-safe), never the customer\'s reference', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}`, camp.id);
    const row = rowsOf(res.body)[0]!;
    expect(row).toMatchObject({ payment_method: 'mmg', payment_status: 'mmg_reported_by_store', mmg_paid_claim: 'store_confirmed', fulfilment: 'pickup' });
    expect(row['mmg_store_reference']).toMatch(/^'=REF/);
  });

  it('a store cancel: the actor, the store\'s reason (formula-safe) and the refund owed', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id);
    const row = rowsOf(res.body).find((r) => r['order_number'] === northCancelled.orderNumber)!;
    expect(row).toMatchObject({
      order_status: 'cancelled', cancelled_by: 'store', cancellation_reason: "'-1+1 kitchen closed early",
      cancelled_at_guyana: '2026-10-05 11:35:00', refund_owed: '2600.00', refund_paid: '', refund_note: 'Refund owed 2600.00: not paid back yet',
      store_goods_net: '', store_delivery_fee_and_tip: '', rider_delivery_fee_and_tip: '', payment_status: 'no_payment_recorded',
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
    expect(new Set((rows[0]!.changes as { vendorIds: string[] }).vendorIds)).toEqual(new Set([north.id, camp.id, ledger.id]));

    const refused = await get(owner.token, '/api/v1/vendor/orders/export?from=2025-01-01&to=2026-10-09', north.id);
    expect(refused.statusCode).toBe(400);
    expect(await app.prisma.auditLog.count({ where: { userId: owner.userId, action: ORDER_EXPORT_AUDIT_ACTION, createdAt: { gte: since } } })).toBe(1);
  });
});

describe('[REVIEW-2485-B] the store\'s money, split like the sales statement', () => {
  const ledgerRows = async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${LEDGER_RANGE}&branch=${ledger.id}`, north.id);
    expect(res.statusCode, res.body).toBe(200);
    const rows = rowsOf(res.body);
    return { rows, by: (key: string) => rows.find((r) => r['order_number'] === L[key]!.orderNumber)! };
  };

  it('the last instant of the end day is in; 00:00 on the next Guyana day is out', async () => {
    const { rows } = await ledgerRows();
    const numbers = new Set(rows.map((r) => r['order_number']));
    expect(numbers).toContain(L['lastInstant']!.orderNumber);
    expect(numbers).not.toContain(L['nextDay']!.orderNumber);
    expect(rows).toHaveLength(9);
  });

  it('sum(store_goods_net) equals the sales statement total for the same days', async () => {
    const { rows } = await ledgerRows();
    const cents = rows.reduce((sum, r) => sum + (r['store_goods_net'] ? Math.round(Number(r['store_goods_net']) * 100) : 0), 0);
    const statement = await aggregateSalesComponents(app.prisma, { vendorId: ledger.id, from: startOfGuyanaDay('2026-10-20'), to: endOfGuyanaDay('2026-10-25') });
    expect(statement.netSales).toBe(9100);
    expect(cents / 100).toBe(statement.netSales);
    const swiftOwes = rows.reduce((sum, r) => sum + Math.round(Number(r['discount_swift_funded_goods'] || 0) * 100), 0) / 100;
    expect(swiftOwes).toBe(statement.sponsorReceivable);
  });

  it('a store-funded code: the store\'s discount, Swift-rider fee and tip the rider\'s, express flagged, removed lines not counted', async () => {
    const { by } = await ledgerRows();
    expect(by('vendorPromo')).toMatchObject({
      promo_code: vendorCode, discount: '300.00', discount_store_funded: '300.00', discount_swift_funded_goods: '0.00',
      discount_swift_funded_delivery: '0.00', discount_estimated: 'no', store_goods_net: '2700.00',
      rider_delivery_fee_and_tip: '1600.00', store_delivery_fee_and_tip: '0.00', express: 'yes', item_count: '2',
      payment_status: 'cash_collected', payment_note: 'Paid in cash on delivery', fulfilment: 'delivery',
    });
  });

  it('a Swift-funded code: what Swift owes the store, the fee part, and the code from the redemption record', async () => {
    const { by } = await ledgerRows();
    expect(by('platformPromo')).toMatchObject({
      promo_code: platformCode, discount: '450.00', discount_store_funded: '0.00', discount_swift_funded_goods: '250.00',
      discount_swift_funded_delivery: '200.00', discount_estimated: 'no', store_goods_net: '2000.00',
      store_delivery_fee_and_tip: '300.00', rider_delivery_fee_and_tip: '0.00', fulfilment: 'own_delivery',
      payment_status: 'cash_to_store_not_recorded_by_swift',
    });
  });

  it('a discount with no funding record is counted as the store\'s and marked estimated', async () => {
    const { by } = await ledgerRows();
    expect(by('legacy')).toMatchObject({
      discount_store_funded: '100.00', discount_estimated: 'yes', store_goods_net: '900.00', service_fee: '50.00',
      payment_status: 'cash_to_store_not_recorded_by_swift', payment_note: 'Cash to the store, not recorded by Swift',
    });
  });

  it('MMG confirmed by the provider; tax is its own column', async () => {
    const { by } = await ledgerRows();
    expect(by('mmg')).toMatchObject({ payment_status: 'mmg_confirmed', payment_note: 'Paid by MMG — directly to the store', tax: '15.00', total: '1515.00' });
  });

  it('refunds: owed and paid back are separate columns', async () => {
    const { by } = await ledgerRows();
    expect(by('tooOld')).toMatchObject({ refund_owed: '', refund_paid: '1000.00', store_goods_net: '' });
    expect(by('tooOld')['refund_note']).toBe('Refund 1000.00: paid back 2026-10-22');
  });

  it('cancellation reasons are in plain words, never codes', async () => {
    const { by } = await ledgerRows();
    expect(by('tooOld')).toMatchObject({ cancelled_by: 'system', cancellation_reason: 'Too old to deliver: the order was ready but no rider could be found in time.' });
    expect(by('noResponse')).toMatchObject({ cancelled_by: 'no_response', cancellation_reason: 'The store didn’t respond in time.' });
    const all = await get(owner.token, `/api/v1/vendor/orders/export?from=2026-10-01&to=2026-10-25&branch=all`, north.id);
    for (const row of rowsOf(all.body)) expect(row['cancellation_reason']).not.toMatch(/^[A-Z0-9_]+$/);
  });

  it('total adds up on every row, across delivery, own delivery, pickup, express, MMG and cash', async () => {
    const all = await get(owner.token, `/api/v1/vendor/orders/export?from=2026-10-01&to=2026-10-25&branch=all`, north.id);
    const rows = rowsOf(all.body);
    expect(rows.length).toBeGreaterThanOrEqual(11);
    const c = (r: Record<string, string>, k: string) => Math.round(Number(r[k] || 0) * 100);
    for (const r of rows) {
      const sum = c(r, 'food_subtotal') - c(r, 'discount') + c(r, 'delivery_fee') + c(r, 'service_fee') + c(r, 'tax') + c(r, 'tip');
      expect(Math.max(0, sum), r['order_number']).toBe(c(r, 'total'));
    }
  });
});

describe('[REVIEW-2485-B] GET /orders/export/branches — the branches this login may export', () => {
  it('an owner: every branch', async () => {
    const res = await get(owner.token, '/api/v1/vendor/orders/export/branches', north.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.scope).toBe('owner');
    expect(new Set(res.json().data.branches.map((b: { id: string }) => b.id))).toEqual(new Set([north.id, camp.id, ledger.id]));
  });

  it('a manager: only the stores they manage; staff are refused', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'MANAGER', invitedBy: owner.userId } });
    await app.prisma.vendorStaff.create({ data: { vendorId: camp.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    const res = await get(member.token, '/api/v1/vendor/orders/export/branches', camp.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ scope: 'manager', branches: [{ id: north.id, name: north.name, city: 'Georgetown' }] });
    const staff = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: staff.userId, role: 'STAFF', invitedBy: owner.userId } });
    expect((await get(staff.token, '/api/v1/vendor/orders/export/branches', north.id)).statusCode).toBe(403);
  });
});

let bigId = '';
describe('[ORDER-EXPORT] large exports', () => {
  it('pages through more orders than one batch without losing or repeating one', async () => {
    const vo = await app.prisma.vendorOwner.findFirstOrThrow({ where: { userId: owner.userId } });
    const big = await store(vo.id, `Big Branch ${wordFreeTag(5)}`);
    bigId = big.id;
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

describe('[REVIEW-2485-DELTA] finished sales only, short cash, other payment methods', () => {
  it('S2-1: the funder split is blank on a cancelled or unfinished order, so "Swift owes the store" sums to the statement', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?${LEDGER_RANGE}&branch=${ledger.id}`, north.id);
    const rows = rowsOf(res.body);
    const by = (key: string) => rows.find((r) => r['order_number'] === L[key]!.orderNumber)!;
    for (const key of ['cancelledPromo', 'inFlightPromo']) {
      expect(by(key), key).toMatchObject({
        discount_store_funded: '', discount_swift_funded_goods: '', discount_swift_funded_delivery: '', discount_estimated: '', store_goods_net: '',
      });
      expect(by(key)['discount']).not.toBe('');
    }
    const swiftOwes = rows.reduce((sum, r) => sum + Math.round(Number(r['discount_swift_funded_goods'] || 0) * 100), 0) / 100;
    const statement = await aggregateSalesComponents(app.prisma, { vendorId: ledger.id, from: startOfGuyanaDay('2026-10-20'), to: endOfGuyanaDay('2026-10-25') });
    expect(statement.sponsorReceivable).toBe(250);
    expect(swiftOwes).toBe(statement.sponsorReceivable);
  });

  it('S3-2 / S4-5: short cash in the receipt\'s words; card and bank transfer never called cash', async () => {
    const res = await get(owner.token, `/api/v1/vendor/orders/export?from=2026-10-27&to=2026-10-27&branch=${ledger.id}`, north.id);
    const rows = rowsOf(res.body);
    const by = (key: string) => rows.find((r) => r['order_number'] === L[key]!.orderNumber)!;
    expect(by('shortCash')).toMatchObject({ payment_status: 'cash_collected_short', payment_note: 'Paid 2000.00 in cash on delivery (600.00 not collected)' });
    expect(by('card')).toMatchObject({ payment_method: 'card', payment_status: 'card_paid', payment_note: 'Paid by card' });
    expect(by('bank')).toMatchObject({ payment_method: 'bank_transfer', payment_status: 'bank_transfer_pending', payment_note: 'Bank transfer, not confirmed' });
  });
});

describe('[REVIEW-2485-DELTA S4] the export lock', () => {
  it('releasing deletes only this export\'s own lock, never one another export took', async () => {
    const key = `${ORDER_EXPORT_LOCK_PREFIX}release-test-${nanoid(6)}`;
    await app.redis.set(key, 'other-export', 'EX', 60);
    await releaseOrderExportLock(app.redis, key, 'my-export');
    expect(await app.redis.get(key)).toBe('other-export');
    await releaseOrderExportLock(app.redis, key, 'other-export');
    expect(await app.redis.exists(key)).toBe(0);
  });

  it('a database error part-way through the file still frees the slot', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const broken = vi.spyOn(app.prisma.vendor, 'findMany').mockRejectedValueOnce(new Error('database went away'));
    try {
      const res = await get(member.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id).catch((err: unknown) => err);
      expect(res).toBeDefined();
    } finally {
      broken.mockRestore();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(await app.redis.exists(`${ORDER_EXPORT_LOCK_PREFIX}${member.userId}`)).toBe(0);
    const again = await get(member.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id);
    expect(again.statusCode, again.body).toBe(200);
  });

  it('Redis down: a clear 503, no export and no audit row', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const down = vi.spyOn(app.redis, 'set').mockRejectedValueOnce(new Error('connection refused'));
    try {
      const res = await get(member.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id);
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json().error).toMatchObject({ code: 'EXPORT_UNAVAILABLE', message: 'Export is unavailable right now. Try again shortly.' });
    } finally {
      down.mockRestore();
    }
    expect(await app.prisma.auditLog.count({ where: { userId: member.userId, action: ORDER_EXPORT_AUDIT_ACTION } })).toBe(0);
  });
});

describe('[REVIEW-2485-A] load and tenant safety', () => {
  it('S3-1: every page after the first starts its placed-time range at the cursor, not at the start of the range', () => {
    const from = new Date('2026-10-01T04:00:00.000Z');
    const to = new Date('2026-10-11T03:59:59.999Z');
    const first = orderExportPageWhere({ vendorIds: ['v'], from, to }, null);
    expect(first.placedAt).toEqual({ gte: from, lte: to });
    const cursor = { placedAt: new Date('2026-10-05T12:00:00.000Z'), id: 'c1' };
    const next = orderExportPageWhere({ vendorIds: ['v'], from, to }, cursor);
    expect(next.placedAt).toEqual({ gte: cursor.placedAt, lte: to });
    expect(JSON.stringify(next.AND)).toContain('"id":{"gt":"c1"}');
  });

  it('S4-1: each page reads inside the request tenant even when the stream is pulled outside it (unscoped reads denied)', async () => {
    expect(bigId).not.toBe('');
    const before = process.env['TENANT_UNSCOPED_ACCESS'];
    process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
    try {
      const stream = tenantContext.run({ tenantId: 'swift-default', mode: 'request' }, () =>
        orderExportStream(orderExportLines(app.prisma, { vendorIds: [bigId], from: startOfGuyanaDay('2026-10-01'), to: endOfGuyanaDay('2026-10-10') })));
      // The socket pulls the file after the handler returned: here, with no tenant at all.
      const body = await tenantContext.exit(async () => {
        let out = '';
        for await (const chunk of stream) out += String(chunk);
        return out;
      });
      expect(rowsOf(body)).toHaveLength(1203);
    } finally {
      if (before === undefined) delete process.env['TENANT_UNSCOPED_ACCESS'];
      else process.env['TENANT_UNSCOPED_ACCESS'] = before;
    }
  });

  it('S3-1: one export at a time per person: a second while one runs is refused, and the slot frees when it ends', async () => {
    const key = `${ORDER_EXPORT_LOCK_PREFIX}${owner.userId}`;
    await app.redis.set(key, 'running', 'EX', 60);
    try {
      const busy = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id);
      expect(busy.statusCode, busy.body).toBe(429);
      expect(busy.json().error.code).toBe('EXPORT_ALREADY_RUNNING');
    } finally {
      await app.redis.del(key);
    }
    const ok = await get(owner.token, `/api/v1/vendor/orders/export?${RANGE}`, north.id);
    expect(ok.statusCode, ok.body).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(await app.redis.exists(key)).toBe(0);
  });

  it('S4-3: an all-branches audit row names a store the caller manages, never one where they are only staff', async () => {
    const member = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.vendorStaff.create({ data: { vendorId: camp.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    await app.prisma.vendorStaff.create({ data: { vendorId: north.id, userId: member.userId, role: 'MANAGER', invitedBy: owner.userId } });
    const res = await get(member.token, `/api/v1/vendor/orders/export?${RANGE}&branch=all`, camp.id);
    expect(res.statusCode, res.body).toBe(200);
    const row = await app.prisma.auditLog.findFirstOrThrow({ where: { userId: member.userId, action: ORDER_EXPORT_AUDIT_ACTION } });
    expect(row.entityId).toBe(north.id);
    expect((row.changes as { vendorIds: string[] }).vendorIds).toEqual([north.id]);
  });
});
