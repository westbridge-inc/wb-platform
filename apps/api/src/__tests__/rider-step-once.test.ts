import { beforeEach, describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerTenantHeaderScope } from '../plugins/tenant-header-scope';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { HANDED_TO_RIDER_NOTE, countStatusSteps, latestStepAt } from '../modules/order/store-handover-log';
import { freshOrderPlaceBudget } from './helpers/order-place-budget';

// ---------------------------------------------------------------------------
// [FOLLOWUPS 11 Nov 2026] The production rider test: 6 of 13 orders "logged the
// same rider step 2-3 times" in order_status_logs (RIDER_ASSIGNED x2,
// RIDER_EN_ROUTE_PICKUP x2-3, RIDER_ARRIVED_PICKUP x2-3).
//
// Why: not the rider's taps. Every rider step is a compare-and-set on the
// locked order row, so a second identical tap was refused (409/400) and wrote
// nothing. The extra rows are the STORE's: a kitchen tap ("Ready", "Start
// preparing") made after a rider took the order, and "Handed to rider", are
// logged at the order's current status, which is then the rider's status. They
// are true evidence and stay in the log, but every reader that counted or
// showed rider steps read them as repeated rider steps:
//   - the customer's timeline (website and phone) showed "Rider assigned" /
//     "Rider on the way" / "Rider at the store" twice;
//   - the store's timeline the same;
//   - the dispatch journal's assignment-episode count counted a store tap at
//     RIDER_ASSIGNED as a second assignment;
//   - a "Ready" tap at RIDER_ASSIGNED started a new "handed to rider" episode
//     (the store's tap was forgotten and could be logged again);
//   - the pickup-overdue clock (pickup-overdue.test.ts) restarted from it.
// The same is true of every row written AT the current status (a grocery
// substitution, a courier's "cash collected from sender"). [REVIEW-2490 S3-1]
// Now one positive rule decides what a step is: a row that CHANGED the status
// (store-handover-log stepFlags / countStatusSteps / latestStepAt / timelineRows),
// and the timelines show the kitchen tap as the kitchen step.
//
// Also, a separate change: a repeat of the step the rider already took (a double
// tap, a retry after a lost answer, two taps that race) used to be REFUSED (it
// never wrote twice); it is now answered as done, still with no second log row
// and no second customer push. [REVIEW-2490 S4-1] So the "one row" assertions
// below guard that the new answer writes nothing; what was red before was the
// refusal. A genuine reassignment (another rider, or the same rider taking the
// order again) is still logged as its own step. Real routes, production composition.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920383';
const FIXTURE = 'rider-step-once-fixture';
const DAY = 24 * 60 * 60 * 1000;
const STORE = { lat: 6.8013, lng: -58.1551 };
const HOME = { lat: 6.8045, lng: -58.1553 };
const RIDER_STEPS = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'] as const;
/** The store's "Ready" row once a rider holds the order (vendor.routes recordPrepProgress), written here so a
 *  changed wording reds this file. */
const STORE_READY_WITH_RIDER_NOTE = 'Order ready for pickup (rider already assigned)';

let app: FastifyInstance;
let seq = 0;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

type Actor = { userId: string; token: string; sessionId: string };
type Rider = Actor & { riderId: string };
let customer: Actor;
let owner: Actor;
let vendorId: string;
let itemId: string;
let substituteId: string;
const asStore = () => ({ 'x-vendor-id': vendorId });

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName, lastName: `Once${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `once-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

async function makeRider(firstName: string): Promise<Rider> {
  const actor = await makeUser(firstName, ['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await sys(() => app.prisma.rider.create({
    data: {
      userId: actor.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE', vehicleMake: 'Honda', vehicleModel: 'CG125', vehicleColor: 'Red', licensePlate: 'CJ 4321',
      documentsVerified: true, isOnline: true, isAvailable: true,
      currentLat: STORE.lat, currentLng: STORE.lng, lastLocationUpdate: new Date(),
      locationSessionId: actor.sessionId, floatLimit: 100_000,
    },
  }));
  return { ...actor, riderId: rider.id };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url,
    headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}
const logs = (orderId: string) => sys(() => app.prisma.orderStatusLog.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
const countOf = <T extends { status: string }>(rows: readonly T[], status: string) => rows.filter((r) => r.status === status).length;
const storeStep = async (orderId: string, step: string) => {
  const res = await call('PUT', `/api/v1/vendor/orders/${orderId}/${step}`, owner.token, undefined, asStore());
  expect(res.statusCode, res.body).toBe(200);
};
const riderStep = (orderId: string, rider: Rider, step: string) => call('PUT', `/api/v1/rider/orders/${orderId}/${step}`, rider.token);
const handedToRider = (orderId: string) => call('PUT', `/api/v1/vendor/orders/${orderId}/handed-to-rider`, owner.token, undefined, asStore());
/** The customer's notices about this order, by the status they announce. */
const customerNotices = (orderId: string, status: string) => sys(() => app.prisma.$queryRaw<Array<{ id: string }>>`
  SELECT id FROM "notifications" WHERE "userId" = ${customer.userId} AND "data"->>'orderId' = ${orderId} AND "data"->>'status' = ${status}`);
const customerTimeline = async (orderId: string) => {
  const res = await call('GET', `/api/v1/customer/orders/${orderId}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.timeline as Array<{ status: string; note: string | null }>;
};
const storeTimeline = async (orderId: string) => {
  const res = await call('GET', `/api/v1/vendor/orders/${orderId}`, owner.token, undefined, asStore());
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { statusHistory: Array<{ status: string; note: string | null }>; handedToRiderAt: string | null };
};
const assignmentEpisodes = (orderId: string) => sys(() => countStatusSteps(app.prisma, orderId, 'RIDER_ASSIGNED'));

async function placeDelivery(): Promise<string> {
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const placed = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `once-${nanoid(10)}` });
  expect(placed.statusCode, placed.body).toBe(200);
  const id = (placed.json().data.order as { id: string }).id;
  await sys(() => app.prisma.order.update({ where: { id }, data: { holdExpiresAt: null } }));
  return id;
}

/** Accepted by the store (preparing), then taken by `rider` before the store marks it ready: the
 *  Express shape of the production test (a rider on it while the kitchen still works). */
async function takenWhilePreparing(rider: Rider): Promise<string> {
  const id = await placeDelivery();
  await storeStep(id, 'accept');
  const grab = await call('POST', `/api/v1/rider/orders/${id}/accept`, rider.token, {});
  expect(grab.statusCode, grab.body).toBe(200);
  return id;
}

async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: ids } } }, select: { id: true } })).map((v) => v.id);
    const riderIds = (await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((r) => r.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] }, select: { id: true },
    })).map((o) => o.id);
    if (orderIds.length > 0) await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...riderIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.earning.deleteMany({ where: { OR: [{ orderId: { in: orderIds } }, { riderId: { in: riderIds } }] } });
    await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

beforeEach(() => freshOrderPlaceBudget(app.redis));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  registerTenantHeaderScope(app);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  await purgeFixtures();

  customer = await makeUser('Nia', ['CUSTOMER'], 'CUSTOMER');
  await sys(() => app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '9 Once Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: HOME.lat, longitude: HOME.lng, isDefault: true },
  }));
  owner = await makeUser('Owner', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const ownerRow = await sys(() => app.prisma.vendorOwner.create({ data: { userId: owner.userId } }));
  vendorId = (await sys(() => app.prisma.vendor.create({
    data: {
      ownerId: ownerRow.id, name: 'Once Diner', slug: `once-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: '3 Once Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, deliveryRadius: 50,
    },
  }))).id;
  const category = await sys(() => app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } }));
  itemId = (await sys(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Cook-up', basePrice: 1800, isAvailable: true } }))).id;
  substituteId = (await sys(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Pepperpot', basePrice: 1800, isAvailable: true } }))).id;
});

afterAll(async () => {
  try { await purgeFixtures(); } finally { await app.close(); }
});

describe('[FOLLOWUPS 11 Nov] the store taps a rider\'s order: one rider step each, wherever steps are read', () => {
  it('Ready after the rider took it, then "Handed to rider": the log keeps the store rows; the customer and the store see each rider step once', async () => {
    const rider = await makeRider('Asha');
    const id = await takenWhilePreparing(rider);
    await storeStep(id, 'ready'); // at RIDER_ASSIGNED: the store's row carries the rider's status
    expect((await riderStep(id, rider, 'en-route-pickup')).statusCode).toBe(200);
    expect((await riderStep(id, rider, 'arrived-pickup')).statusCode).toBe(200);
    expect((await handedToRider(id)).statusCode).toBe(200); // at RIDER_ARRIVED_PICKUP

    // The production shape: the raw log has two RIDER_ASSIGNED and two RIDER_ARRIVED_PICKUP rows, and the
    // extra ones are the store's (append-only evidence, kept).
    const raw = await logs(id);
    expect(countOf(raw, 'RIDER_ASSIGNED')).toBe(2);
    expect(raw.filter((r) => r.status === 'RIDER_ASSIGNED').map((r) => r.note)).toContain(STORE_READY_WITH_RIDER_NOTE);
    expect(raw.filter((r) => r.status === 'RIDER_ARRIVED_PICKUP').map((r) => r.note)).toContain(HANDED_TO_RIDER_NOTE);

    // The customer's timeline: each rider step once, and the store's "Ready" as "Ready".
    const mine = await customerTimeline(id);
    for (const step of RIDER_STEPS) expect(countOf(mine, step), `customer ${step}`).toBe(1);
    expect(countOf(mine, 'READY_FOR_PICKUP')).toBe(1);

    // The store's timeline: the same, and its own taps keep their words.
    const store = await storeTimeline(id);
    expect(countOf(store.statusHistory, 'RIDER_ASSIGNED')).toBe(1);
    expect(countOf(store.statusHistory, 'RIDER_EN_ROUTE_PICKUP')).toBe(1);
    // [REVIEW-2490 S3-2] "Rider at counter" once: the store's "Handed to rider" tap is said by its own line
    // (handedToRiderAt), never as a second rider-at-counter step.
    expect(countOf(store.statusHistory, 'RIDER_ARRIVED_PICKUP')).toBe(1);
    expect(store.statusHistory.map((r) => r.note)).not.toContain(HANDED_TO_RIDER_NOTE);
    expect(store.handedToRiderAt).toEqual(expect.any(String));
    expect(store.statusHistory.find((r) => r.note === STORE_READY_WITH_RIDER_NOTE)?.status).toBe('READY_FOR_PICKUP');

    // The dispatch journal counts one assignment, not two.
    expect(await assignmentEpisodes(id)).toBe(1);
  });

  it('"Handed to rider" stays recorded when the store marks Ready afterwards: a second tap writes nothing', async () => {
    const rider = await makeRider('Bibi');
    const id = await takenWhilePreparing(rider);
    const tap = await handedToRider(id);
    expect(tap.statusCode, tap.body).toBe(200);
    const at = tap.json().data.handedToRiderAt as string;
    await storeStep(id, 'ready'); // a store row at RIDER_ASSIGNED: the same rider still holds the order
    expect((await storeTimeline(id)).handedToRiderAt).toBe(at);
    const again = await handedToRider(id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.handedToRiderAt).toBe(at);
    expect((await logs(id)).filter((r) => r.note === HANDED_TO_RIDER_NOTE)).toHaveLength(1);
  });
});

describe('[FOLLOWUPS 11 Nov] the same rider step twice: answered as done (it used to be refused), still one row and one customer notice', () => {
  it('two identical "On the way to pickup" taps: both answered, one log row', async () => {
    const rider = await makeRider('Chandra');
    const id = await takenWhilePreparing(rider);
    const first = await riderStep(id, rider, 'en-route-pickup');
    expect(first.statusCode, first.body).toBe(200);
    const second = await riderStep(id, rider, 'en-route-pickup');
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data).toMatchObject({ orderId: id, status: 'RIDER_EN_ROUTE_PICKUP', replayed: true });
    expect(countOf(await logs(id), 'RIDER_EN_ROUTE_PICKUP')).toBe(1);
  });

  it('two identical "Picked up" taps: one PICKED_UP row and ONE customer notice', async () => {
    const rider = await makeRider('Dev');
    const id = await takenWhilePreparing(rider);
    await storeStep(id, 'ready');
    for (const step of ['en-route-pickup', 'arrived-pickup']) expect((await riderStep(id, rider, step)).statusCode).toBe(200);
    const first = await riderStep(id, rider, 'picked-up');
    expect(first.statusCode, first.body).toBe(200);
    const second = await riderStep(id, rider, 'picked-up');
    expect(second.statusCode, second.body).toBe(200);
    expect(countOf(await logs(id), 'PICKED_UP')).toBe(1);
    expect(await customerNotices(id, 'PICKED_UP')).toHaveLength(1);
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }))).status).toBe('PICKED_UP');
  });

  it('two taps that race (sent together): both answered, one log row, one customer notice', async () => {
    const rider = await makeRider('Esha');
    const id = await takenWhilePreparing(rider);
    await storeStep(id, 'ready');
    for (const step of ['en-route-pickup', 'arrived-pickup']) expect((await riderStep(id, rider, step)).statusCode).toBe(200);
    const answers = await Promise.all([riderStep(id, rider, 'picked-up'), riderStep(id, rider, 'picked-up')]);
    for (const res of answers) expect(res.statusCode, res.body).toBe(200);
    expect(countOf(await logs(id), 'PICKED_UP')).toBe(1);
    expect(await customerNotices(id, 'PICKED_UP')).toHaveLength(1);
  });

  it('a step the order is past is still refused (a repeat is only the step the order stands at)', async () => {
    const rider = await makeRider('Farah');
    const id = await takenWhilePreparing(rider);
    for (const step of ['en-route-pickup', 'arrived-pickup']) expect((await riderStep(id, rider, step)).statusCode).toBe(200);
    const back = await riderStep(id, rider, 'en-route-pickup');
    expect(back.statusCode).toBe(400);
    expect(back.json().error.code).toBe('INVALID_TRANSITION');
    expect(countOf(await logs(id), 'RIDER_EN_ROUTE_PICKUP')).toBe(1);
  });

  it('a genuine reassignment is still logged: another rider\'s assignment is its own step; the first rider\'s repeat is refused', async () => {
    const first = await makeRider('Gita');
    const id = await takenWhilePreparing(first);
    expect((await riderStep(id, first, 'en-route-pickup')).statusCode).toBe(200);
    const back = await call('POST', `/api/v1/rider/orders/${id}/handback`, first.token, { reason: 'bike broke down' });
    expect(back.statusCode, back.body).toBe(200);
    const second = await makeRider('Hari');
    const grab = await call('POST', `/api/v1/rider/orders/${id}/accept`, second.token, {});
    expect(grab.statusCode, grab.body).toBe(200);
    expect((await riderStep(id, second, 'en-route-pickup')).statusCode).toBe(200);

    const raw = await logs(id);
    expect(raw.filter((r) => r.status === 'RIDER_ASSIGNED').map((r) => r.changedBy)).toEqual([first.userId, second.userId]);
    expect(await assignmentEpisodes(id)).toBe(2);
    expect(countOf(await customerTimeline(id), 'RIDER_ASSIGNED')).toBe(2);
    expect(countOf(raw, 'RIDER_EN_ROUTE_PICKUP')).toBe(2); // one per rider

    // The first rider no longer holds the order: their old screen's tap is not a repeat.
    const stale = await riderStep(id, first, 'en-route-pickup');
    expect(stale.statusCode).toBe(403);
    expect(countOf(await logs(id), 'RIDER_EN_ROUTE_PICKUP')).toBe(2);
  });
});

describe('[REVIEW-2490 S3-1] any row written at the rider\'s status that does not change it is not a step', () => {
  it('a grocery substitution proposed while the rider holds the order: one assignment, one step on each timeline, "Handed to rider" kept', async () => {
    const rider = await makeRider('Ishaan');
    const id = await takenWhilePreparing(rider);
    expect((await handedToRider(id)).statusCode).toBe(200);
    const line = (await sys(() => app.prisma.orderItem.findFirstOrThrow({ where: { orderId: id } }))).id;
    const swap = await call('POST', `/api/v1/vendor/orders/${id}/items/${line}/substitute`, owner.token, { substituteItemId: substituteId }, asStore());
    expect(swap.statusCode, swap.body).toBe(200);
    const raw = await logs(id);
    expect(raw.filter((r) => r.status === 'RIDER_ASSIGNED').map((r) => r.note)).toContain('Substitution proposed: Cook-up → Pepperpot');
    expect(await assignmentEpisodes(id)).toBe(1);
    expect((await storeTimeline(id)).handedToRiderAt).toEqual(expect.any(String)); // the same rider's episode
    expect(countOf(await customerTimeline(id), 'RIDER_ASSIGNED')).toBe(1);
    expect(countOf((await storeTimeline(id)).statusHistory, 'RIDER_ASSIGNED')).toBe(1);
    // The rider's clock still starts at the rider's own accept.
    const accept = raw.find((r) => r.status === 'RIDER_ASSIGNED')!;
    expect((await sys(() => latestStepAt(app.prisma, id, 'RIDER_ASSIGNED')))?.toISOString()).toBe(accept.createdAt.toISOString());
  });

  it('a courier\'s "cash collected from sender" row (written as cash-rules writes it: at the current status, no actor) is not a step', async () => {
    const rider = await makeRider('Jaya');
    const id = await takenWhilePreparing(rider);
    expect((await riderStep(id, rider, 'en-route-pickup')).statusCode).toBe(200);
    expect((await riderStep(id, rider, 'arrived-pickup')).statusCode).toBe(200);
    const arrived = (await logs(id)).find((r) => r.status === 'RIDER_ARRIVED_PICKUP')!;
    await sys(() => app.prisma.orderStatusLog.create({ data: { orderId: id, status: 'RIDER_ARRIVED_PICKUP', note: 'cash collected from sender — gps:6.80130,-58.15510' } }));
    expect((await sys(() => latestStepAt(app.prisma, id, 'RIDER_ARRIVED_PICKUP')))?.toISOString()).toBe(arrived.createdAt.toISOString());
    expect(countOf(await customerTimeline(id), 'RIDER_ARRIVED_PICKUP')).toBe(1);
    expect(countOf((await storeTimeline(id)).statusHistory, 'RIDER_ARRIVED_PICKUP')).toBe(1);
    expect(await assignmentEpisodes(id)).toBe(1);
  });
});

describe('[REVIEW-2490 S4-2] the same rider hands the order back and takes it again', () => {
  it('a new assignment and a new step (never a replay of the old one); a repeat after that is the replay', async () => {
    const rider = await makeRider('Kavi');
    const id = await takenWhilePreparing(rider);
    expect((await riderStep(id, rider, 'en-route-pickup')).statusCode).toBe(200);
    const back = await call('POST', `/api/v1/rider/orders/${id}/handback`, rider.token, { reason: 'wrong turn, coming back' });
    expect(back.statusCode, back.body).toBe(200);
    const again = await call('POST', `/api/v1/rider/orders/${id}/accept`, rider.token, {});
    expect(again.statusCode, again.body).toBe(200);
    expect(await assignmentEpisodes(id)).toBe(2);
    const step = await riderStep(id, rider, 'en-route-pickup');
    expect(step.statusCode, step.body).toBe(200);
    expect(step.json().data.replayed).toBeUndefined(); // a real step on the new assignment
    expect(countOf(await logs(id), 'RIDER_EN_ROUTE_PICKUP')).toBe(2);
    const repeat = await riderStep(id, rider, 'en-route-pickup');
    expect(repeat.json().data).toMatchObject({ status: 'RIDER_EN_ROUTE_PICKUP', replayed: true });
    expect(countOf(await logs(id), 'RIDER_EN_ROUTE_PICKUP')).toBe(2);
  });
});

