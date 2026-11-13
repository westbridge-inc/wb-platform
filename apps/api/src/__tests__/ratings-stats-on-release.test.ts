import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RatingService } from '../modules/rating/rating.service';
import { RatingStatsService } from '../modules/rating/rating-stats.service';
import { ratingSurfaces } from '../modules/rating/rating-surface';
import { actorStandingView } from '../modules/rating/rating-standing';
import { seedRatingTags } from '../modules/rating/tag-taxonomy.seed';
import { RATING_MIN_DISPLAY, displayRating } from '../modules/rating/rating-math';
import { SearchService, type SearchClientLike } from '../modules/search/search.service';
import { testPrismaClient } from './helpers/test-prisma-client';
import { testPhone, fixtureTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [RATINGS-RELEASE · owner ruling 13 Nov 2026] A store's public star average
// AND rating count change only when a rating is RELEASED (visibleAt set: both
// sides rated, or the 72 h double-blind window passed), never at the moment it
// is written — otherwise the store watches its stars move as the customer who
// just collected rates it, and the rating is tied to that customer.
//
// Pinned here, through the real pipeline (RatingService.rate → outbox → stats):
//   1. a rating written now moves nothing public — legacy averageRating /
//      totalRatings, the materialized stat, the R8 star line, the search
//      document and the store's own Standing view;
//   2. the 72 h release sweep moves all of them, and re-syncs the store's
//      search document at that moment;
//   3. the both-sides release moves them too (store and mover alike);
//   4. RAT-H: the nightly recomputeAll lands exactly the incremental values,
//      before and after release, and direct SQL over released rows agrees.
// The 72 h window and the 5-rating display floor are unchanged.
// ---------------------------------------------------------------------------

const prisma = testPrismaClient();
const synced: string[] = [];
const ratings = new RatingService(prisma, undefined, (vendorId) => { synced.push(vendorId); });

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
const createdRiderIds: string[] = [];

/** A search client that records the documents a sync writes. */
function recordingSearch() {
  const docs = new Map<string, Record<string, unknown>>();
  const index = {
    addDocuments: async (d: Record<string, unknown>[]) => { for (const doc of d) docs.set(String(doc['entityId']), doc); return {}; },
    deleteDocument: async () => ({}),
    deleteDocuments: async () => ({}),
    getDocuments: async () => ({ results: [] }),
    search: async () => ({ hits: [], processingTimeMs: 0 }),
    updateSettings: async () => ({}),
  };
  const client: SearchClientLike = { createIndex: async () => ({}), index: () => index };
  return { service: new SearchService(prisma, undefined, undefined, client), docs };
}

async function makeUser(roles: string[]) {
  const u = await prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Rel', lastName: fixtureTag(6),
      roles: roles as never, activeRole: roles[0] as never, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  return u;
}

async function makeVendor() {
  const owner = await makeUser(['VENDOR_OWNER']);
  const vo = await prisma.vendorOwner.upsert({ where: { userId: owner.id }, create: { userId: owner.id }, update: {} });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Release Diner ${fixtureTag(4)}`, slug: `release-diner-${fixtureTag(8)}`,
      vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '1 Release Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function makeRider() {
  const user = await makeUser(['RIDER']);
  const rider = await prisma.rider.create({
    data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
  createdRiderIds.push(rider.id);
  return { user, rider };
}

async function makeDeliveredOrder(customerId: string, vendorId: string, riderId?: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `REL-${fixtureTag(10).toUpperCase()}`, orderType: 'FOOD_DELIVERY',
      customerId, vendorId, ...(riderId ? { riderId } : {}), status: 'DELIVERED', deliveredAt: new Date(),
      deliveryAddress: 'release', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH', estimatedPrepTime: 20,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** A fresh customer collects and rates the store (written hidden, not released). */
async function customerRatesStore(vendorId: string, score: number) {
  const customer = await makeUser(['CUSTOMER']);
  const order = await makeDeliveredOrder(customer.id, vendorId);
  await ratings.rate({ orderId: order.id, raterId: customer.id, vendorId, type: 'CUSTOMER_TO_VENDOR', score });
  return order;
}

/** Let the 72 h double-blind window pass for these orders' ratings. */
async function passWindow(orderIds: string[]) {
  await prisma.$executeRaw`UPDATE ratings SET "createdAt" = NOW() - INTERVAL '73 hours' WHERE "orderId" = ANY(${orderIds}::text[]) AND "visibleAt" IS NULL`;
}

const statKey = (role: 'VENDOR' | 'RIDER' | 'CUSTOMER', id: string) => ({
  tenantId_subjectRole_subjectId: { tenantId: 'swift-default', subjectRole: role, subjectId: id },
});

/** Everything public (and store-facing) a store's rating moves. */
async function storeFace(vendorId: string) {
  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { averageRating: true, totalRatings: true } });
  const stat = await prisma.actorRatingStat.findUnique({ where: statKey('VENDOR', vendorId) });
  const surface = (await ratingSurfaces(prisma, 'VENDOR', [vendorId])).get(vendorId)!;
  const search = recordingSearch();
  await search.service.syncVendor(vendorId);
  const doc = search.docs.get(vendorId);
  return {
    averageRating: vendor.averageRating,
    totalRatings: vendor.totalRatings,
    lifetimeCount: stat?.lifetimeCount ?? 0,
    lifetimeSum: stat?.lifetimeSum ?? 0,
    displayRating: surface.displayRating,
    ratingCount: surface.ratingCount,
    searchDoc: doc && {
      averageRating: doc['averageRating'], totalRatings: doc['totalRatings'],
      display_rating: doc['display_rating'], rating_count: doc['rating_count'],
    },
  };
}

beforeAll(async () => {
  await prisma.$connect();
  await seedRatingTags(prisma);
});

afterAll(async () => {
  if (createdOrderIds.length) {
    const rows = await prisma.rating.findMany({ where: { orderId: { in: createdOrderIds } }, select: { id: true } });
    if (rows.length) await prisma.ratingOutbox.deleteMany({ where: { ratingId: { in: rows.map((r) => r.id) } } });
    await prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  }
  const subjects = [...createdVendorIds, ...createdUserIds];
  if (subjects.length) await prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: subjects } } });
  if (createdOrderIds.length) await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  if (createdRiderIds.length) await prisma.rider.deleteMany({ where: { id: { in: createdRiderIds } } });
  if (createdVendorIds.length) await prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  if (createdUserIds.length) {
    await prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe('a store’s stars move at RELEASE, never at write [RATINGS-RELEASE]', () => {
  it('a rating written now changes nothing public; the 72 h release changes it all and re-syncs search', async () => {
    const vendor = await makeVendor();

    // A store already showing stars: RATING_MIN_DISPLAY released 5-star ratings.
    const earlier: string[] = [];
    for (let i = 0; i < RATING_MIN_DISPLAY; i += 1) earlier.push((await customerRatesStore(vendor.id, 5)).id);
    await passWindow(earlier);
    await ratings.releaseDoubleBlind(72);
    const before = await storeFace(vendor.id);
    expect(before).toMatchObject({
      totalRatings: RATING_MIN_DISPLAY, averageRating: 5, lifetimeCount: RATING_MIN_DISPLAY,
      ratingCount: RATING_MIN_DISPLAY, displayRating: displayRating(RATING_MIN_DISPLAY, 5 * RATING_MIN_DISPLAY),
    });
    expect(before.searchDoc).toMatchObject({ totalRatings: RATING_MIN_DISPLAY, rating_count: RATING_MIN_DISPLAY });

    // The next customer collects and rates 1 star. Written — not released.
    const fresh = await customerRatesStore(vendor.id, 1);
    const row = await prisma.rating.findFirstOrThrow({ where: { orderId: fresh.id, type: 'CUSTOMER_TO_VENDOR' } });
    expect(row.visibleAt).toBeNull();

    // Nothing the store (or anyone) can see moved: average, count, stat, star
    // line and search document are exactly as before.
    const written = await storeFace(vendor.id);
    expect(written).toEqual(before);

    // RAT-H before release: the nightly recompute lands the incremental values.
    await new RatingStatsService(prisma).recomputeAll();
    expect(await storeFace(vendor.id)).toEqual(before);

    // The store's own Standing view does not count it either, even once it is
    // older than the fold boundary, while it is still unreleased.
    await passWindow([fresh.id]);
    await prisma.actorRatingStat.update({ where: statKey('VENDOR', vendor.id), data: { actorVisibleAt: new Date() } });
    expect((await actorStandingView(prisma, 'VENDOR', vendor.id)).folded.count).toBe(RATING_MIN_DISPLAY);

    // The 72 h window passes: the release sweep moves every figure at once…
    synced.length = 0;
    expect(await ratings.releaseDoubleBlind(72)).toBeGreaterThanOrEqual(1);
    const released = await storeFace(vendor.id);
    const n = RATING_MIN_DISPLAY + 1;
    const sum = 5 * RATING_MIN_DISPLAY + 1;
    expect(released).toMatchObject({
      totalRatings: n, averageRating: Math.round((sum / n) * 10) / 10,
      lifetimeCount: n, lifetimeSum: sum, ratingCount: n, displayRating: displayRating(n, sum),
    });
    expect(released.searchDoc).toMatchObject({ totalRatings: n, rating_count: n, display_rating: displayRating(n, sum) });
    // …and schedules the store's search re-sync at release time.
    expect(synced).toContain(vendor.id);

    // The store's Standing view picks it up at the next daily fold.
    await prisma.actorRatingStat.update({ where: statKey('VENDOR', vendor.id), data: { actorVisibleAt: new Date() } });
    expect((await actorStandingView(prisma, 'VENDOR', vendor.id)).folded.count).toBe(n);

    // RAT-H after release: incremental === nightly recompute === direct SQL.
    const incremental = await prisma.actorRatingStat.findUniqueOrThrow({ where: statKey('VENDOR', vendor.id) });
    await new RatingStatsService(prisma).recomputeAll();
    const nightly = await prisma.actorRatingStat.findUniqueOrThrow({ where: statKey('VENDOR', vendor.id) });
    expect(nightly.lifetimeCount).toBe(incremental.lifetimeCount);
    expect(nightly.lifetimeSum).toBe(incremental.lifetimeSum);
    expect(String(nightly.displayRating)).toBe(String(incremental.displayRating));
    expect(nightly.standing).toBe(incremental.standing);
    const sql = await prisma.rating.aggregate({
      where: { vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', state: 'ACTIVE', visibleAt: { not: null } },
      _count: true, _sum: { score: true },
    });
    expect(sql._count).toBe(n);
    expect(sql._sum.score).toBe(sum);
  });

  it('the both-sides release moves the store and the mover at that moment, not before', async () => {
    const vendor = await makeVendor();
    const { user: riderUser, rider } = await makeRider();
    const customer = await makeUser(['CUSTOMER']);
    const order = await makeDeliveredOrder(customer.id, vendor.id, rider.id);

    await ratings.rate({ orderId: order.id, raterId: customer.id, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 3 });
    await ratings.rate({ orderId: order.id, raterId: customer.id, rateeId: riderUser.id, type: 'CUSTOMER_TO_RIDER', score: 4 });

    // Only the customer's side is in: nothing released, nothing counted.
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).totalRatings).toBe(0);
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).totalRatings).toBe(0);
    expect((await prisma.actorRatingStat.findUnique({ where: statKey('RIDER', riderUser.id) }))?.lifetimeCount ?? 0).toBe(0);

    // The rider rates the customer: both sides are in, the order's ratings are
    // released — and every subject on the order moves at that moment.
    synced.length = 0;
    await ratings.rate({ orderId: order.id, raterId: riderUser.id, rateeId: customer.id, type: 'RIDER_TO_CUSTOMER', score: 5 });
    expect(await prisma.rating.count({ where: { orderId: order.id, visibleAt: null } })).toBe(0);

    const v = await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(v.totalRatings).toBe(1);
    expect(v.averageRating).toBe(3);
    expect(synced).toContain(vendor.id);
    const r = await prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(r.totalRatings).toBe(1);
    expect(r.averageRating).toBe(4);
    expect((await prisma.actorRatingStat.findUniqueOrThrow({ where: statKey('RIDER', riderUser.id) })).lifetimeCount).toBe(1);
    expect((await prisma.actorRatingStat.findUniqueOrThrow({ where: statKey('CUSTOMER', customer.id) })).lifetimeCount).toBe(1);

    // A replayed release (outbox retry) is idempotent and lands the same values.
    await ratings.releaseIfBothSidesRated(order.id);
    expect((await prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).totalRatings).toBe(1);

    // RAT-H: the nightly recompute agrees with what the release wrote.
    const before = await prisma.actorRatingStat.findUniqueOrThrow({ where: statKey('VENDOR', vendor.id) });
    await new RatingStatsService(prisma).recomputeAll();
    const after = await prisma.actorRatingStat.findUniqueOrThrow({ where: statKey('VENDOR', vendor.id) });
    expect([after.lifetimeCount, after.lifetimeSum, String(after.displayRating)]).toEqual([before.lifetimeCount, before.lifetimeSum, String(before.displayRating)]);
  });
});
