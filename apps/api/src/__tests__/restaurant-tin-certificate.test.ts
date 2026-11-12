/**
 * [RESTAURANT-TIN · owner ruling 12 Nov 2026, correcting the same day's first line]
 *
 *   "no not type tin, they attach a TIN certificate instead of the food clearance certificate, this is for restaurants
 *    only, and the food licence as optional"
 *
 *  - RESTAURANTS ONLY (vendorType RESTAURANT): the TIN certificate takes the GRA Food Restaurant Licence's REQUIRED place,
 *    on the restaurant's list and at the prepared-food listing gate (CUISINE / DISH). The GRA licence is OPTIONAL: shown,
 *    uploadable and reviewed, never a gate. No TIN is typed anywhere.
 *  - A restaurant LIVE TODAY (it went live on the GRA licence) is never taken down for the TIN certificate: it is asked
 *    to ADD it (its optional list), and its prepared food stays listed.
 *  - A supermarket, a shop or a service business is unchanged: it is never asked for a TIN certificate (and cannot send
 *    one), and a non-restaurant selling prepared food still needs the GRA licence at the gate.
 *  - A person reads every TIN certificate (the review queue shows it; no engine decides it).
 *
 * Doc-type names are plain strings here, so on the old code every case fails on its own assertion.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { assertTaggable, gateVerdicts, vendorOwnerContext } from '../modules/verification/category-gate';
import { changePaperStaging, loadChange, startBusinessTypeChange, viewOfChange } from '../modules/vendor/account-change';
import { ownedVerificationFixture, signupSelfieFixture } from './helpers/verification-object';
import { reviewerTyped } from './helpers/reviewer-typed';
import { wordFreeTag } from './helpers/fixture-ids';

const TIN = 'tin_certificate';
const GRA = 'gra_restaurant_licence';
const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'restaurant-tin-test');
let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
const users: string[] = [];
let seq = 0;

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64'));
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: `+5927${NUM}00`, firstName: 'Tin', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  adminId = admin.id; users.push(admin.id);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.documentRecord.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    const vendorIds = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: users } } }, select: { id: true } })).map((v) => v.id);
    await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

type Owner = { userId: string; vendorId: string; token: string };
type StoreType = 'RESTAURANT' | 'SUPERMARKET' | 'STORE';

/** A store owner with one store, never live yet unless told otherwise. */
async function storeOwner(opts: { status?: 'PENDING_APPROVAL' | 'ACTIVE'; isVerified?: boolean; vendorType?: StoreType } = {}): Promise<Owner> {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+5927${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Ravi', lastName: `Tin${seq}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER',
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  const vendorOwner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: user.id, vendors: { create: {
    name: `Pepperpot Place ${seq}`, slug: `tin-${RUN.toLowerCase()}-${seq}`, vendorType: opts.vendorType ?? 'RESTAURANT', tier: 'REGISTERED',
    phone: `+5927${NUM}9${seq}`, addressLine1: '3 Tin Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: 6.8, longitude: -58.16, status: opts.status ?? 'PENDING_APPROVAL', isVerified: opts.isVerified ?? false, publicPhone: '+5926001236',
  } } }, include: { vendors: true } }));
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `tin-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, vendorId: vendorOwner.vendors[0]!.id, token };
}

const call = (method: 'GET' | 'POST', url: string, o: Owner, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, 'x-vendor-id': o.vendorId, ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const tick = (o: Owner) => call('POST', '/api/v1/vendor/onboarding/food-handlers', o, { accept: true, attestationVersion: 'v1' });
const statusOf = async (o: Owner, role: StoreType = 'RESTAURANT') => (await call('GET', `/api/v1/verification/status?role=${role}`, o)).json().data;
const store = (o: Owner) => system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId }, select: { status: true, isVerified: true } }));
const upload = async (o: Owner, role: StoreType, docType: string) => call('POST', '/api/v1/verification/documents', o, {
  role, docType, fileUrl: await ownedVerificationFixture(app.prisma, o.userId, `tin-${docType}-${nanoid(4)}`), consent: true, privacyNoticeVersion: 'v1',
});

/** Submit and approve (as a person) each document. */
async function approveAll(o: Owner, role: StoreType, docTypes: readonly string[]) {
  for (const docType of docTypes) {
    const doc = await service.submitDocument(o.userId, role, docType, await ownedVerificationFixture(app.prisma, o.userId, `tin-${docType}`), 'v1');
    const typed: Record<string, unknown> = { ...reviewerTyped(docType, doc.id) };
    if (typeof typed['certificateYear'] === 'string') typed['certificateYear'] = Number(typed['certificateYear']);
    await service.approveDocument(doc.id, adminId, new Date(Date.now() + 200 * DAY), undefined, typed);
  }
}
const BASE = ['owner_national_id', 'business_registration', 'storefront_photo'] as const;
const dish = { id: 'cat-dish-tin', slug: 'pepperpot', kind: 'DISH' as const };
const cuisine = { id: 'cat-cuisine-tin', slug: 'creole', kind: 'CUISINE' as const };
const preparedFoodGate = async (o: Owner) => (await system(async () => gateVerdicts(app.prisma, await vendorOwnerContext(app.prisma, o.vendorId), [dish, cuisine])))
  .filter((v) => v.requiredDocType !== 'food_handler_cert');

describe('[RESTAURANT-TIN] a new restaurant: the TIN certificate in the GRA licence’s place', () => {
  it('owner ID + business registration + storefront photo + TIN certificate + the food handlers tick, NO GRA licence: it goes live and lists prepared food', async () => {
    const o = await storeOwner();
    const status = await statusOf(o);
    expect(status.checklist).toEqual(expect.arrayContaining([...BASE, TIN]));
    expect(status.checklist).not.toContain(GRA);
    expect(status.optional).toContain(GRA);
    expect(status.optional).not.toContain(TIN);

    await approveAll(o, 'RESTAURANT', [...BASE, TIN]);
    expect((await tick(o)).statusCode).toBe(201);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    expect((await statusOf(o)).missing).toEqual([]);

    // the prepared-food gate asks the TIN certificate of a restaurant, and it holds one
    const verdicts = await preparedFoodGate(o);
    expect(verdicts.map((v) => v.requiredDocType)).toEqual([TIN, TIN]);
    expect(verdicts.every((v) => v.ok)).toBe(true);
    await expect(system(() => assertTaggable(app.prisma, o.vendorId, dish))).resolves.toBeDefined();
  });

  it('without the TIN certificate it is held: the step is the owner’s, and a dish is refused naming the TIN certificate', async () => {
    const o = await storeOwner();
    await approveAll(o, 'RESTAURANT', BASE);
    expect((await tick(o)).statusCode).toBe(201);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });
    const status = await statusOf(o);
    expect(status.missing).toEqual([TIN]);
    expect(status.roleVerified).toBe(false);
    const goLive = (await service.vendorGoLive(o.vendorId))!;
    expect(goLive.checklist.complete).toBe(false);
    expect(goLive.checklist.items.find((i: { docType: string }) => i.docType === TIN)?.state).toBe('MISSING');

    const verdicts = await preparedFoodGate(o);
    expect(verdicts.map((v) => [v.requiredDocType, v.ok])).toEqual([[TIN, false], [TIN, false]]);
    await expect(system(() => assertTaggable(app.prisma, o.vendorId, dish))).rejects.toMatchObject({ code: 'CATEGORY_GATED', message: expect.stringMatching(/TIN Certificate/) });
  });

  it('a GRA licence alone does not stand in for the TIN certificate: still held', async () => {
    const o = await storeOwner();
    await approveAll(o, 'RESTAURANT', [...BASE, GRA]);
    expect((await tick(o)).statusCode).toBe(201);
    expect(await store(o)).toEqual({ status: 'PENDING_APPROVAL', isVerified: false });
    expect((await statusOf(o)).missing).toEqual([TIN]);
  });

  it('the GRA licence is still taken as OPTIONAL evidence: accepted, reviewed by a person, never “missing”', async () => {
    const o = await storeOwner();
    const res = await upload(o, 'RESTAURANT', GRA);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
    const status = await statusOf(o);
    expect(status.missing).not.toContain(GRA);
    expect(status.checklist).not.toContain(GRA);
    expect(status.optional).toContain(GRA);
  });

  it('the TIN certificate is read by a person: it waits in the review queue, never decided by an engine', async () => {
    const o = await storeOwner();
    const res = await upload(o, 'RESTAURANT', TIN);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.status).toBe('PENDING');
    const queued = await system(() => app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: o.userId, docType: TIN }, select: { status: true, role: true } }));
    expect(queued).toEqual({ status: 'PENDING', role: 'VENDOR_OWNER' });
  });
});

describe('[RESTAURANT-TIN] a restaurant live today is never taken down for it', () => {
  it('live on its GRA licence, no TIN certificate: it stays live, keeps listing, and is asked to ADD the TIN certificate', async () => {
    const o = await storeOwner();
    await approveAll(o, 'RESTAURANT', [...BASE, GRA]);
    expect((await tick(o)).statusCode).toBe(201);
    // live before this change shipped: an older server made it live on the GRA licence
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { status: 'ACTIVE', isVerified: true, acceptingOrders: true } }));
    await service.reprojectVendorActivation(o.userId);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });

    const status = await statusOf(o);
    expect(status.checklist).not.toContain(TIN);
    expect(status.missing).toEqual([]);
    expect(status.optional[0]).toBe(TIN);
    expect(status.optional).toContain(GRA);
    expect((await preparedFoodGate(o)).every((v) => v.ok)).toBe(true);
    // and it can send it
    const res = await upload(o, 'RESTAURANT', TIN);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a restaurant NOT live (its papers lapsed) comes back only with the TIN certificate', async () => {
    const o = await storeOwner({ status: 'ACTIVE', isVerified: false });
    await approveAll(o, 'RESTAURANT', [...BASE, GRA]);
    expect((await tick(o)).statusCode).toBe(201);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: false });
    expect((await statusOf(o)).missing).toEqual([TIN]);
    await approveAll(o, 'RESTAURANT', [TIN]);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
  });
});

describe('[RESTAURANT-TIN] every other store is unchanged', () => {
  it.each(['SUPERMARKET', 'STORE'] as const)('a %s is never asked for a TIN certificate and cannot send one', async (vendorType) => {
    const o = await storeOwner({ vendorType });
    const status = await statusOf(o, vendorType);
    expect(status.checklist).toEqual([...BASE]);
    expect(status.optional).not.toContain(TIN);
    const res = await upload(o, vendorType, TIN);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('INVALID_DOC_TYPE');
  });

  it('a supermarket selling prepared food still needs the GRA licence at the gate', async () => {
    const o = await storeOwner({ vendorType: 'SUPERMARKET' });
    expect((await preparedFoodGate(o)).map((v) => [v.requiredDocType, v.ok])).toEqual([[GRA, false], [GRA, false]]);
    await approveAll(o, 'SUPERMARKET', [GRA]);
    expect((await preparedFoodGate(o)).map((v) => [v.requiredDocType, v.ok])).toEqual([[GRA, true], [GRA, true]]);
  });
});

describe('[RESTAURANT-TIN] from the deploy, before the owner-signed seed rewrites the stored lists', () => {
  it('a stored copy that still names the GRA licence (production’s) is read with the TIN certificate in its place', async () => {
    const before = await system(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { documentChecklists: true } }));
    const stored = { ...(before.documentChecklists as Record<string, string[]>) };
    try {
      await system(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: {
        ...stored,
        RESTAURANT: ['owner_national_id', 'business_registration', GRA, 'storefront_photo'],
        RESTAURANT_OWN_NAME: ['owner_national_id', 'own_name_declaration', GRA, 'storefront_photo'],
        RESTAURANT_OPTIONAL: ['food_handler_cert'],
      } } }));
      const o = await storeOwner();
      const status = await statusOf(o);
      expect(status.checklist).toEqual(expect.arrayContaining([...BASE, TIN]));
      expect(status.checklist).not.toContain(GRA);
      expect(status.optional).toEqual(expect.arrayContaining(['food_handler_cert', GRA]));
      await approveAll(o, 'RESTAURANT', [...BASE, TIN]);
      expect((await tick(o)).statusCode).toBe(201);
      expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    } finally {
      await system(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: stored } }));
    }
  });
});

describe('[RESTAURANT-TIN] no claim that a restaurant needs its GRA licence', () => {
  const reminderOf = async (o: Owner) => {
    const doc = await system(() => app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: o.userId, docType: GRA, status: 'APPROVED' }, select: { id: true } }));
    await system(() => app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() + 20 * DAY) } }));
    await runWithTenant('swift-default', () => service.sendExpiryReminders());
    const sent = (await system(() => app.prisma.notification.findMany({ where: { userId: o.userId, data: { path: ['docId'], equals: doc.id } } }))).filter((n) => (n.data as { kind?: string } | null)?.kind === 'verification_expiry_reminder');
    expect(sent).toHaveLength(1);
    return sent[0]!.body;
  };

  it('a restaurant holding its TIN certificate: the GRA licence reminder says it is optional, never “renew it to avoid suspension”', async () => {
    const o = await storeOwner();
    await approveAll(o, 'RESTAURANT', [GRA, TIN]);
    const body = await reminderOf(o);
    expect(body).toMatch(/It is optional for a restaurant and does not affect your store/);
    expect(body).not.toMatch(/avoid suspension/);
  });

  // [#2494 review S2-1 · owner 12 Nov 2026] a live restaurant stands on its GRA licence only while it is valid
  it('a restaurant with no TIN certificate: the GRA licence reminder says to add the TIN certificate to keep operating', async () => {
    const o = await storeOwner();
    await approveAll(o, 'RESTAURANT', [GRA]);
    const body = await reminderOf(o);
    expect(body).toMatch(/add your TIN Certificate in Documents to keep operating/);
    expect(body).not.toMatch(/optional|avoid suspension/);
  });

  it('a supermarket’s GRA licence (its prepared-food gate) keeps the old words', async () => {
    const o = await storeOwner({ vendorType: 'SUPERMARKET' });
    await approveAll(o, 'SUPERMARKET', [GRA]);
    expect(await reminderOf(o)).toMatch(/Renew it to avoid suspension\./);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [#2494 review · owner ruling 12 Nov 2026 (S2-1)] A restaurant ALREADY LIVE stays live only WHILE its GRA licence is valid.
// ---------------------------------------------------------------------------------------------------------------------

/** A restaurant live before this change: its papers approved on the GRA licence, the tick given, then made live. */
async function liveOnGra(extra: readonly string[] = []): Promise<Owner> {
  const o = await storeOwner();
  await approveAll(o, 'RESTAURANT', [...BASE, GRA, ...extra]);
  expect((await tick(o)).statusCode).toBe(201);
  await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { status: 'ACTIVE', isVerified: true, acceptingOrders: true } }));
  await service.reprojectVendorActivation(o.userId);
  return o;
}
/** Let the owner's approved GRA licence lapse, through the daily expiry sweep; returns its 'Document expired' notice. */
async function lapseGra(o: Owner): Promise<string> {
  const doc = await system(() => app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: o.userId, docType: GRA, status: 'APPROVED' }, select: { id: true } }));
  await system(() => app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() - 3 * DAY) } }));
  await runWithTenant('swift-default', () => service.expireLapsedDocuments());
  const sent = (await system(() => app.prisma.notification.findMany({ where: { userId: o.userId, data: { path: ['docId'], equals: doc.id } } })))
    .filter((n) => (n.data as { kind?: string } | null)?.kind === 'verification_expired');
  expect(sent).toHaveLength(1);
  return sent[0]!.body;
}

describe('[RESTAURANT-TIN · review S2-1] a live restaurant is excused the TIN certificate only while its GRA licence is valid', () => {
  it('its GRA licence lapses: the TIN certificate is required like for a new restaurant — the store stops and its dishes go', async () => {
    const o = await liveOnGra();
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    expect((await preparedFoodGate(o)).every((v) => v.ok)).toBe(true);

    const notice = await lapseGra(o);
    // [S3-1] the expiry notice is true: the restaurant now needs its TIN certificate
    expect(notice).toMatch(/now needs its TIN Certificate: add it in Documents to keep operating/);
    expect(notice).not.toMatch(/optional/);
    expect((await store(o)).isVerified).toBe(false);
    const status = await statusOf(o);
    expect(status.missing).toEqual([TIN]);
    expect((await preparedFoodGate(o)).map((v) => [v.requiredDocType, v.ok])).toEqual([[TIN, false], [TIN, false]]);

    // it comes back with the TIN certificate
    await approveAll(o, 'RESTAURANT', [TIN]);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
  });

  it('[S3-1] a restaurant holding its TIN certificate: the GRA licence lapses quietly — optional, and the store stays live', async () => {
    const o = await liveOnGra([TIN]);
    const notice = await lapseGra(o);
    expect(notice).toMatch(/It is optional for a restaurant: upload a new one only if you want it on file\./);
    expect(notice).not.toMatch(/keep operating/);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    expect((await preparedFoodGate(o)).every((v) => v.ok)).toBe(true);
  });

  it('a REJECTED TIN certificate ends the exemption: the store stops until a TIN certificate is approved', async () => {
    const o = await liveOnGra();
    const doc = await service.submitDocument(o.userId, 'RESTAURANT', TIN, await ownedVerificationFixture(app.prisma, o.userId, 'tin-rejected'), 'v1');
    await service.rejectDocument(doc.id, adminId, 'The certificate names another business.');
    await service.reprojectVendorActivation(o.userId);
    expect((await store(o)).isVerified).toBe(false);
    expect((await statusOf(o)).missing).toEqual([TIN]);
    expect((await preparedFoodGate(o)).every((v) => !v.ok)).toBe(true);
  });

  it('a copy the owner REPLACED before review is no refusal: the exemption stands', async () => {
    const o = await liveOnGra();
    expect((await upload(o, 'RESTAURANT', TIN)).statusCode).toBe(201);
    expect((await upload(o, 'RESTAURANT', TIN)).statusCode).toBe(201);
    await service.reprojectVendorActivation(o.userId);
    expect(await store(o)).toEqual({ status: 'ACTIVE', isVerified: true });
    expect((await preparedFoodGate(o)).every((v) => v.ok)).toBe(true);
  });
});

describe('[RESTAURANT-TIN · review S4-2] the TIN certificate is a restaurant’s paper only', () => {
  it('a supermarket owner naming the RESTAURANT role is refused it', async () => {
    const o = await storeOwner({ vendorType: 'SUPERMARKET' });
    const res = await upload(o, 'RESTAURANT', TIN);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('INVALID_DOC_TYPE');
  });
});

describe('[RESTAURANT-TIN · review S4-1] a change of business type or of account holder is papered on the new rules', () => {
  it('a live restaurant excused on its GRA licence must file a TIN certificate for a business-type change', async () => {
    const o = await liveOnGra();
    const view = await system(() => startBusinessTypeChange(app.prisma, o.userId, 'COMPANY'));
    expect(view.papers.find((p) => p.docType === TIN)?.state).toBe('MISSING');
    expect(view.papers.some((p) => p.docType === GRA)).toBe(false);
    expect(view.papersComplete).toBe(false);
    await system(() => app.prisma.accountChangeRequest.deleteMany({ where: { id: view.id } }));
  });

  it('a person taking over a live restaurant account must file a TIN certificate', async () => {
    const o = await liveOnGra();
    seq += 1;
    const next = await system(() => app.prisma.user.create({ data: {
      phone: `+5927${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Next', lastName: `Holder${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
    } }));
    users.push(next.id);
    const ownerRow = await system(() => app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId: o.userId }, select: { id: true } }));
    const change = await system(() => app.prisma.accountChangeRequest.create({ data: {
      tenantId: 'swift-default', vendorOwnerId: ownerRow.id, kind: 'HOLDER_HANDOVER', requestedById: o.userId, holderId: o.userId,
      newHolderId: next.id, newHolderAcceptedAt: new Date(),
    } }));
    try {
      const staging = await system(() => changePaperStaging(app.prisma, next.id, 'RESTAURANT', 'GY'));
      expect(staging?.submittable).toContain(TIN);
      expect(staging?.submittable).not.toContain(GRA);
      const view = await system(async () => viewOfChange(app.prisma, await loadChange(app.prisma, change.id)));
      expect(view.papers.find((p) => p.docType === TIN)?.state).toBe('MISSING');
    } finally {
      await system(() => app.prisma.accountChangeRequest.deleteMany({ where: { id: change.id } }));
    }
  });
});
