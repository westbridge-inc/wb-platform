import { describe, expect, it, vi } from 'vitest';
import { customerRoutes } from '../modules/user/customer.routes';
import {
  CUSTOMER_REASON_MAX,
  VENDOR_NO_RESPONSE_REASON,
  customerCancellation,
  customerSafeReason,
  swiftStaffIds,
} from '../modules/order/customer-cancellation';
import { NOT_COLLECTED_REASON } from '../modules/order/pickup-not-collected';
import { NO_SHOW_REASON } from '../modules/booking/appointment-no-show';
import { PASSENGER_NO_SHOW_REASON } from '../modules/rides/passenger-no-show';
import { MMG_ACCEPT_EXPIRY_REASON } from '../modules/order/mmg-accept-expiry';
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
};
function userRoles() {
  return vi.fn(async (args: FindManyArgs) => {
    const ids: string[] = args.where['id']?.in ?? [];
    return ids.filter((id) => USERS[id]).map((id) => ({ id, roles: USERS[id]!.roles }));
  });
}

async function customerHost(rows: Row[]) {
  const store = orderStore(rows);
  const users = userRoles();
  const prisma = prismaDouble(store, {
    platformConfig: { findUnique: async () => null, findMany: async () => [] },
    customer: { findUnique: async () => ({ id: 'cust-1', userId: 'user-customer', referralCode: 'REF1' }) },
    vendor: { findMany: async () => [], findUnique: async () => ({ status: 'ACTIVE', publicPhone: null }) },
    item: { findMany: async () => [] },
    user: { findUnique: async () => ({ countryCode: 'GY' }), findMany: users },
    countryConfig: { findUnique: async () => null },
    rating: { findMany: async () => [] },
    dispatchSearch: { findFirst: async () => null },
  });
  const host = await hostRoutes(customerRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
  return { ...host, store, users };
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

  it('additive: every field an older app reads is unchanged beside the new one', async () => {
    const h = await customerHost([foodDelivery('food-1', declinedBy(STAFF, 'Out of stock'))]);
    const detail = (await h.call('get /orders/:id', asCustomer({ params: { id: 'food-1' } }))) as Detail;
    expect(detail.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Out of stock', cancellationNotice: null, canCancel: false });
  });
});

describe('customerCancellation — who closed it, in the customer’s terms', () => {
  const base = { status: 'CANCELLED', customerId: 'cust', vendorId: 'v1', orderNumber: 'SW-1', fulfillment: 'DELIVERY' };
  const swift = (userId: string) => userId === 'admin';
  const view = (cancelledBy: string | null, cancellationReason: string | null, extra: Record<string, unknown> = {}) =>
    customerCancellation({ ...base, cancelledBy, cancellationReason, ...extra }, swift, 'Bourda Cafe');

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

describe('swiftStaffIds — Swift support’s people, by the console role they hold', () => {
  it('ADMIN and SUPER_ADMIN are Swift; a store owner, a staff member and a missing account are not', async () => {
    const users = userRoles();
    const prisma = { user: { findMany: users } } as never;
    const order = (cancelledBy: string) => ({ status: 'CANCELLED', customerId: 'c', cancelledBy });
    const isSwift = await swiftStaffIds(prisma, [order(ADMIN), order('user-super'), order(OWNER), order(STAFF), order('user-deleted-account')]);
    expect(isSwift(ADMIN)).toBe(true);
    expect(isSwift('user-super')).toBe(true);
    expect(isSwift(OWNER)).toBe(false);
    expect(isSwift(STAFF)).toBe(false);
    expect(isSwift('user-deleted-account')).toBe(false);
    expect(users).toHaveBeenCalledTimes(1);
  });
});
