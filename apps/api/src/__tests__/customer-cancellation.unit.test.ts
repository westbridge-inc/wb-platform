import { describe, expect, it, vi } from 'vitest';
import { customerRoutes } from '../modules/user/customer.routes';
import { SYSTEM_CANCELLATION_WORDS } from '@swift/types';
import {
  CUSTOMER_REASON_MAX,
  SYSTEM_CANCELLATION_CODES,
  VENDOR_NO_RESPONSE_REASON,
  customerCancellation,
  NO_ORDER_PEOPLE,
  customerSafeReason,
  orderPeople,
  senderCancellationView,
  type OrderPeople,
} from '../modules/order/customer-cancellation';
import { NOT_COLLECTED_REASON } from '../modules/order/pickup-not-collected';
import { NO_SHOW_REASON } from '../modules/booking/appointment-no-show';
import { PASSENGER_NO_SHOW_REASON } from '../modules/rides/passenger-no-show';
import { MMG_ACCEPT_EXPIRY_REASON } from '../modules/order/mmg-accept-expiry';
import { FOOD_TOO_OLD_REASON, NO_RIDER_FOR_PARCEL_REASON } from '../modules/dispatch/rescue';
import {
  foodDelivery,
  hostRoutes,
  orderStore,
  prismaDouble,
  recordingIo,
  recordingRedis,
  serviceBooking,
  type Row,
} from './helpers/service-vertical-doubles';

vi.mock('../modules/compliance/prohibited-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/compliance/prohibited-gate')>()),
  prohibitedStoreIds: async () => [],
  prohibitedStoreCategory: async () => null,
  storeHiddenFromCustomers: async () => false,
}));

// ---------------------------------------------------------------------------
// [owner 8 Nov 2026] "When the store says out of stock and rejects it, it should
// tell the customer it was rejected because of out of stock, not just that it
// cancels."
//
// The store's decline wrote `cancelledBy` (the staff member's user id) and
// `cancellationReason` ("Out of stock"), and pushed the reason, but the
// customer's activity list said only "Cancelled" and the order screen gave no
// reason. The customer reads now carry `cancellation: { by, reason }`: who closed
// it in the customer's terms, and only a reason the customer may read. The user
// id behind `cancelledBy` is never sent.
//
// These drive the REAL customer route handlers on the recording stand-in
// (helpers/service-vertical-doubles): the fixtures hold exactly what the store's
// decline (vendor.routes PUT /orders/:id/reject), the customer's cancel, the
// no-response job and Swift support's cancel write. Nothing opens a service.
// ---------------------------------------------------------------------------

const STAFF = 'user-staff';
const OWNER = 'user-cook'; // foodDelivery()'s store owner
const ADMIN = 'user-admin';

type FindManyArgs = { where: Record<string, any>; select?: Record<string, unknown> };

/** The users as the database holds them: Swift support holds a console role; the store's people do not. A staff
 *  member removed from the store, or an account deleted, simply has no admin role (or no row at all). */
const USERS: Record<string, { roles: string[] }> = {
  [ADMIN]: { roles: ['CUSTOMER', 'ADMIN'] },
  'user-super': { roles: ['SUPER_ADMIN'] },
  [STAFF]: { roles: ['CUSTOMER'] },
  [OWNER]: { roles: ['VENDOR_OWNER', 'CUSTOMER'] },
  'user-provider': { roles: ['VENDOR_OWNER'] },
  // A Swift support person whose console role was since removed (staff change, re-seed).
  'user-ex-admin': { roles: ['CUSTOMER'] },
  // One of the store's own staff who also holds a console role (an owner-run demo store, a tablet on an admin account).
  'user-admin-staff': { roles: ['CUSTOMER', 'SUPER_ADMIN'] },
};

/** The store's staff today (vendor_staff rows); each store's owner comes with its fixture (vendor.owner.userId). */
const STAFF_OF: Record<string, string[]> = { 'vendor-food': [STAFF, 'user-admin-staff'] };
const OWNER_OF: Record<string, string> = { 'vendor-food': OWNER, 'vendor-svc': 'user-provider' };

type AuditRow = { entityId: string; userId: string | null; action: string };

/** The append-only audit rows as Swift's console writes them (admin cancel: CANCEL_ORDER; MMG store close: the route row). */
function auditDouble(rows: AuditRow[]) {
  return vi.fn(async (args: FindManyArgs) => {
    const orderIds: string[] = args.where['entityId']?.in ?? [];
    const userIds: string[] = args.where['userId']?.in ?? [];
    const kinds = args.where['OR'] as Array<{ action: string | { startsWith: string } }>;
    const kindOk = (action: string) => kinds.some((k) => (typeof k.action === 'string' ? action === k.action : action.startsWith(k.action.startsWith)));
    return rows.filter((r) => orderIds.includes(r.entityId) && r.userId && userIds.includes(r.userId) && kindOk(r.action));
  });
}
const membershipDoubles = () => ({
  vendor: {
    findUnique: async () => ({ status: 'ACTIVE', publicPhone: null }),
    findMany: async (args: FindManyArgs) => (args.select?.['owner']
      ? (args.where['id']?.in ?? []).filter((id: string) => OWNER_OF[id]).map((id: string) => ({ id, owner: { userId: OWNER_OF[id] } }))
      : []),
  },
  vendorStaff: {
    findMany: async (args: FindManyArgs) => (args.where['vendorId']?.in ?? []).flatMap((vendorId: string) => (STAFF_OF[vendorId] ?? [])
      .filter((userId) => (args.where['userId']?.in ?? []).includes(userId)).map((userId) => ({ vendorId, userId }))),
  },
});
function userRoles() {
  return vi.fn(async (args: FindManyArgs) => {
    const ids: string[] = args.where['id']?.in ?? [];
    return ids.filter((id) => USERS[id]).map((id) => ({ id, roles: USERS[id]!.roles }));
  });
}

async function customerHost(rows: Row[], audits: AuditRow[] = []) {
  const store = orderStore(rows);
  const users = userRoles();
  const auditLog = auditDouble(audits);
  const prisma = prismaDouble(store, {
    platformConfig: { findUnique: async () => null, findMany: async () => [] },
    customer: { findUnique: async () => ({ id: 'cust-1', userId: 'user-customer', referralCode: 'REF1' }) },
    ...membershipDoubles(),
    auditLog: { findMany: auditLog },
    item: { findMany: async () => [] },
    user: { findUnique: async () => ({ countryCode: 'GY' }), findMany: users },
    countryConfig: { findUnique: async () => null },
    rating: { findMany: async () => [] },
    dispatchSearch: { findFirst: async () => null },
  });
  const host = await hostRoutes(customerRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
  return { ...host, store, users, auditLog };
}

const asCustomer = (extra: Record<string, unknown> = {}) => ({ user: { userId: 'user-customer', role: 'CUSTOMER' }, ...extra });
type List = { success: boolean; data: Row[] };
type Detail = { success: boolean; data: Row };

/** What the store's decline writes (vendor.routes PUT /orders/:id/reject → transitionOrderAtomically). */
const declinedBy = (userId: string, reason: string): Row => ({
  status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: userId, cancellationReason: reason,
});

describe('GET /customer/orders and /customer/orders/:id — a store decline says so, with the store’s reason', () => {
  it('RED reproduction — the declined order SW-…003K2E: the list row and the order screen carry "declined by the store: Out of stock"', async () => {
    const h = await customerHost([foodDelivery('food-1', declinedBy(STAFF, 'Out of stock'))]);
    const list = (await h.call('get /orders', asCustomer())) as List;
    expect(list.success).toBe(true);
    expect(list.data[0]).toMatchObject({ id: 'food-1', status: 'CANCELLED', cancellation: { by: 'STORE', reason: 'Out of stock' } });
    const detail = (await h.call('get /orders/:id', asCustomer({ params: { id: 'food-1' } }))) as Detail;
    expect(detail.data['cancellation']).toEqual({ by: 'STORE', reason: 'Out of stock' });
    // The staff member's user id never reaches the customer, on either read.
    expect(JSON.stringify(list.data)).not.toContain(STAFF);
    expect(JSON.stringify(detail.data)).not.toContain(STAFF);
  });

  it('the store owner’s decline reads the same as a staff member’s; a provider’s decline of a booking too', async () => {
    const h = await customerHost([
      foodDelivery('food-owner', declinedBy(OWNER, 'Kitchen is too busy')),
      serviceBooking('bk-1', declinedBy('user-provider', 'Fully booked at that time')),
    ]);
    const list = (await h.call('get /orders', asCustomer())) as List;
    const by = Object.fromEntries(list.data.map((o) => [o['id'], o['cancellation']]));
    expect(by['food-owner']).toEqual({ by: 'STORE', reason: 'Kitchen is too busy' });
    expect(by['bk-1']).toEqual({ by: 'STORE', reason: 'Fully booked at that time' });
  });

  it('the cancellers’ roles are read once for the page, only for rows cancelled by someone other than the customer', async () => {
    const h = await customerHost([
      foodDelivery('food-1', declinedBy(STAFF, 'Out of stock')),
      foodDelivery('food-2', declinedBy('user-customer', 'changed my mind')),
      foodDelivery('food-3', { status: 'DELIVERED' }),
      foodDelivery('food-4', { status: 'CANCELLED', cancelledBy: 'system', cancellationReason: 'FOOD_TOO_OLD' }),
    ]);
    await h.call('get /orders', asCustomer());
    expect(h.users).toHaveBeenCalledTimes(1);
    expect(h.users.mock.calls[0]![0]).toEqual({ where: { id: { in: [STAFF] } }, select: { id: true, roles: true } });
  });

  it('no cancelled row cancelled by another person: no read at all', async () => {
    const h = await customerHost([foodDelivery('food-1', { status: 'DELIVERED' }), foodDelivery('food-2', declinedBy('user-customer', 'x'))]);
    await h.call('get /orders', asCustomer());
    expect(h.users).not.toHaveBeenCalled();
  });

  it('a decline by a staff member since removed from the store, or whose account is gone, still reads as the store’s', async () => {
    const h = await customerHost([
      foodDelivery('removed', declinedBy('user-former-staff', 'Out of stock')),
      foodDelivery('gone', declinedBy('user-deleted-account', 'Closing soon')),
    ]);
    const list = (await h.call('get /orders', asCustomer())) as List;
    const by = Object.fromEntries(list.data.map((o) => [o['id'], o['cancellation']]));
    expect(by).toEqual({ removed: { by: 'STORE', reason: 'Out of stock' }, gone: { by: 'STORE', reason: 'Closing soon' } });
  });

  it('Swift support’s cancel: never its note, on the list or the order screen (the raw reason is blanked too)', async () => {
    const note = 'Fraud check: card flagged, call back';
    const h = await customerHost([foodDelivery('support', declinedBy(ADMIN, note)), foodDelivery('super', declinedBy('user-super', note))]);
    const list = (await h.call('get /orders', asCustomer())) as List;
    expect(list.data.map((o) => o['cancellation'])).toEqual([{ by: 'SWIFT', reason: null }, { by: 'SWIFT', reason: null }]);
    const detail = (await h.call('get /orders/:id', asCustomer({ params: { id: 'support' } }))) as Detail;
    expect(detail.data['cancellation']).toEqual({ by: 'SWIFT', reason: null });
    expect(detail.data['cancellationReason']).toBeNull();
    expect(JSON.stringify(detail.data)).not.toContain('Fraud check');
    expect(JSON.stringify(detail.data)).not.toContain(ADMIN);
  });

  it('each other way an order closes keeps its own words, and only a reason the customer may read', async () => {
    const h = await customerHost([
      // The customer's own cancel: their note is never echoed back.
      foodDelivery('mine', declinedBy('user-customer', 'changed my mind')),
      // The store never answered (jobs/queue.ts autoCancelUnresponsiveOrder).
      foodDelivery('silent', { status: 'CANCELLED', cancelledBy: null, cancellationReason: VENDOR_NO_RESPONSE_REASON }),
      // Swift support: the operator's note stays with Swift.
      foodDelivery('support', declinedBy(ADMIN, 'Fraud check: card flagged, call back')),
      // The store recorded a pickup nobody collected: a no-show, not a decline.
      foodDelivery('uncollected', { ...declinedBy(OWNER, NOT_COLLECTED_REASON), fulfillment: 'PICKUP' }),
      // A system close: the code, which the apps put in words.
      foodDelivery('cold', { status: 'CANCELLED', cancelledBy: 'system', cancellationReason: 'FOOD_TOO_OLD' }),
      // An unknown system code never reaches the customer, nor a system sentence this build does not know.
      foodDelivery('code', { status: 'CANCELLED', cancelledBy: null, cancellationReason: 'SOME_INTERNAL_CODE' }),
      foodDelivery('sentence', { status: 'CANCELLED', cancelledBy: null, cancellationReason: 'Ops sweep: duplicate of order 41' }),
      // A live order: no cancellation.
      foodDelivery('live', { status: 'PREPARING' }),
    ]);
    const list = (await h.call('get /orders', asCustomer())) as List;
    const by = Object.fromEntries(list.data.map((o) => [o['id'], o['cancellation']]));
    expect(by).toEqual({
      mine: { by: 'CUSTOMER', reason: null },
      silent: { by: 'NO_RESPONSE', reason: null },
      support: { by: 'SWIFT', reason: null },
      uncollected: { by: 'NO_SHOW', reason: null },
      cold: { by: 'SYSTEM', reason: 'FOOD_TOO_OLD' },
      code: { by: 'SYSTEM', reason: null },
      sentence: { by: 'SYSTEM', reason: null },
      live: null,
    });
    expect(JSON.stringify(list.data)).not.toContain('Fraud check');
    expect(JSON.stringify(list.data)).not.toContain(ADMIN);
  });

  it('[REVIEW-2 F2] a cancel by a Swift support person who has since lost the console role stays Swift’s (its audit row)', async () => {
    const note = 'Store owner says this customer is a scammer, call him back';
    const h = await customerHost(
      [foodDelivery('ex', declinedBy('user-ex-admin', note)), foodDelivery('mmg', declinedBy('user-ex-admin', 'Refund handled by the store'))],
      [
        { entityId: 'ex', userId: 'user-ex-admin', action: 'CANCEL_ORDER' },
        { entityId: 'mmg', userId: 'user-ex-admin', action: 'ADMIN POST /api/v1/admin/orders/:id/close-store-refund' },
      ],
    );
    const list = (await h.call('get /orders', asCustomer())) as List;
    expect(list.data.map((o) => o['cancellation'])).toEqual([{ by: 'SWIFT', reason: null }, { by: 'SWIFT', reason: null }]);
    const detail = (await h.call('get /orders/:id', asCustomer({ params: { id: 'ex' } }))) as Detail;
    expect(detail.data['cancellation']).toEqual({ by: 'SWIFT', reason: null });
    expect(detail.data['cancellationReason']).toBeNull();
    expect(JSON.stringify(detail.data)).not.toContain('scammer');
  });

  it('[REVIEW-2 F3] the store’s own staff member holding a console role declines from the store: the store, with its reason', async () => {
    const h = await customerHost([foodDelivery('demo', declinedBy('user-admin-staff', 'Out of stock'))]);
    const list = (await h.call('get /orders', asCustomer())) as List;
    expect(list.data[0]!['cancellation']).toEqual({ by: 'STORE', reason: 'Out of stock' });
    const detail = (await h.call('get /orders/:id', asCustomer({ params: { id: 'demo' } }))) as Detail;
    expect(detail.data['cancellation']).toEqual({ by: 'STORE', reason: 'Out of stock' });
    expect(JSON.stringify(detail.data)).not.toContain('user-admin-staff');
  });

  it('[REVIEW-2 F1] the order’s timeline never carries Swift support’s note, and the CANCELLED step says only the customer’s words', async () => {
    const at = (m: number) => new Date(Date.now() - (60 - m) * 60_000);
    const step = (status: string, note: string | null, changedBy: string | null, m: number) => ({ id: `s${m}`, orderId: 'support', status, note, changedBy, createdAt: at(m) });
    const h = await customerHost(
      [
        foodDelivery('support', {
          ...declinedBy('user-ex-admin', 'Fraud check: card flagged, call back on 6001234'),
          statusHistory: [
            step('PENDING', 'Order placed', 'user-customer', 1),
            step('ACCEPTED', 'Accepted — ready in 20 min', OWNER, 2),
            // A console action on the order (audited) by a person who has since lost the role: still Swift's note.
            step('PREPARING', 'Ops: customer flagged by the store owner', 'user-ex-admin', 3),
            // A console user's step today (no audit row needed).
            step('PREPARING', 'Support: chased the kitchen', ADMIN, 4),
            step('CANCELLED', 'Fraud check: card flagged, call back on 6001234', 'user-ex-admin', 5),
          ],
        }),
        foodDelivery('declined', {
          ...declinedBy(STAFF, 'Out\u202E of stock\nsorry'),
          statusHistory: [step('PENDING', 'Order placed', 'user-customer', 1), step('CANCELLED', 'Out\u202E of stock\nsorry', STAFF, 2)],
        }),
      ],
      [
        { entityId: 'support', userId: 'user-ex-admin', action: 'ADMIN POST /api/v1/admin/orders/:id/reassign' },
        { entityId: 'support', userId: 'user-ex-admin', action: 'CANCEL_ORDER' },
      ],
    );
    const support = (await h.call('get /orders/:id', asCustomer({ params: { id: 'support' } }))) as Detail;
    const timeline = support.data['timeline'] as Array<{ status: string; note: string | null }>;
    expect(timeline.map((e) => [e.status, e.note])).toEqual([
      ['PENDING', 'Order placed'],
      ['ACCEPTED', 'Accepted — ready in 20 min'],
      ['PREPARING', null],
      ['PREPARING', null],
      ['CANCELLED', null],
    ]);
    const body = JSON.stringify(support.data);
    for (const leak of ['Fraud check', '6001234', 'flagged', 'chased', 'user-ex-admin', ADMIN]) expect(body).not.toContain(leak);

    const declined = (await h.call('get /orders/:id', asCustomer({ params: { id: 'declined' } }))) as Detail;
    // The store's reason, as cleanly as `cancellation.reason` (one line, no direction override).
    expect((declined.data['timeline'] as Array<{ status: string; note: string | null }>).map((e) => e.note)).toEqual(['Order placed', 'Out of stock sorry']);
    expect(declined.data['cancellation']).toEqual({ by: 'STORE', reason: 'Out of stock sorry' });
  });

  it('additive: every field an older app reads is unchanged beside the new one', async () => {
    const h = await customerHost([foodDelivery('food-1', declinedBy(STAFF, 'Out of stock'))]);
    const detail = (await h.call('get /orders/:id', asCustomer({ params: { id: 'food-1' } }))) as Detail;
    expect(detail.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Out of stock', cancellationNotice: null, canCancel: false });
  });
});

describe('customerCancellation — who closed it, in the customer’s terms', () => {
  const base = { id: 'o1', status: 'CANCELLED', customerId: 'cust', vendorId: 'v1', orderNumber: 'SW-1', fulfillment: 'DELIVERY' };
  const swift: OrderPeople = { ...NO_ORDER_PEOPLE, consoleStaff: (userId) => userId === 'admin', actedAsSwift: (_o, userId) => userId === 'admin' };
  const view = (cancelledBy: string | null, cancellationReason: string | null, extra: Record<string, unknown> = {}, people: OrderPeople = swift) =>
    customerCancellation({ ...base, cancelledBy, cancellationReason, ...extra }, people, 'Bourda Cafe');

  it('[REVIEW-2 F2] Swift support’s own audit row decides, even after the person lost the console role', () => {
    const closedBy = (orderId: string, userId: string) => orderId === 'o1' && userId === 'ex-admin';
    const people: OrderPeople = { ...NO_ORDER_PEOPLE, closedBySwift: closedBy };
    expect(view('ex-admin', 'Customer flagged by the store owner, do not serve', {}, people)).toEqual({ by: 'SWIFT', reason: null });
    // Without the audit row the same person on a store order would read as the store's (the old answer).
    expect(view('ex-admin', 'Out of stock', {}, NO_ORDER_PEOPLE)).toEqual({ by: 'STORE', reason: 'Out of stock' });
    // The row is about THIS order: another order's audit row decides nothing here.
    expect(view('ex-admin', 'Out of stock', { id: 'o2' }, people)).toEqual({ by: 'STORE', reason: 'Out of stock' });
  });

  it('[REVIEW-2 F3] the store’s own person is the store, even holding a console role, when there is no Swift close row', () => {
    const people: OrderPeople = { ...NO_ORDER_PEOPLE, consoleStaff: () => true, actedAsSwift: () => true, storeMember: (v, u) => v === 'v1' && u === 'admin-staff' };
    expect(view('admin-staff', 'Out of stock', {}, people)).toEqual({ by: 'STORE', reason: 'Out of stock' });
    // The same person closing it from Swift's console (its audit row) is Swift.
    expect(view('admin-staff', 'Out of stock', {}, { ...people, closedBySwift: () => true })).toEqual({ by: 'SWIFT', reason: null });
    // Membership of ANOTHER store does not make them this store.
    expect(view('admin-staff', 'Out of stock', { vendorId: 'v2' }, people)).toEqual({ by: 'SWIFT', reason: null });
  });

  it('null on an order that is not cancelled', () => {
    expect(customerCancellation({ ...base, status: 'DELIVERED', cancelledBy: null, cancellationReason: null }, swift, 'x')).toBeNull();
    expect(customerCancellation({ ...base, status: 'REFUNDED', cancelledBy: 'staff', cancellationReason: 'Out of stock' }, swift, 'x')).toBeNull();
  });

  it('every branch', () => {
    expect(view('staff', 'Out of stock')).toEqual({ by: 'STORE', reason: 'Out of stock' });
    expect(view('cust', 'changed my mind')).toEqual({ by: 'CUSTOMER', reason: null });
    expect(view(null, VENDOR_NO_RESPONSE_REASON)).toEqual({ by: 'NO_RESPONSE', reason: null });
    expect(view('staff', NOT_COLLECTED_REASON)).toEqual({ by: 'NO_SHOW', reason: null });
    expect(view('staff', NO_SHOW_REASON)).toEqual({ by: 'NO_SHOW', reason: null });
    expect(view('driver-user', PASSENGER_NO_SHOW_REASON, { vendorId: null })).toEqual({ by: 'NO_SHOW', reason: null });
    expect(view('admin', 'Cancelled by admin')).toEqual({ by: 'SWIFT', reason: null });
    expect(view('admin', 'Out of stock')).toEqual({ by: 'SWIFT', reason: null });
    // The operator's default reason is Swift's even if that account later lost its role.
    expect(view('former-admin', 'Cancelled by admin')).toEqual({ by: 'SWIFT', reason: null });
    // Any other person on a store order is the store, whether or not they still work there.
    expect(view('former-staff', 'Out of stock')).toEqual({ by: 'STORE', reason: 'Out of stock' });
    // A ride or a parcel has no store: anyone else is Swift support.
    expect(view('someone', 'Out of stock', { vendorId: null })).toEqual({ by: 'SWIFT', reason: null });
    expect(view(null, 'NO_DRIVERS_AVAILABLE', { vendorId: null })).toEqual({ by: 'SYSTEM', reason: 'NO_DRIVERS_AVAILABLE' });
    expect(view('system', 'NO_RIDER_FOR_PARCEL', { vendorId: null })).toEqual({ by: 'SYSTEM', reason: 'NO_RIDER_FOR_PARCEL' });
    expect(view(null, null)).toEqual({ by: 'SYSTEM', reason: null });
    expect(view(null, 'Some sentence the system never writes')).toEqual({ by: 'SYSTEM', reason: null });
  });

  it('the API passes exactly the automatic-close codes the apps have words for (the API cannot load @swift/types values)', () => {
    expect([...SYSTEM_CANCELLATION_CODES].sort()).toEqual(Object.keys(SYSTEM_CANCELLATION_WORDS).sort());
    // The codes the closes really write.
    expect(SYSTEM_CANCELLATION_CODES.has(FOOD_TOO_OLD_REASON)).toBe(true);
    expect(SYSTEM_CANCELLATION_CODES.has(NO_RIDER_FOR_PARCEL_REASON)).toBe(true);
  });

  it('an unpaid-MMG close carries the customer’s sentence, never the store’s', () => {
    const v = view(null, MMG_ACCEPT_EXPIRY_REASON);
    expect(v?.by).toBe('SYSTEM');
    expect(v?.reason).toMatch(/^No MMG payment was confirmed within 30 minutes of Bourda Cafe accepting/);
  });

  it('the only-item-left close speaks to the customer as "you"', () => {
    expect(view(null, 'Out of stock: Chicken roti was the only item and the customer did not answer in time'))
      .toEqual({ by: 'SYSTEM', reason: 'Out of stock: Chicken roti was the only item and you didn’t answer in time' });
  });
});

describe('customerSafeReason — a store’s typed reason, made safe to show', () => {
  it('one clean line', () => {
    expect(customerSafeReason('  Out\nof\tstock  ')).toBe('Out of stock');
    expect(customerSafeReason('Out\u202Eof stock\u200B')).toBe('Out of stock');
    expect(customerSafeReason('')).toBeNull();
    expect(customerSafeReason('   ')).toBeNull();
    expect(customerSafeReason(null)).toBeNull();
    expect(customerSafeReason(42)).toBeNull();
  });

  it('a code-shaped reason is never shown', () => {
    expect(customerSafeReason('REJECTED_BY_VENDOR')).toBeNull();
  });

  it('a long reason is cut at the limit with an ellipsis', () => {
    const cut = customerSafeReason('x'.repeat(500))!;
    expect(cut.length).toBe(CUSTOMER_REASON_MAX);
    expect(cut.endsWith('…')).toBe(true);
    expect(customerSafeReason('y'.repeat(CUSTOMER_REASON_MAX))).toBe('y'.repeat(CUSTOMER_REASON_MAX));
  });
});

describe('orderPeople — who is who, read once for the page', () => {
  const order = (id: string, cancelledBy: string, vendorId: string | null = 'vendor-food') => ({ id, status: 'CANCELLED', customerId: 'c', cancelledBy, vendorId });

  it('console roles, Swift’s audit rows (by order and person) and the store’s people, one read of each', async () => {
    const users = userRoles();
    const auditLog = auditDouble([
      { entityId: 'o-ex', userId: 'user-ex-admin', action: 'CANCEL_ORDER' },
      { entityId: 'o-mmg', userId: 'user-ex-admin', action: 'ADMIN POST /api/v1/admin/orders/:id/close-store-refund' },
      { entityId: 'o-other', userId: 'user-ex-admin', action: 'ADMIN POST /api/v1/admin/orders/:id/reassign' },
    ]);
    const prisma = { user: { findMany: users }, auditLog: { findMany: auditLog }, ...membershipDoubles() } as never;
    const people = await orderPeople(prisma, [
      order('o-ex', 'user-ex-admin'), order('o-mmg', 'user-ex-admin'), order('o-other', 'user-ex-admin'),
      order('o-a', ADMIN), order('o-s', 'user-super'), order('o-own', OWNER), order('o-st', STAFF), order('o-gone', 'user-deleted-account'),
    ]);
    expect(people.closedBySwift('o-ex', 'user-ex-admin')).toBe(true);
    expect(people.closedBySwift('o-mmg', 'user-ex-admin')).toBe(true);
    // Another console action on the order is Swift acting on it, but not Swift closing it.
    expect(people.closedBySwift('o-other', 'user-ex-admin')).toBe(false);
    expect(people.actedAsSwift('o-other', 'user-ex-admin')).toBe(true);
    expect(people.actedAsSwift('o-own', 'user-ex-admin')).toBe(false);
    expect(people.consoleStaff(ADMIN)).toBe(true);
    expect(people.consoleStaff('user-super')).toBe(true);
    expect(people.actedAsSwift('o-anything', ADMIN)).toBe(true);
    expect(people.consoleStaff(OWNER)).toBe(false);
    expect(people.consoleStaff('user-deleted-account')).toBe(false);
    expect(people.storeMember('vendor-food', OWNER)).toBe(true);
    expect(people.storeMember('vendor-food', STAFF)).toBe(true);
    expect(people.storeMember('vendor-food', ADMIN)).toBe(false);
    expect(people.storeMember('vendor-svc', STAFF)).toBe(false);
    expect(users).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  it('nobody to look up (no cancel by another person, no step written by one): no read at all', async () => {
    const prisma = new Proxy({}, { get: () => { throw new Error('no read expected'); } }) as never;
    const people = await orderPeople(prisma, [
      { id: 'o1', status: 'CANCELLED', customerId: 'c', cancelledBy: 'c', vendorId: 'v', statusHistory: [{ changedBy: 'c' }, { changedBy: null }, { changedBy: 'system:not-my-driver' }] },
      { id: 'o2', status: 'CANCELLED', customerId: 'c', cancelledBy: 'system', vendorId: null },
    ]);
    expect(people).toBe(NO_ORDER_PEOPLE);
  });
});

describe('senderCancellationView — a whole row as its customer may read it', () => {
  const row = { id: 'p1', status: 'CANCELLED', customerId: 'c', vendorId: null, orderNumber: 'SW-P1', cancelledBy: 'admin', cancellationReason: 'Sender abusive on the phone, blocked', other: 1 };
  it('never the canceller’s id; Swift support’s note blanked; who closed it added; every other field kept', () => {
    const people: OrderPeople = { ...NO_ORDER_PEOPLE, closedBySwift: () => true };
    const shown = senderCancellationView(row, people);
    expect(shown).toEqual({ id: 'p1', status: 'CANCELLED', customerId: 'c', vendorId: null, orderNumber: 'SW-P1', cancellationReason: null, other: 1, cancellation: { by: 'SWIFT', reason: null } });
    expect('cancelledBy' in shown).toBe(false);
  });
  it('the sender’s own cancel keeps their reason as before', () => {
    expect(senderCancellationView({ ...row, cancelledBy: 'c', cancellationReason: 'Cancelled by sender' }, NO_ORDER_PEOPLE))
      .toMatchObject({ cancellationReason: 'Cancelled by sender', cancellation: { by: 'CUSTOMER', reason: null } });
  });
});
