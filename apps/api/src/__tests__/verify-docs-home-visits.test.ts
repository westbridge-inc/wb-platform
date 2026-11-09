/**
 * [VERIFY-DOCS · owner ruling 6 Oct 2026, ~21:25 GYT] POLICE CLEARANCE FOR HOME VISITS ONLY.
 *
 *  - Marketplace tradespeople (the services marketplace, SERVICE_PROVIDER) keep police clearance
 *    REQUIRED: their jobs are home visits, and the marketplace has no other kind.
 *  - A service BUSINESS (a SERVICE store) no longer needs one to open: its owner's ID is enough,
 *    and a police clearance is a document it MAY add.
 *  - A HOME-VISIT booking (a listing's "comes to you" mode: MOBILE, or BOTH with the customer
 *    choosing their place) is refused at checkout unless the owner holds an approved, current
 *    police clearance. The customer is told plainly; the owner is told what to do (once a day).
 *  - In-shop bookings are never affected.
 *  - Build 9 shows and uploads only `checklist`: an owner who offers home visits sees the police
 *    clearance there, so a build-9 owner can upload it — but it never gates the store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as homeVisits from '../modules/verification/home-visits';
import { signupSelfieRequired } from '../modules/verification/signup-selfie';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';
import { ownedVerificationFixture } from './helpers/verification-object';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { wordFreeTag } from './helpers/fixture-ids';

const DAY = 86_400_000;
const RUN = wordFreeTag(8);
const phoneBase = 592_006_400_000 + Math.floor(Math.random() * 90_000);
let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
const users: string[] = [];
const orders: string[] = [];
let seq = 0;

async function person(roles: UserRole[], activeRole: UserRole, opts: { selfie?: boolean } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Home', lastName: `Visit${seq}`, roles, activeRole, countryCode: 'GY',
    isPhoneVerified: true, selfieCapturedAt: opts.selfie === false ? null : new Date(), status: 'ACTIVE',
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: `hv-${RUN}-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token };
}

/** A SERVICE store, live, with one appointment listing in the given mode. */
async function serviceStore(mode: 'AT_BUSINESS' | 'MOBILE' | 'BOTH' | null, opts: { selfie?: boolean } = {}) {
  const owner = await person(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER', opts);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `Glow ${RUN} ${seq}`, slug: `glow-${RUN}-${seq}`, vendorType: 'SERVICE', phone: `+5926${String(seq).padStart(6, '0')}`,
    addressLine1: '3 Salon Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Services', sortOrder: 0 } });
  const item = mode === null ? null : await app.prisma.item.create({ data: {
    vendorId: vendor.id, categoryId: category.id, name: `Braids ${mode}`, basePrice: 4000, fulfillment: 'APPOINTMENT',
    bookingConfig: { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '08:00', end: '18:00' })), serviceMode: mode, serviceRadiusKm: 25 },
  } });
  return { ...owner, vendorId: vendor.id, vendorName: vendor.name, itemId: item?.id ?? '' };
}

/** Tomorrow at a Guyana wall-clock hour, as the instant the picker sends. */
function tomorrowAt(hours: number): Date {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  return instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d! + 1, hours, 0)));
}

async function customer() {
  const c = await person(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({ data: {
    userId: c.userId, label: 'Home', addressLine1: '9 Customer Close', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.81, longitude: -58.15, isDefault: true,
  } });
  return c;
}

async function book(c: { token: string; userId: string }, store: { vendorId: string; itemId: string }, hour: number, mode?: 'AT_BUSINESS' | 'MOBILE') {
  await app.prisma.cart.deleteMany({ where: { customerId: c.userId } });
  const added = await app.inject({ method: 'POST', url: '/api/v1/customer/cart/items', headers: { authorization: `Bearer ${c.token}` },
    payload: { vendorId: store.vendorId, itemId: store.itemId, quantity: 1 } });
  expect(added.statusCode, added.body).toBeLessThan(300);
  const res = await app.inject({ method: 'POST', url: '/api/v1/customer/checkout', headers: { authorization: `Bearer ${c.token}` },
    payload: { paymentMethod: 'CASH', appointments: [{ itemId: store.itemId, slotStart: tomorrowAt(hour).toISOString(), ...(mode ? { mode } : {}) }] } });
  if (res.statusCode === 200) orders.push(res.json().data.order.id);
  return res;
}

/** One of the owner's documents, approved by a reviewer. */
async function approved(ownerId: string, docType: string, expiresAt?: Date) {
  const doc = await app.prisma.verificationDocument.create({ data: {
    userId: ownerId, role: 'VENDOR_OWNER', docType, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
    fileUrl: await ownedVerificationFixture(app.prisma, ownerId, `hv-${docType}-${RUN}`),
  } });
  await service.approveDocument(doc.id, adminId, expiresAt);
  return doc.id;
}

/** [security review 9 Nov] A reviewer's recorded comparison of the owner's CURRENT selfie with an approved photo ID (the
 *  row POST /admin/verification/:id/selfie-check writes). */
async function selfieChecked(ownerId: string, idDocId: string, outcome: 'MATCH' | 'NO_MATCH' = 'MATCH') {
  const owner = await app.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { selfieCapturedAt: true } });
  await app.prisma.auditLog.create({ data: {
    userId: adminId, action: homeVisits.SELFIE_ID_COMPARED_ACTION, entity: 'User', entityId: ownerId,
    changes: { documentId: idDocId, selfieCapturedAt: owner.selfieCapturedAt!.toISOString(), outcome, docType: 'owner_national_id' },
  } });
}

/** A live store's owner: their ID approved (the store's own gate), then the police clearance. An owner who already has
 *  a selfie has it compared with that ID by a person (as the reviewer does when both are on file). */
async function clearOwner(ownerId: string, expiresAt: Date) {
  const id = await approved(ownerId, 'owner_national_id');
  const owner = await app.prisma.user.findUniqueOrThrow({ where: { id: ownerId }, select: { selfieCapturedAt: true } });
  if (owner.selfieCapturedAt) await selfieChecked(ownerId, id);
  return approved(ownerId, 'police_clearance', expiresAt);
}

const homeVisitNotices = (ownerId: string) => app.prisma.notification.count({ where: { userId: ownerId, title: 'Home visits are paused' } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  adminId = (await person(['ADMIN'], 'ADMIN')).userId;
});

afterAll(async () => {
  if (!app) return;
  await app.prisma.booking.deleteMany({ where: { customerId: { in: users } } }).catch(() => {});
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orders } } }).catch(() => {});
  await app.prisma.order.deleteMany({ where: { id: { in: orders } } }).catch(() => {});
  await app.prisma.cart.deleteMany({ where: { customerId: { in: users } } }).catch(() => {});
  await cleanupPayerBillingClocks(app.prisma, users).catch(() => {});
  await app.prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  await app.close();
});

describe('[home visits] the lists', () => {
  it('a service business opens on its owner’s ID; police clearance is a document it may add', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE']).toEqual(['owner_national_id']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_OPTIONAL']).toEqual(['police_clearance']);
  });

  it('marketplace tradespeople keep police clearance REQUIRED (their jobs are home visits)', () => {
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER']).toEqual(['national_id', 'police_clearance']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_PROVIDER_OPTIONAL']).toBeUndefined();
  });

  it('the seeded Guyana row carries the same service lists', async () => {
    const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
    const stored = gy.documentChecklists as Record<string, string[]>;
    for (const key of ['SERVICE', 'SERVICE_OPTIONAL', 'SERVICE_PROVIDER']) expect(stored[key], key).toEqual(DEFAULT_DOCUMENT_CHECKLISTS[key]);
  });
});

describe('[home visits] what the owner is shown', () => {
  it('an in-shop business: the owner’s ID is the whole checklist; police clearance is optional', async () => {
    const store = await serviceStore('AT_BUSINESS');
    const status = await service.getStatus(store.userId, 'SERVICE');
    expect(status.checklist).toEqual(['owner_national_id']);
    expect(status.optional).toContain('police_clearance');
    expect(status.homeVisits).toEqual({ offered: false, cleared: false, photo: true, photoChecked: false });
  });

  it('a business that offers home visits sees the police clearance in its checklist (build 9 can upload it) — but it never gates the store', async () => {
    const store = await serviceStore('BOTH');
    const status = await service.getStatus(store.userId, 'SERVICE');
    expect(status.checklist).toEqual(['owner_national_id', 'police_clearance']);
    expect(status.optional).not.toContain('police_clearance');
    expect(status.homeVisits).toEqual({ offered: true, cleared: false, photo: true, photoChecked: false });
    // the store's gate is the owner's ID alone
    expect(await service.isRoleVerified(store.userId, 'SERVICE')).toBe(false);
    await approved(store.userId, 'owner_national_id');
    expect(await service.isRoleVerified(store.userId, 'SERVICE')).toBe(true);
    const after = await service.getStatus(store.userId, 'SERVICE');
    expect(after.roleVerified).toBe(true);
    expect(after.missing).toEqual(['police_clearance']);
  });

  // [WEB-POLICE · option (a), COORD 1 Nov] A build-9 body (no consent tick) is refused and nothing is stored; the
  // build-12 body (the generic document tick) still files the clearance from the checklist it shows.
  it('a build-9 owner (no consent tick) is refused the police clearance; a build-12 owner (document_v1) uploads it', async () => {
    const store = await serviceStore('MOBILE');
    const fileUrl = await ownedVerificationFixture(app.prisma, store.userId, `hv-b9-${RUN}`);
    const refused = await app.inject({ method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${store.token}` },
      payload: { role: 'SERVICE', docType: 'police_clearance', fileUrl, consent: true, privacyNoticeVersion: 'v1' } });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('POLICE_CLEARANCE_CONSENT_REQUIRED');
    expect(await app.prisma.verificationDocument.count({ where: { userId: store.userId, docType: 'police_clearance' } })).toBe(0);
    const res = await app.inject({ method: 'POST', url: '/api/v1/verification/documents', headers: { authorization: `Bearer ${store.token}` },
      payload: { role: 'SERVICE', docType: 'police_clearance', fileUrl, consent: true, privacyNoticeVersion: 'v1', consentTick: 'document_v1' } });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('[home visits] booking', () => {
  it('clearance that lapses after preflight cannot authorize a committed home visit', async () => {
    const store = await serviceStore('MOBILE');
    const pc = await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    const check = homeVisits.homeVisitsCleared;
    const preflight = vi.spyOn(homeVisits, 'homeVisitsCleared').mockImplementation(async (db, ownerId, now) => {
      const allowed = await check(db, ownerId, now);
      if (db === app.prisma && ownerId === store.userId && allowed) {
        await app.prisma.verificationDocument.update({ where: { id: pc }, data: { expiresAt: new Date(Date.now() - DAY) } });
      }
      return allowed;
    });
    try {
      const res = await book(c, store, 10);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
      expect(await app.prisma.booking.count({ where: { customerId: c.userId } })).toBe(0);
    } finally { preflight.mockRestore(); }
  });

  it('concurrent refusals give the owner one daily notice', async () => {
    const store = await serviceStore('MOBILE');
    const notifications = new NotificationService(app.prisma, app.io);
    let reached = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const finder = app.prisma.notification as unknown as {
      findFirst: (args?: Parameters<typeof app.prisma.notification.findFirst>[0]) => Promise<{ id: string } | null>;
    };
    const original = finder.findFirst.bind(finder);
    const probe = vi.spyOn(finder, 'findFirst').mockImplementation(async (args) => {
      if (args?.where?.userId !== store.userId) return original(args);
      reached += 1;
      if (reached === 4) release();
      await barrier;
      return null;
    });
    try {
      await Promise.all(Array.from({ length: 4 }, () => homeVisits.tellOwnerHomeVisitsPaused(app.prisma, notifications, store.userId, store.vendorName)));
      expect(reached).toBe(4);
      expect(await homeVisitNotices(store.userId)).toBe(1);
    } finally { probe.mockRestore(); }
  });
  it('a home visit is refused at checkout while the owner holds no approved police clearance; the customer and the owner are told plainly', async () => {
    const store = await serviceStore('MOBILE');
    const c = await customer();
    const res = await book(c, store, 10);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
    expect(res.json().error.message).toBe(`${store.vendorName} can't come to your home yet, so this service can't be booked right now. Please try again later.`);
    expect(await homeVisitNotices(store.userId)).toBe(1);
    // asked again the same day: the owner is not told twice
    expect((await book(c, store, 11)).statusCode).toBe(409);
    expect(await homeVisitNotices(store.userId)).toBe(1);
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: store.userId, title: 'Home visits are paused' } });
    expect(notice.body).toContain('police clearance');
  });

  it('a BOTH listing: the home visit is refused with the in-shop alternative named, and the in-shop booking goes through', async () => {
    const store = await serviceStore('BOTH');
    const c = await customer();
    const home = await book(c, store, 10, 'MOBILE');
    expect(home.statusCode).toBe(409);
    expect(home.json().error.message).toBe(`${store.vendorName} can't come to your home yet. You can book this service at their place instead.`);
    // the default for BOTH (no choice made) is a visit too
    expect((await book(c, store, 11)).statusCode).toBe(409);
    expect((await book(c, store, 12, 'AT_BUSINESS')).statusCode).toBe(200);
  });

  it('an in-shop listing is never affected', async () => {
    const store = await serviceStore('AT_BUSINESS');
    expect((await book(await customer(), store, 10)).statusCode).toBe(200);
    expect(await homeVisitNotices(store.userId)).toBe(0);
  });

  it('with an approved, current police clearance the home visit books; once it lapses, it is refused again', async () => {
    const store = await serviceStore('MOBILE');
    const pc = await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    expect((await book(c, store, 10)).statusCode).toBe(200);
    expect((await service.getStatus(store.userId, 'SERVICE')).homeVisits).toEqual({ offered: true, cleared: true, photo: true, photoChecked: true });
    await app.prisma.verificationDocument.update({ where: { id: pc }, data: { expiresAt: new Date(Date.now() - DAY) } });
    expect((await book(c, store, 12)).statusCode).toBe(409);
  });
});

// [OWNER-ASKS · owner ruling 9 Nov 2026] The selfie: riders and drivers need it, and a service business that goes to the
// customer (a home visit) needs it; a store owner, store staff and a business that serves customers only at its own
// place do not. The photo is asked where a stranger comes to the customer's door: a home visit books only while the
// owner has a profile photo, beside the police clearance.
describe('[OWNER-ASKS 9 Nov] the profile photo: only for home visits', () => {
  it('an in-shop business whose owner never took a selfie opens on the ID and takes bookings', async () => {
    const store = await serviceStore('AT_BUSINESS', { selfie: false });
    const status = await service.getStatus(store.userId, 'SERVICE');
    expect(status.homeVisits).toEqual({ offered: false, cleared: false, photo: false, photoChecked: false });
    await approved(store.userId, 'owner_national_id');
    expect(await service.isRoleVerified(store.userId, 'SERVICE')).toBe(true);
    expect((await book(await customer(), store, 10)).statusCode).toBe(200);
  });

  it('a home visit is refused while the owner has no profile photo, even with a current police clearance; the owner is told to add the photo', async () => {
    const store = await serviceStore('MOBILE', { selfie: false });
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    expect((await service.getStatus(store.userId, 'SERVICE')).homeVisits).toEqual({ offered: true, cleared: true, photo: false, photoChecked: false });
    const c = await customer();
    const res = await book(c, store, 10);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
    expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: store.userId, title: 'Home visits are paused' } });
    expect(notice.body).toContain('profile photo');
    expect(notice.body).not.toContain('police clearance');
  });

  it('the owner who lacks both is told both', async () => {
    const store = await serviceStore('MOBILE', { selfie: false });
    expect((await book(await customer(), store, 10)).statusCode).toBe(409);
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: store.userId, title: 'Home visits are paused' } });
    expect(notice.body).toContain('police clearance');
    expect(notice.body).toContain('profile photo');
  });

  it('a BOTH listing without the photo still books at the business’s place', async () => {
    const store = await serviceStore('BOTH', { selfie: false });
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    expect((await book(c, store, 10, 'MOBILE')).statusCode).toBe(409);
    expect((await book(c, store, 12, 'AT_BUSINESS')).statusCode).toBe(200);
  });

  it('once the owner adds the photo AND a person has compared it with the approved ID, the home visit books', async () => {
    const store = await serviceStore('MOBILE', { selfie: false });
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    expect((await book(c, store, 10)).statusCode).toBe(409);
    await app.prisma.user.update({ where: { id: store.userId }, data: { selfieCapturedAt: new Date() } });
    // [security review 9 Nov] the photo alone is not enough: nobody has compared it with the ID yet
    expect((await book(c, store, 11)).statusCode).toBe(409);
    const id = await app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: store.userId, docType: 'owner_national_id', status: 'APPROVED' } });
    await selfieChecked(store.userId, id.id);
    expect((await book(c, store, 12)).statusCode).toBe(200);
  });

  it('the photo is re-read inside the commit: one removed after the preflight cannot authorize the visit', async () => {
    const store = await serviceStore('MOBILE');
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    const check = homeVisits.ownerHasProfilePhoto;
    const preflight = vi.spyOn(homeVisits, 'ownerHasProfilePhoto').mockImplementation(async (db, ownerId) => {
      const has = await check(db, ownerId);
      if (db === app.prisma && ownerId === store.userId && has) await app.prisma.user.update({ where: { id: store.userId }, data: { selfieCapturedAt: null } });
      return has;
    });
    try {
      const res = await book(c, store, 10);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally { preflight.mockRestore(); }
  });
});

// [OWNER-ASKS · owner ruling 9 Nov 2026] WHO takes the selfie, in one server predicate (the admin review panel and the
// identity check's face leg read it): riders and drivers, and a business that goes to the customer — never a store
// owner, never an in-shop business, never a customer.
describe('[OWNER-ASKS 9 Nov] who takes the sign-up selfie', () => {
  it('a rider or a driver: yes', async () => {
    const rider = await person(['CUSTOMER', 'MOVER', 'RIDER'], 'RIDER', { selfie: false });
    const driver = await person(['CUSTOMER', 'MOVER', 'DRIVER'], 'DRIVER', { selfie: false });
    expect(await signupSelfieRequired(app.prisma, rider.userId)).toBe(true);
    expect(await signupSelfieRequired(app.prisma, driver.userId)).toBe(true);
  });

  it('a customer, a store owner and an in-shop business: no', async () => {
    const shopper = await customer();
    expect(await signupSelfieRequired(app.prisma, shopper.userId)).toBe(false);
    const inShop = await serviceStore('AT_BUSINESS', { selfie: false });
    expect(await signupSelfieRequired(app.prisma, inShop.userId)).toBe(false);
    const noListing = await serviceStore(null, { selfie: false });
    expect(await signupSelfieRequired(app.prisma, noListing.userId)).toBe(false);
  });

  it('a business that goes to the customer (MOBILE or BOTH): yes — from the moment it lists one', async () => {
    expect(await signupSelfieRequired(app.prisma, (await serviceStore('MOBILE', { selfie: false })).userId)).toBe(true);
    expect(await signupSelfieRequired(app.prisma, (await serviceStore('BOTH', { selfie: false })).userId)).toBe(true);
    const later = await serviceStore('AT_BUSINESS', { selfie: false });
    expect(await signupSelfieRequired(app.prisma, later.userId)).toBe(false);
    await app.prisma.item.updateMany({ where: { vendorId: later.vendorId }, data: { bookingConfig: { serviceMode: 'MOBILE' } } });
    expect(await signupSelfieRequired(app.prisma, later.userId)).toBe(true);
  });

  it('an unknown account: no', async () => {
    expect(await signupSelfieRequired(app.prisma, 'no-such-user')).toBe(false);
  });
});

// [OWNER-ASKS · security review 9 Nov 2026] The ID is approved with no selfie (an in-shop owner never takes one). When the
// owner later turns on home visits and takes a photo, nothing tied that face to the ID — anyone could take it. A home
// visit books only once a person compared THIS selfie with the approved ID; a retake, a "no match", or a lapsed ID
// refuses again. In-shop bookings are never affected.
describe('[security review 9 Nov] the new selfie must be compared with the approved ID before a home visit books', () => {
  it('in-shop owner, ID approved with no selfie; turns on home visits and takes a selfie: refused until compared', async () => {
    const store = await serviceStore('AT_BUSINESS', { selfie: false });
    const idDoc = await approved(store.userId, 'owner_national_id');
    await approved(store.userId, 'police_clearance', new Date(Date.now() + 200 * DAY));
    await app.prisma.item.updateMany({ where: { vendorId: store.vendorId }, data: { bookingConfig: { durationMinutes: 60, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '08:00', end: '18:00' })), serviceMode: 'MOBILE', serviceRadiusKm: 25 } } });
    await app.prisma.user.update({ where: { id: store.userId }, data: { selfieCapturedAt: new Date() } });
    const c = await customer();
    const refused = await book(c, store, 10);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('HOME_VISIT_UNAVAILABLE');
    expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    expect((await service.getStatus(store.userId, 'SERVICE')).homeVisits).toEqual({ offered: true, cleared: true, photo: true, photoChecked: false });
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: store.userId, title: 'Home visits are paused' } });
    expect(notice.body).toContain('check your profile photo against your approved ID');
    // a "no match" keeps it refused
    await selfieChecked(store.userId, idDoc, 'NO_MATCH');
    expect((await book(c, store, 11)).statusCode).toBe(409);
    // a person records a match for THIS selfie: it books
    await selfieChecked(store.userId, idDoc);
    expect(await homeVisits.ownerPhotoMatchedToId(app.prisma, store.userId)).toBe(true);
    expect((await book(c, store, 12)).statusCode).toBe(200);
  });

  it('a retaken selfie is a new face: refused again until it is compared', async () => {
    const store = await serviceStore('MOBILE');
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    expect(await homeVisits.ownerPhotoMatchedToId(app.prisma, store.userId)).toBe(true);
    await app.prisma.user.update({ where: { id: store.userId }, data: { selfieCapturedAt: new Date(Date.now() + 1000) } });
    expect(await homeVisits.ownerPhotoMatchedToId(app.prisma, store.userId)).toBe(false);
    expect((await book(await customer(), store, 10)).statusCode).toBe(409);
  });

  it('a comparison with an ID that is no longer approved does not count', async () => {
    const store = await serviceStore('MOBILE');
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const id = await app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: store.userId, docType: 'owner_national_id', status: 'APPROVED' } });
    await app.prisma.verificationDocument.update({ where: { id: id.id }, data: { expiresAt: new Date(Date.now() - DAY) } });
    expect(await homeVisits.ownerPhotoMatchedToId(app.prisma, store.userId)).toBe(false);
  });

  it('a comparison recorded inside the commit is re-read: one recorded after the preflight for an old photo cannot authorize', async () => {
    const store = await serviceStore('MOBILE');
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    const c = await customer();
    const check = homeVisits.ownerPhotoMatchedToId;
    const preflight = vi.spyOn(homeVisits, 'ownerPhotoMatchedToId').mockImplementation(async (db, ownerId, now) => {
      const ok = await check(db, ownerId, now);
      if (db === app.prisma && ownerId === store.userId && ok) await app.prisma.user.update({ where: { id: store.userId }, data: { selfieCapturedAt: new Date(Date.now() + 5000) } });
      return ok;
    });
    try {
      const res = await book(c, store, 10);
      expect(res.statusCode, res.body).toBe(409);
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally { preflight.mockRestore(); }
  });

  it('in-shop bookings never wait for the check', async () => {
    const store = await serviceStore('BOTH', { selfie: false });
    await clearOwner(store.userId, new Date(Date.now() + 200 * DAY));
    await app.prisma.user.update({ where: { id: store.userId }, data: { selfieCapturedAt: new Date() } });
    const c = await customer();
    expect((await book(c, store, 10, 'MOBILE')).statusCode).toBe(409);
    expect((await book(c, store, 12, 'AT_BUSINESS')).statusCode).toBe(200);
  });
});
