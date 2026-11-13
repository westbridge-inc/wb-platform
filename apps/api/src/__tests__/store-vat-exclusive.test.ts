import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { OrderService } from '../modules/order/order.service';
import { PickingService } from '../modules/order/picking.service';
import { VAT_CERTIFICATE_DOC_TYPE } from '../modules/store-vat/store-vat';
import { reconcileVatPricing } from '../modules/store-vat/vat-pricing';
import { riderFloatForOrder } from '../modules/dispatch/float.service';
import { cashMathForOffer, CASH_MATH_SELECT } from '../modules/dispatch/dispatch.service';
import { guyanaDayKey } from '../utils/guyana-day';
import { ownedVerificationFixture } from './helpers/verification-object';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { walkOrderStatus } from './helpers/order-status-walk';

// ---------------------------------------------------------------------------
// [STORE-VAT-EXCLUSIVE · owner 13 Nov 2026] A VAT-registered store pricing BEFORE VAT, end to end on a real database:
//   - deployed dark: with STORE_VAT_EXCLUSIVE off no store can choose it and nothing changes;
//   - ONE submission (number + certificate + "prices before VAT"); a PERSON approves; the menu prices stay exactly as typed
//     (nothing is added into them) and the store page says "Prices exclude VAT; VAT 14% is added at checkout";
//   - the cart quote, checkout, the order, the customer's order screen, the rider's cash, the store's figure, the receipt
//     and the VAT report all carry the SAME "VAT 14%" line (once per order, half-up) and the SAME Total;
//   - picking (a swap, a removed line) moves the VAT line and the total by the rule the customer was shown;
//   - a change of the store's VAT between the quote and the commit refuses the checkout;
//   - a switch flip never changes what a customer pays; a store approved on "VAT added into the price" keeps it until a
//     person approves its change to prices before VAT.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RUN = wordFreeTag(6);
const REASON = `Checked the GRA certificate against the store record ${RUN}`;
const VAT_NUMBER = '034567891';

let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
let ownerUserId = '';
let ownerToken = '';
let reviewerToken = '';
let customer: { userId: string; token: string; addressId: string };
let vendorId = '';
let curryId = '';
let riceId = '';
let saltId = '';
let juiceId = '';
let cakeId = '';
let deliveredOrderId = '';
let itemSeq = 0;
const word = (w: string) => `${w} ${(itemSeq += 1)}`;

async function session(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vatx-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return token;
}

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  });
}
const vendorCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: unknown, token = ownerToken) => call(method, `/api/v1/vendor${path}`, token, payload);
const adminCall = (path: string, payload: unknown) => call('POST', `/api/v1/admin${path}`, reviewerToken, payload, { 'x-swift-reason': REASON });
const codeOf = (res: { json: () => { error?: { code?: string }; code?: string } }) => res.json().error?.code ?? res.json().code;
const vendorRow = (id = vendorId) => app.prisma.vendor.findUniqueOrThrow({ where: { id } });
const storefront = async (id = vendorId) => {
  const res = await call('GET', `/api/v1/customer/vendors/${id}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { vat: unknown; categories: Array<{ items: Array<{ id: string; basePrice: number }> }> };
};

type Quote = {
  totalAmount: number; subtotalCustomer: number; deliveryFee: number; discount: number; tipAmount: number; taxAmount: number;
  vendors: Array<{ vendorId: string; totalAmount: number; taxAmount: number; vat: Record<string, unknown> | null }>;
};
async function fillCart(lines: Array<{ itemId: string; quantity: number }>, store = vendorId): Promise<Quote> {
  await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  for (const line of lines) {
    const add = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: store, itemId: line.itemId, quantity: line.quantity });
    expect(add.statusCode, add.body).toBeLessThan(300);
  }
  const address = await call('PUT', '/api/v1/customer/cart/address', customer.token, { addressId: customer.addressId });
  expect(address.statusCode, address.body).toBeLessThan(300);
  return quoteNow();
}
async function quoteNow(): Promise<Quote> {
  const cart = await call('GET', '/api/v1/customer/cart', customer.token);
  expect(cart.statusCode, cart.body).toBe(200);
  return cart.json().data as Quote;
}
function checkoutCall(extra: Record<string, unknown> = {}) {
  return call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH', ...extra }, { 'idempotency-key': `vatx-${nanoid(10)}` });
}
async function placeOrder(lines: Array<{ itemId: string; quantity: number }>) {
  const quote = await fillCart(lines);
  const res = await checkoutCall({ expectedTotal: quote.totalAmount });
  expect(res.statusCode, res.body).toBeLessThan(300);
  const order = await app.prisma.order.findFirstOrThrow({ where: { customerId: customer.userId }, orderBy: { createdAt: 'desc' }, include: { items: true } });
  return { quote, order };
}
/** The order's own money identity: Total = goods - discount + delivery + service + tip + the VAT line. */
async function totalsAddUp(orderId: string) {
  const o = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const n = (v: unknown) => Number(v);
  expect(n(o.totalAmount)).toBe(n(o.subtotalCustomer) - n(o.discount) + n(o.deliveryFee) + n(o.serviceFee) + n(o.tipAmount) + n(o.taxAmount));
  expect(n(o.taxAmount)).toBe(n(o.vatAmount));
  return o;
}

async function sendCertificate(extra: Record<string, unknown>) {
  return vendorCall('POST', '/vat/certificate', {
    fileUrl: await ownedVerificationFixture(app.prisma, ownerUserId), consent: true, privacyNoticeVersion: 'v1', ...extra,
  });
}
async function seenMode(id = vendorId) {
  const res = await call('GET', '/api/v1/admin/store-vat/pending', reviewerToken);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as Array<Record<string, unknown>>).find((r) => r['vendorId'] === id)?.['mode'] as string | null | undefined;
}
async function approveBody() {
  return {
    certificateDocId: (await vendorRow()).vatCertificateDocId!, vatNumber: VAT_NUMBER, registeredName: 'Aarna Trading',
    effectiveFrom: '2026-01-01', nameMatchesStore: true, mode: await seenMode(),
  };
}

async function makeStore(name: string, ownerId: string) {
  const vo = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId: ownerId } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `${name} ${RUN}`, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${RUN.toLowerCase()}`, vendorType: 'SUPERMARKET',
    phone: testPhone(), addressLine1: '3 Vat St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
  } });
  vendorIds.push(vendor.id);
  const categoryId = (await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 } })).id;
  return { id: vendor.id, categoryId };
}
const item = (store: { id: string; categoryId: string }, name: string, basePrice: number, vatClass: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT' = 'STANDARD') =>
  app.prisma.item.create({ data: { vendorId: store.id, categoryId: store.categoryId, name: word(name), basePrice, isAvailable: true, vatClass } }).then((i) => i.id);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['STORE_VAT'] = '1';
  process.env['STORE_VAT_EXCLUSIVE'] = '';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  const verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), {} as never);

  const owner = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Exclusive', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, countryCode: 'GY', selfieCapturedAt: new Date(),
  } });
  ownerUserId = owner.id; userIds.push(owner.id);
  ownerToken = await session(owner.id, 'VENDOR_OWNER');
  await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const store = await makeStore('Aarna Corner', owner.id);
  vendorId = store.id;
  const { checklist } = await verification.activationChecklist(owner.id, 'SUPERMARKET');
  for (const docType of checklist) {
    await app.prisma.verificationDocument.create({ data: {
      userId: owner.id, role: 'VENDOR_OWNER', docType, fileUrl: `verification/${RUN}/${docType}.enc`,
      status: 'APPROVED', reviewedBy: 'seed', reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1',
    } as never });
  }
  curryId = await item(store, 'Curry', 100);
  riceId = await item(store, 'Rice', 600, 'ZERO_RATED');
  saltId = await item(store, 'Salt', 600);
  juiceId = await item(store, 'Juice', 25);
  cakeId = await item(store, 'Cake', 75);

  const reviewer = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Reviewer', roles: ['SUPER_ADMIN', 'CUSTOMER'] as UserRole[], activeRole: 'SUPER_ADMIN',
    status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*', 'documents.review'] } },
  } });
  userIds.push(reviewer.id);
  reviewerToken = await session(reviewer.id, 'SUPER_ADMIN');

  const cust = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Diner', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER',
    isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  userIds.push(cust.id);
  const addr = await app.prisma.address.create({ data: { userId: cust.id, label: 'Home', addressLine1: '4 Diner St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
  customer = { userId: cust.id, token: await session(cust.id, 'CUSTOMER'), addressId: addr.id };
});

afterAll(async () => {
  process.env['STORE_VAT'] = '';
  process.env['STORE_VAT_EXCLUSIVE'] = '';
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: userIds } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const dids = docs.map((d) => d.id);
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.verificationDecisionOutbox.deleteMany({ where: { documentId: { in: dids } } });
  await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: dids } } } });
  await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: dids } } });
  await app.prisma.verificationDocument.deleteMany({ where: { id: { in: dids } } });
  const itemIds = (await app.prisma.item.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((i) => i.id);
  await app.prisma.stockMovement.deleteMany({ where: { itemId: { in: itemIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  const subscriptionIds = (await app.prisma.subscription.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((x) => x.id);
  await app.prisma.billingNoticeHandoff.deleteMany({ where: { notice: { OR: [{ subscriptionId: { in: subscriptionIds } }, { userId: { in: userIds } }] } } });
  await app.prisma.billingFeeNotice.deleteMany({ where: { OR: [{ subscriptionId: { in: subscriptionIds } }, { userId: { in: userIds } }] } });
  await app.prisma.billingDunningClock.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } });
  await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('1. deployed dark: with STORE_VAT_EXCLUSIVE off nobody can choose prices before VAT', () => {
  it('the settings and the one-submission certificate refuse it; nothing is filed; the store stays NONE', async () => {
    const before = await app.prisma.verificationDocument.count({ where: { userId: ownerUserId, docType: VAT_CERTIFICATE_DOC_TYPE } });
    const put = await vendorCall('PUT', '/vat', { registered: true, vatRegistrationNumber: VAT_NUMBER, mode: 'PRICES_EXCLUDE_VAT' });
    expect(put.statusCode, put.body).toBe(409);
    expect(codeOf(put)).toBe('VAT_MODE_NOT_AVAILABLE');
    const cert = await sendCertificate({ vatRegistrationNumber: VAT_NUMBER, mode: 'PRICES_EXCLUDE_VAT' });
    expect(cert.statusCode, cert.body).toBe(409);
    expect(codeOf(cert)).toBe('VAT_MODE_NOT_AVAILABLE');
    expect(await app.prisma.verificationDocument.count({ where: { userId: ownerUserId, docType: VAT_CERTIFICATE_DOC_TYPE } })).toBe(before);
    expect((await vendorRow()).vatStatus).toBe('NONE');
    const view = await vendorCall('GET', '/vat');
    expect(view.json().data.modesOffered).toEqual(['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT']);
  });
});

describe('2. switched on: one submission, a PERSON approves, the menu prices stay exactly as typed', () => {
  it('number + certificate + "prices before VAT" in one go: PENDING; offered first; prices and the store page unchanged', async () => {
    process.env['STORE_VAT_EXCLUSIVE'] = '1';
    const res = await sendCertificate({ vatRegistrationNumber: VAT_NUMBER, mode: 'PRICES_EXCLUDE_VAT' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ status: 'PENDING', mode: 'PRICES_EXCLUDE_VAT', effective: false, vatOnTop: false, addsVatToPrices: false });
    expect(res.json().data.modesOffered).toEqual(['PRICES_EXCLUDE_VAT', 'PRICES_INCLUDE_VAT']);
    expect((await storefront()).vat).toBeNull();
    const profile = await vendorCall('GET', '/profile');
    expect((profile.json().data.vendors as Array<Record<string, unknown>>).find((v) => v['id'] === vendorId)).toMatchObject({ vatPricesBeforeVat: true, vatAddsToPrices: false });
  });

  it('approved: VAT is never added INTO a price; the store page says prices exclude VAT; the store is told in its words', async () => {
    const res = await adminCall(`/store-vat/${vendorId}/approve`, await approveBody());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'APPROVED', mode: 'PRICES_EXCLUDE_VAT', effective: true, vatOnTop: true, addsVatToPrices: false });
    const curry = await app.prisma.item.findUniqueOrThrow({ where: { id: curryId } });
    expect(Number(curry.basePrice)).toBe(100);
    expect(curry.vatListedPrice).toBeNull();
    const page = await storefront();
    expect(page.vat).toEqual({ pricesIncludeVat: false, addedAtCheckout: true, ratePercent: 14 });
    expect(page.categories.flatMap((c) => c.items).find((i) => i.id === curryId)?.basePrice).toBe(100);
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: ownerUserId, title: 'Your VAT is approved' } });
    expect(notice.body).toContain('customers see the prices you type (before VAT), and VAT at 14% on your standard-rated items is added at checkout as its own line before the total');
  });
});

describe('3. the cart, checkout, order, rider cash, store figure, receipt and VAT report carry ONE "VAT 14%" line', () => {
  it('the quote: items as typed, then "VAT 14%" on the standard-rated goods only, inside the total', async () => {
    const quote = await fillCart([{ itemId: curryId, quantity: 3 }, { itemId: riceId, quantity: 1 }]);
    expect(quote.subtotalCustomer).toBe(900);
    expect(quote.taxAmount).toBe(42); // 14% of the 300 standard-rated; the zero-rated rice carries none
    expect(quote.totalAmount).toBe(900 + quote.deliveryFee + quote.tipAmount + 42);
    expect(quote.vendors[0]).toMatchObject({ taxAmount: 42, totalAmount: quote.totalAmount });
    expect(quote.vendors[0]!.vat).toMatchObject({ added: 42, ratePercent: 14, standardGoods: 300, zeroRatedGoods: 600 });
    // No "included" word: an older app (which reads only `included`) never says the VAT is inside these prices.
    expect(quote.vendors[0]!.vat).not.toHaveProperty('included');
  });

  it('an app that shows the total WITHOUT the VAT line cannot place the order at that total (409 PRICE_CHANGED)', async () => {
    const quote = await quoteNow();
    const res = await checkoutCall({ expectedTotal: quote.totalAmount - quote.taxAmount });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('PRICE_CHANGED');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  it('checkout charges exactly the quote: the order freezes the basis, the rate, the VAT line and the total', async () => {
    const quote = await quoteNow();
    const res = await checkoutCall({ expectedTotal: quote.totalAmount });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const order = await app.prisma.order.findFirstOrThrow({ where: { customerId: customer.userId }, orderBy: { createdAt: 'desc' }, include: { items: true } });
    deliveredOrderId = order.id;
    expect(Number(order.totalAmount)).toBe(quote.totalAmount);
    expect(order).toMatchObject({ vatOnTop: true, vatRateBps: 1400, vatSellerNumber: VAT_NUMBER, vatSellerName: 'Aarna Trading' });
    expect(Number(order.subtotalBase)).toBe(900);
    expect(Number(order.taxAmount)).toBe(42);
    expect(Number(order.vatAmount)).toBe(42);
    expect(Number(order.vatBase)).toBe(300);
    expect(order.items.map((i) => i.vatClass).sort()).toEqual(['STANDARD', 'ZERO_RATED']);
    expect(res.json().data.orders[0]).toMatchObject({ tax: 42, total: quote.totalAmount });
    await totalsAddUp(order.id);
  });

  it('the customer\'s order screen gets the VAT line and the basis', async () => {
    const res = await call('GET', `/api/v1/customer/orders/${deliveredOrderId}`, customer.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ subtotalCustomer: 900, taxAmount: 42, vatAmount: 42, vatOnTop: true, vatRateBps: 1400, vatSellerName: 'Aarna Trading' });
  });

  it('the rider pays the store the goods AND the VAT, and collects the whole total at the door', async () => {
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: deliveredOrderId }, select: CASH_MATH_SELECT });
    expect(riderFloatForOrder(order)).toBe(942);
    const card = cashMathForOffer(order)!;
    expect(card).toEqual({ collectFromCustomer: Number(order.totalAmount), payToVendor: 942, youKeep: Number(order.deliveryFee) + Number(order.tipAmount) });
  });

  it('the store sees the VAT as its own money (for the GRA), never the rider\'s fee', async () => {
    const res = await call('GET', `/api/v1/vendor/orders/${deliveredOrderId}`, ownerToken, undefined, { 'x-vendor-id': vendorId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.storeMoney).toMatchObject({ food: 942, addedTax: 42 });
    expect(res.json().data.storeMoney.lines[0]).toBe('Includes VAT 14% added at checkout: $42 (yours, for the GRA)');
  });

  it('the receipt: Items, delivery, then "VAT 14%", then the Total; the summary says the prices exclude VAT', async () => {
    await walkOrderStatus(app.prisma as never, deliveredOrderId, 'DELIVERED', { paymentStatus: 'CAPTURED', deliveredAt: new Date() });
    const receipt = await call('GET', `/api/v1/customer/orders/${deliveredOrderId}/receipt`, customer.token);
    expect(receipt.statusCode, receipt.body).toBe(200);
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: deliveredOrderId } });
    expect(receipt.body).toContain(`<tr class="totals"><td>VAT 14%</td><td class="num">GY$42 GYD</td></tr>\n    <tr class="grand"><td>Total</td><td class="num">GY$${Number(order.totalAmount).toLocaleString('en-US')} GYD</td></tr>`);
    expect(receipt.body).toContain('VAT added (14%)');
    expect(receipt.body).toContain(`VAT charged by Aarna Trading · VAT reg. no. ${VAT_NUMBER}. The prices of the goods exclude VAT`);
    expect(receipt.body).not.toMatch(/tax invoice</i);
  });

  it('the VAT report: standard-rated sales excluding VAT = the base, VAT charged = the line', async () => {
    const day = guyanaDayKey(new Date());
    const res = await vendorCall('GET', `/vat/report?from=${day}&to=${day}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.totals).toMatchObject({ orders: 1, standardRatedExclVat: 300, vatCharged: 42, zeroRatedSales: 600 });
  });
});

describe('4. one VAT amount per order, half-up to the whole dollar', () => {
  it('25 + 75 of standard-rated goods: VAT 14 (never 4 + 11 = 15)', async () => {
    const quote = await fillCart([{ itemId: juiceId, quantity: 1 }, { itemId: cakeId, quantity: 1 }]);
    expect(quote.subtotalCustomer).toBe(100);
    expect(quote.taxAmount).toBe(14);
    expect(quote.totalAmount).toBe(100 + quote.deliveryFee + quote.tipAmount + 14);
  });
});

describe('5. picking: a swap and a removed line move the VAT line and the total exactly as the customer is shown', () => {
  let orderId = '';
  let riceLineId = '';
  let curryLineId = '';
  const picking = () => new PickingService(app.prisma, app.io);

  it('an accepted order (curry 300 + rice 600): VAT 42', async () => {
    const { order } = await placeOrder([{ itemId: curryId, quantity: 3 }, { itemId: riceId, quantity: 1 }]);
    orderId = order.id;
    riceLineId = order.items.find((i) => i.itemId === riceId)!.id;
    curryLineId = order.items.find((i) => i.itemId === curryId)!.id;
    await walkOrderStatus(app.prisma as never, orderId, 'ACCEPTED', { acceptedAt: new Date(), holdExpiresAt: null });
    expect(Number((await totalsAddUp(orderId)).taxAmount)).toBe(42);
  });

  it('a same-price swap of the zero-rated rice for standard-rated salt: the card says +84, the yes charges +84', async () => {
    const before = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    await picking().proposeSubstitution(orderId, riceLineId, saltId, ownerUserId);
    const card = await call('GET', `/api/v1/customer/orders/${orderId}?swapDecisions=v2`, customer.token);
    expect(card.statusCode, card.body).toBe(200);
    const line = (card.json().data.items as Array<{ id: string; substitution: { priceDelta: number } | null }>).find((i) => i.id === riceLineId)!;
    expect(line.substitution!.priceDelta).toBe(84);
    await picking().decideSubstitution(orderId, riceLineId, customer.userId, true);
    const after = await totalsAddUp(orderId);
    expect(Number(after.totalAmount) - Number(before.totalAmount)).toBe(84);
    expect(Number(after.taxAmount)).toBe(126);
    expect(Number(after.vatBase)).toBe(900);
  });

  it('the store takes the curry off: the total drops by the line AND its VAT, and the push says so', async () => {
    const before = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    await picking().refundLine(orderId, curryLineId, ownerUserId);
    const after = await totalsAddUp(orderId);
    expect(Number(before.totalAmount) - Number(after.totalAmount)).toBe(342);
    expect(Number(after.taxAmount)).toBe(84);
    const push = await app.prisma.notification.findFirstOrThrow({ where: { userId: customer.userId, data: { path: ['kind'], equals: 'line_refunded' } }, orderBy: { createdAt: 'desc' } });
    expect(push.body).toContain('total went down by $342.');
  });
});

describe('6. the store\'s VAT changing between the quote and the commit refuses the checkout', () => {
  it('a withdrawal committing while checkout waits for the store\'s row: 409 CART_CHANGED, no order', async () => {
    await fillCart([{ itemId: curryId, quantity: 1 }]);
    const ordersBefore = await app.prisma.order.count({ where: { customerId: customer.userId } });
    let held!: () => void;
    const rowHeld = new Promise<void>((resolve) => { held = resolve; });
    let edit: Promise<unknown> | undefined;
    try {
      await expect(new OrderService(app.prisma, app.io).checkout({
        userId: customer.userId, paymentMethod: 'CASH',
        afterCartLock: async () => {
          edit = app.prisma.$transaction(async (tx) => {
            await tx.vendor.update({ where: { id: vendorId }, data: { vatStatus: 'REVOKED' } });
            held();
            await new Promise((resolve) => setTimeout(resolve, 400));
          });
          await rowHeld;
        },
      } as never)).rejects.toMatchObject({ statusCode: 409, code: 'CART_CHANGED' });
      await edit;
      expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(ordersBefore);
    } finally {
      await edit?.catch(() => undefined);
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { vatStatus: 'APPROVED' } });
    }
  });
});

describe('6b. an item\'s VAT class changing between the quote and the commit refuses the checkout', () => {
  it('curry marked zero-rated while checkout waits for its row: the VAT the order would carry is not the VAT shown -> 409 CART_CHANGED', async () => {
    await fillCart([{ itemId: curryId, quantity: 1 }]);
    const ordersBefore = await app.prisma.order.count({ where: { customerId: customer.userId } });
    let held!: () => void;
    const rowHeld = new Promise<void>((resolve) => { held = resolve; });
    let edit: Promise<unknown> | undefined;
    try {
      await expect(new OrderService(app.prisma, app.io).checkout({
        userId: customer.userId, paymentMethod: 'CASH',
        afterCartLock: async () => {
          edit = app.prisma.$transaction(async (tx) => {
            await tx.item.update({ where: { id: curryId }, data: { vatClass: 'ZERO_RATED' } });
            held();
            await new Promise((resolve) => setTimeout(resolve, 400));
          });
          await rowHeld;
        },
      } as never)).rejects.toMatchObject({ statusCode: 409, code: 'CART_CHANGED' });
      await edit;
      expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(ordersBefore);
    } finally {
      await edit?.catch(() => undefined);
      await app.prisma.item.update({ where: { id: curryId }, data: { vatClass: 'STANDARD' } });
    }
  });
});

describe('7. a switch flip never changes what a customer pays', () => {
  it('STORE_VAT or STORE_VAT_EXCLUSIVE off: an approved store pricing before VAT keeps its VAT line', async () => {
    try {
      process.env['STORE_VAT'] = '';
      expect((await fillCart([{ itemId: curryId, quantity: 1 }])).taxAmount).toBe(14);
      process.env['STORE_VAT'] = '1';
      process.env['STORE_VAT_EXCLUSIVE'] = '';
      expect((await quoteNow()).taxAmount).toBe(14);
    } finally {
      process.env['STORE_VAT'] = '1';
      process.env['STORE_VAT_EXCLUSIVE'] = '1';
    }
  });
});

describe('8. a store approved on "VAT added into the price" keeps it until a PERSON approves prices before VAT', () => {
  let addStore = { id: '', categoryId: '' };
  let soapId = '';
  it('approved on ADD_VAT_AT_CHECKOUT (before this release): 114 on the menu; re-saving its choice changes nothing', async () => {
    addStore = await makeStore('Older Mart', ownerUserId);
    soapId = await item(addStore, 'Soap', 100);
    await app.prisma.vendor.update({ where: { id: addStore.id }, data: {
      vatRegistrationNumber: '045678912', vatStatus: 'APPROVED', vatMode: 'ADD_VAT_AT_CHECKOUT', vatApprovedNumber: '045678912',
      vatApprovedName: 'Older Mart Ltd', vatEffectiveFrom: new Date('2026-01-01T00:00:00Z'), vatReviewedAt: new Date(),
    } });
    await app.prisma.$transaction((tx) => reconcileVatPricing(tx, addStore.id));
    expect(Number((await app.prisma.item.findUniqueOrThrow({ where: { id: soapId } })).basePrice)).toBe(114);
    const resave = await call('PUT', '/api/v1/vendor/vat', ownerToken, { registered: true, mode: 'ADD_VAT_AT_CHECKOUT' }, { 'x-vendor-id': addStore.id });
    expect(resave.statusCode, resave.body).toBe(200);
    expect(resave.json().data).toMatchObject({ status: 'APPROVED', mode: 'ADD_VAT_AT_CHECKOUT', modeRequested: null, addsVatToPrices: true });
    expect((await fillCart([{ itemId: soapId, quantity: 1 }], addStore.id)).taxAmount).toBe(0);
  });

  it('it asks for prices before VAT; nothing moves until a person approves; then typed prices back and a VAT line', async () => {
    const ask = await call('PUT', '/api/v1/vendor/vat', ownerToken, { registered: true, mode: 'PRICES_EXCLUDE_VAT' }, { 'x-vendor-id': addStore.id });
    expect(ask.statusCode, ask.body).toBe(200);
    expect(ask.json().data).toMatchObject({ mode: 'ADD_VAT_AT_CHECKOUT', modeRequested: 'PRICES_EXCLUDE_VAT' });
    expect(Number((await app.prisma.item.findUniqueOrThrow({ where: { id: soapId } })).basePrice)).toBe(114);
    const res = await adminCall(`/store-vat/${addStore.id}/mode`, { approve: true, mode: 'PRICES_EXCLUDE_VAT' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ mode: 'PRICES_EXCLUDE_VAT', vatOnTop: true, addsVatToPrices: false });
    const soap = await app.prisma.item.findUniqueOrThrow({ where: { id: soapId } });
    expect(Number(soap.basePrice)).toBe(100);
    expect(soap.vatListedPrice).toBeNull();
    const quote = await fillCart([{ itemId: soapId, quantity: 1 }], addStore.id);
    expect(quote.subtotalCustomer).toBe(100);
    expect(quote.taxAmount).toBe(14);
  });

  it('a claim still waiting on "VAT added into the price" (filed before the switch) cannot be approved: the store chooses again', async () => {
    const pendingStore = await makeStore('Waiting Mart', ownerUserId);
    const cert = await app.prisma.verificationDocument.create({ data: {
      userId: ownerUserId, role: 'VENDOR_OWNER', docType: VAT_CERTIFICATE_DOC_TYPE, fileUrl: `verification/${RUN}/vat-waiting.enc`,
      status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
    } as never });
    await app.prisma.vendor.update({ where: { id: pendingStore.id }, data: {
      vatRegistrationNumber: '056789123', vatStatus: 'PENDING', vatMode: 'ADD_VAT_AT_CHECKOUT', vatCertificateDocId: cert.id,
    } });
    const res = await adminCall(`/store-vat/${pendingStore.id}/approve`, {
      certificateDocId: cert.id, vatNumber: '056789123', registeredName: 'Waiting Mart Ltd', effectiveFrom: '2026-01-01',
      nameMatchesStore: true, mode: 'ADD_VAT_AT_CHECKOUT',
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('VAT_MODE_NOT_AVAILABLE');
    expect((await vendorRow(pendingStore.id)).vatStatus).toBe('PENDING');
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: cert.id } })).status).toBe('PENDING');
    // Its next certificate must carry a choice offered now (nothing is filed until it does).
    const { vatClaimForCertificate } = await import('../modules/store-vat/store-vat-decisions');
    expect(() => vatClaimForCertificate({ vatRegistrationNumber: '056789123', vatMode: 'ADD_VAT_AT_CHECKOUT' }, {}, { STORE_VAT: '1', STORE_VAT_EXCLUSIVE: '1' }))
      .toThrow(expect.objectContaining({ code: 'VAT_MODE_NOT_AVAILABLE' }));
    expect(vatClaimForCertificate({ vatRegistrationNumber: '056789123', vatMode: 'ADD_VAT_AT_CHECKOUT' }, {}, { STORE_VAT: '1' }))
      .toEqual({ vatRegistrationNumber: '056789123', vatMode: 'ADD_VAT_AT_CHECKOUT' });
  });

  it('a change back to "VAT added into the price" is no longer offered: a person can only refuse it', async () => {
    const ask = await call('PUT', '/api/v1/vendor/vat', ownerToken, { registered: true, mode: 'ADD_VAT_AT_CHECKOUT' }, { 'x-vendor-id': addStore.id });
    expect(ask.statusCode, ask.body).toBe(409);
    expect(codeOf(ask)).toBe('VAT_MODE_NOT_AVAILABLE');
  });
});

describe('9. withdrawn: no VAT line on new carts; a placed order keeps its VAT and its total', () => {
  it('a person withdraws the store\'s VAT', async () => {
    const placed = await app.prisma.order.findUniqueOrThrow({ where: { id: deliveredOrderId } });
    const res = await adminCall(`/store-vat/${vendorId}/revoke`, { reason: 'The GRA cancelled the registration this month.' });
    expect(res.statusCode, res.body).toBe(200);
    const quote = await fillCart([{ itemId: curryId, quantity: 1 }]);
    expect(quote.taxAmount).toBe(0);
    expect(quote.vendors[0]!.vat).toBeNull();
    expect((await storefront()).vat).toBeNull();
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: deliveredOrderId } });
    expect(Number(after.taxAmount)).toBe(Number(placed.taxAmount));
    expect(Number(after.totalAmount)).toBe(Number(placed.totalAmount));
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: ownerUserId, title: 'Your VAT was withdrawn' } });
    expect(notice.body).toContain('VAT is no longer added at checkout, so customers pay the prices you typed.');
  });
});
