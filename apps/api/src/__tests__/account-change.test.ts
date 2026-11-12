/**
 * [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 ~07:3xZ (c) + (d)] Changing who a store account is, with a person at
 * Swift deciding (modules/vendor/account-change.ts):
 *  (c) "Change business type": the store keeps selling on its old checked papers while the new ones wait; approved, the
 *      choice, the papers that count and the seller name customers see switch at once; refused, nothing changes and the
 *      store reads why. (The owner's own test store, marked "own name" though it is a company, is corrected this way.)
 *  (d) Company account-holder handover: the new person's papers, checked by a person, then the account (all branches)
 *      moves to them and the old holder loses access (every session ends). Refused: nothing changes. Open orders are
 *      untouched either way.
 * Only the account holder starts either; only a document reviewer decides, with a reason.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { recordEvidenceFor } from '../modules/verification/evidence';
import { compileActivationDisclosure } from '../modules/verification/storefront-disclosure';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { ownedVerificationFixture } from './helpers/verification-object';
import { grantStepUp } from './helpers/step-up';
import { wordFreeTag } from './helpers/fixture-ids';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { sealVaultToken } from '../modules/billing/card-vault';
import { sellerNameViews } from '../modules/verification/storefront-disclosure';
import { validRegistrationRecord } from '../modules/vendor/registration-record';

// [review-2475 F6] The decision's recusal is read again inside its transaction: armed, the reviewer passes the check made
// before the transaction and is recused at the one made inside it (as an identity link made in between would do).
const recusal = vi.hoisted(() => ({ armedFor: null as string | null, seen: 0 }));
vi.mock('../modules/verification/recusal', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/verification/recusal')>();
  return {
    ...real,
    assertNotRecused: async (...args: Parameters<typeof real.assertNotRecused>) => {
      if (recusal.armedFor && args[1] === recusal.armedFor && ++recusal.seen > 1) throw real.recusedError();
      return real.assertNotRecused(...args);
    },
  };
});

const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const REASON = 'Checked each paper against the certificate and the ID on file.';
const COMPANY_STORE = ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'storefront_photo'];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'account-change-test');
let app: FastifyInstance;
let service: VerificationService;
let adminId = '';
let adminToken = '';
const users: string[] = [];
const orders: string[] = [];
let seq = 0;

type Who = { userId: string; token: string; vendorId: string };

async function session(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(24), authMethod: 'OTP', deviceId: `ac-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return token;
}

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64'));
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: `+5926${NUM}90`, firstName: 'Change', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true,
    admin: { create: { permissions: ['*', 'documents.review'] } },
  } }));
  adminId = admin.id; users.push(admin.id);
  adminToken = await session(adminId, 'ADMIN');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
    const vendors = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: users } } }, select: { id: true } })).map((v) => v.id);
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendors } } });
    const subs = await app.prisma.subscription.findMany({ where: { vendorId: { in: vendors } }, select: { id: true } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await cleanupBillingClocks(app.prisma, subs.map((s) => s.id)); // a resumed MMG plan opened its billing clock
    await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendors } } });
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: users } } });
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.documentRecord.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.accountChangeRequest.deleteMany({ where: { vendorOwner: { userId: { in: users } } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    const clusters = await app.prisma.identityClusterMember.findMany({ where: { accountId: { in: users } }, select: { clusterId: true } });
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusters.map((c) => c.clusterId) } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendors } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

async function person(firstName = 'Asha', lastName = 'Ramdin'): Promise<Who & { phone: string }> {
  seq += 1;
  const phone = `+5926${NUM}${String(seq).padStart(2, '0')}`;
  const user = await system(() => app.prisma.user.create({ data: {
    phone, firstName, lastName, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  return { userId: user.id, token: await session(user.id, 'CUSTOMER'), vendorId: '', phone };
}
const call = (method: 'GET' | 'POST' | 'PUT', url: string, o: { token: string; vendorId?: string }, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, ...(o.vendorId ? { 'x-vendor-id': o.vendorId } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const admin = (method: 'GET' | 'PUT', url: string, payload?: Record<string, unknown>, reason: string | null = REASON) => app.inject({
  method, url: `/api/v1/admin${url}`, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${adminToken}`, ...(reason ? { 'x-swift-reason': reason } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
});

async function become(o: Who, over: Record<string, unknown> = {}) {
  const vendorType = String(over['vendorType'] ?? 'STORE');
  const quote = await signupQuote(app.prisma, o.userId, { role: 'VENDOR', vendorType });
  const res = await call('POST', '/api/v1/partner/become', o, {
    role: 'VENDOR', acceptAgreement: true, weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode },
    business: { name: `Shop ${RUN} ${seq}`, vendorType, phone: '+5926000000', addressLine1: '1 Change Road', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, ...over },
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  o.vendorId = (await system(() => app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: o.userId } }, select: { id: true } }))).id;
  o.token = await session(o.userId, 'VENDOR_OWNER');
}

const typedFor = (docType: string) => docType === 'account_holder_id' || docType === 'owner_national_id' ? { documentNumber: `ID${NUM}${seq}${nanoid(4)}` }
  : docType === 'certificate_of_incorporation' ? { registrationKind: 'COMPANY' as const }
    : docType === 'business_registration' ? { registrationKind: 'BUSINESS_NAME' as const, certificateYear: new Date().getUTCFullYear() }
      : docType === 'own_name_declaration' ? { ownNameConfirmed: true as const }
        // [COMPANY-DOCS Part 2 · review F2] a letter of authority is approved only on a person's own confirmation
        : docType.endsWith('_authority_letter') ? { authorityConfirmed: { method: 'CALLED_ON_FOUND_NUMBER' as const, reason: 'called the company on the number on its website; it confirmed' } } : {};

async function file(userId: string, docType: string, role: 'STORE' | 'RESTAURANT' = 'STORE') {
  return service.submitDocument(userId, role, docType, await ownedVerificationFixture(app.prisma, userId, `ac-${docType}`), 'v1');
}
async function approve(docId: string, docType: string, extra: Record<string, unknown> = {}) {
  return service.approveDocument(docId, adminId, undefined, undefined, { ...typedFor(docType), ...extra });
}
async function fileAndApprove(userId: string, docTypes: string[], role: 'STORE' | 'RESTAURANT' = 'STORE') {
  for (const docType of docTypes) await approve((await file(userId, docType, role)).id, docType);
}
async function makeLive(vendorId: string) {
  await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE', isVerified: true, acceptingOrders: true, mmgNumber: '+5926112233', publicPhone: '+5926445566' } }));
}
const store = (id: string) => system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id } }));
const owner = (userId: string) => system(() => app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId } }));
const sellerName = async (o: Who) => {
  const user = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: o.userId }, select: { tenantId: true } }));
  const block = await system(() => compileActivationDisclosure(app.prisma, o.vendorId, { accountId: o.userId, tenantId: user.tenantId }));
  return block.legalName?.value ?? null;
};

/** The owner's test store: a store that signed up as trading under its owner's OWN name, live on its checked papers. */
async function ownNameStore(): Promise<Who> {
  const o = await person('Asha', 'Ramdin');
  await become(o, { name: 'Asha Ramdin' });
  const signed = await call('POST', '/api/v1/vendor/onboarding/own-name', o, { accept: true, attestationVersion: 'v1' });
  expect(signed.statusCode, signed.body).toBe(201);
  await approve(signed.json().data.declaration.id, 'own_name_declaration');
  await fileAndApprove(o.userId, ['owner_national_id', 'storefront_photo']);
  await makeLive(o.vendorId);
  expect(await service.isRoleVerified(o.userId, 'STORE', app.prisma, o.vendorId)).toBe(true);
  return o;
}

/** A registered company's live store (the KFC case). */
async function companyStore(role: 'STORE' | 'RESTAURANT' = 'STORE'): Promise<Who> {
  const o = await person('Kamla', 'Persaud');
  await become(o, { accountBasis: 'COMPANY', vendorType: role, name: `Chicken Company ${RUN} ${seq}` });
  await fileAndApprove(o.userId, role === 'RESTAURANT' ? [...COMPANY_STORE, 'gra_restaurant_licence'] : COMPANY_STORE, role);
  await makeLive(o.vendorId);
  expect(await service.isRoleVerified(o.userId, role, app.prisma, o.vendorId)).toBe(true);
  return o;
}

async function placedOrder(vendorId: string): Promise<string> {
  const buyer = await person('Buyer', 'Customer');
  const order = await system(() => app.prisma.order.create({ data: {
    orderNumber: `AC-${nanoid(10).toUpperCase()}`, customerId: buyer.userId, vendorId,
    orderType: 'FOOD_DELIVERY', status: 'PREPARING', deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'MOBILE_MONEY',
    mmgNumberSnapshot: '+5926112233',
  } }));
  orders.push(order.id);
  return order.id;
}
const orderFacts = (id: string) => system(() => app.prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true, vendorId: true, mmgNumberSnapshot: true, paymentStatus: true, updatedAt: true } }));

// ---------------------------------------------------------------------------------------------------------------------
// (c) Change business type
// ---------------------------------------------------------------------------------------------------------------------

describe('(c) a pending change keeps the store selling on its old checked papers', () => {
  it('the new papers are held for the change: they count for nothing — gate, papers, seller name — until a person decides', async () => {
    const o = await ownNameStore();
    const before = await sellerName(o);
    expect(before).toBe('Asha Ramdin'); // an own-name trader is named by their own name

    const asked = await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' });
    expect(asked.statusCode, asked.body).toBe(201);
    expect(asked.json().data).toMatchObject({ kind: 'BUSINESS_TYPE', status: 'PENDING', fromOption: 'OWN_NAME', toOption: 'COMPANY' });
    const changeId = asked.json().data.id as string;
    // exactly the new papers the account does not already use (the storefront photo is already checked)
    expect(asked.json().data.papers.map((p: { docType: string; state: string }) => [p.docType, p.state])).toEqual([
      ['certificate_of_incorporation', 'MISSING'], ['account_holder_id', 'MISSING'], ['company_authority_letter', 'MISSING'], ['storefront_photo', 'APPROVED'],
    ]);

    for (const docType of ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter']) {
      const doc = await file(o.userId, docType);
      expect(doc.accountChangeId, docType).toBe(changeId);
      expect(doc.status, docType).toBe('PENDING'); // always a person
      await approve(doc.id, docType);
    }
    // every paper approved — and still none of them counts
    expect(await recordEvidenceFor(app.prisma, o.userId, ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter'], new Date())).toEqual([]);
    expect(await owner(o.userId)).toMatchObject({ accountBasis: 'OWNER' });
    expect(await store(o.vendorId)).toMatchObject({ status: 'ACTIVE', isVerified: true, acceptingOrders: true, tradesUnderOwnName: true });
    expect(await service.isRoleVerified(o.userId, 'STORE', app.prisma, o.vendorId)).toBe(true);
    expect((await call('GET', '/api/v1/verification/status?role=STORE', o)).json().data.checklist).toContain('own_name_declaration');
    // a company certificate checked for the change does not end the own-name seller name early
    expect(await sellerName(o)).toBe('Asha Ramdin');
    const view = (await call('GET', '/api/v1/vendor/account-change', o)).json().data;
    expect(view.change).toMatchObject({ id: changeId, status: 'PENDING', papersComplete: true });
  });

  it('one change at a time; the same answer is refused; staff and outsiders cannot ask', async () => {
    const o = await ownNameStore();
    expect((await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'OWN_NAME' })).json().error.code).toBe('NOTHING_TO_CHANGE');
    expect((await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'REGISTERED' })).statusCode).toBe(201);
    const second = await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ACCOUNT_CHANGE_PENDING');
    // a manager of the store is staff: never the account holder
    const manager = await person('Mona', 'Manager');
    await system(() => app.prisma.vendorStaff.create({ data: { vendorId: o.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: o.userId } }));
    for (const who of [{ ...manager, vendorId: o.vendorId }, await person('Out', 'Sider')]) {
      const res = await call('POST', '/api/v1/vendor/account-change/business-type', who, { toOption: 'COMPANY' });
      expect(res.statusCode, res.body).toBe(403);
      expect((await call('GET', '/api/v1/vendor/account-change', who)).statusCode).toBe(403);
    }
  });
});

describe('(c) approved: the choice, the papers and the seller name switch together', () => {
  it('a person approves with a reason; the company papers count, the own-name ones no longer gate; a store name that is the owner\'s own is never stamped (#2479)', async () => {
    const o = await ownNameStore();
    const changeId = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data.id as string;
    const orderId = await placedOrder(o.vendorId);
    const orderBefore = await orderFacts(orderId);
    const certificate = await file(o.userId, 'certificate_of_incorporation');
    await approve(certificate.id, 'certificate_of_incorporation');
    const name = (await store(o.vendorId)).name;

    // a paper still waiting: refused, and nothing moved
    const early = await admin('PUT', `/account-changes/${changeId}/approve`, { sellerNames: { [o.vendorId]: name } });
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error.code).toBe('CHANGE_PAPERS_INCOMPLETE');
    expect(await owner(o.userId)).toMatchObject({ accountBasis: 'OWNER' });

    for (const docType of ['account_holder_id', 'company_authority_letter']) await approve((await file(o.userId, docType)).id, docType);
    // the name the person confirms must be the store's name now
    const wrong = await admin('PUT', `/account-changes/${changeId}/approve`, { sellerNames: { [o.vendorId]: 'Some Other Name' } });
    expect(wrong.json().error.code).toBe('SELLER_NAME_CHANGED');
    // a reason is owed
    expect((await admin('PUT', `/account-changes/${changeId}/approve`, { sellerNames: { [o.vendorId]: name } }, null)).statusCode).toBe(400);
    expect(await system(() => app.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: changeId } }))).toMatchObject({ status: 'PENDING' });
    expect(await sellerName(o)).toBe('Asha Ramdin');

    const res = await admin('PUT', `/account-changes/${changeId}/approve`, { sellerNames: { [o.vendorId]: name } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'APPROVED', toOption: 'COMPANY' });
    expect(await owner(o.userId)).toMatchObject({ accountBasis: 'COMPANY' });
    // [COORD ruling 11 Nov 2026 · review-2479] "Asha Ramdin" is the owner's own name: the approval goes through, nothing
    // is stamped, and customers see "Ask the store" until the company's name is typed from its certificate.
    expect(await store(o.vendorId)).toMatchObject({
      status: 'ACTIVE', isVerified: true, acceptingOrders: true, tradesUnderOwnName: false, sellerNameCheckedName: null, sellerNameCheckedById: null,
    });
    const status = (await call('GET', '/api/v1/verification/status?role=STORE', o)).json().data;
    expect(status.checklist).toEqual(['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'storefront_photo']);
    expect(status.accountBasis).toBe('COMPANY');
    expect(await service.isRoleVerified(o.userId, 'STORE', app.prisma, o.vendorId)).toBe(true);
    // the seller is the business now, never the owner's own name
    expect(await sellerName(o)).toBeNull();
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { entityId: changeId, action: 'APPROVE_BUSINESS_TYPE_CHANGE' } }));
    expect(audit?.userId).toBe(adminId);
    expect(audit?.changes).toMatchObject({ sellerNamesConfirmed: [], sellerNamesNotConfirmed: [o.vendorId], sellerNameNotConfirmedCode: 'SELLER_NAME_IS_A_PERSON' });
    expect(await system(() => app.prisma.notification.count({ where: { userId: o.userId, data: { path: ['kind'], equals: 'account_change_approved' } } }))).toBe(1);
    // the open order did not move
    expect(await orderFacts(orderId)).toEqual(orderBefore);
    // decided once
    expect((await admin('PUT', `/account-changes/${changeId}/approve`, { sellerNames: { [o.vendorId]: name } })).json().error.code).toBe('ACCOUNT_CHANGE_DECIDED');
  });

  it('only a document reviewer decides: an admin without the grant is refused', async () => {
    const o = await ownNameStore();
    const changeId = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data.id as string;
    const plain = await system(() => app.prisma.user.create({ data: {
      phone: `+5926${NUM}91`, firstName: 'Plain', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    } }));
    users.push(plain.id);
    const token = await session(plain.id, 'ADMIN');
    for (const url of [`/account-changes/${changeId}/approve`, `/account-changes/${changeId}/refuse`]) {
      const res = await app.inject({ method: 'PUT', url: `/api/v1/admin${url}`, payload: {}, headers: { authorization: `Bearer ${token}`, 'x-swift-reason': REASON, 'content-type': 'application/json' } });
      expect(res.statusCode, url).toBe(403);
    }
    expect(await system(() => app.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: changeId } }))).toMatchObject({ status: 'PENDING' });
  });
});

describe('(c) refused: nothing changes, and the store reads why', () => {
  it('the papers filed for it are closed (none can count later); the store keeps everything it had', async () => {
    const o = await ownNameStore();
    const changeId = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data.id as string;
    const approved = await file(o.userId, 'certificate_of_incorporation');
    await approve(approved.id, 'certificate_of_incorporation');
    const waiting = await file(o.userId, 'company_authority_letter');
    const before = { owner: await owner(o.userId), store: await store(o.vendorId), seller: await sellerName(o) };

    const why = 'The letter is not on the company’s letterhead and names a different director.';
    const res = await admin('PUT', `/account-changes/${changeId}/refuse`, {}, why);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'REFUSED', refusalReason: why });
    expect(await owner(o.userId)).toEqual(before.owner);
    const after = await store(o.vendorId);
    expect({ ...after, updatedAt: before.store.updatedAt }).toEqual(before.store);
    expect(await sellerName(o)).toBe(before.seller);
    // the approved paper is withdrawn, the waiting one leaves review
    expect(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: approved.id }, select: { state: true } }))).toEqual({ state: 'REVOKED' });
    expect(await system(() => app.prisma.documentRecord.findUniqueOrThrow({ where: { submissionId: approved.id }, select: { status: true } }))).toEqual({ status: 'REVOKED' });
    expect(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: waiting.id }, select: { state: true } }))).toEqual({ state: 'EXPIRED' });
    expect(await system(() => app.prisma.reviewCase.count({ where: { submissionId: waiting.id, closedAt: null } }))).toBe(0);
    // the store reads why, on its Account and in its notices
    const view = (await call('GET', '/api/v1/vendor/account-change', o)).json().data;
    expect(view.change).toMatchObject({ status: 'REFUSED', refusalReason: why });
    const notice = await system(() => app.prisma.notification.findFirstOrThrow({ where: { userId: o.userId, data: { path: ['kind'], equals: 'account_change_refused' } } }));
    expect(notice.body).toContain(why);
    // and it may ask again, filing the same papers again
    const again = await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' });
    expect(again.statusCode, again.body).toBe(201);
    expect((await file(o.userId, 'certificate_of_incorporation')).accountChangeId).toBe(again.json().data.id);
  });

  it('a paper of a change that did not go through never counts, even one left approved; only an approved change lends its papers', async () => {
    const o = await ownNameStore();
    const changeId = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data.id as string;
    const certificate = await file(o.userId, 'certificate_of_incorporation');
    await approve(certificate.id, 'certificate_of_incorporation');
    const counted = () => recordEvidenceFor(app.prisma, o.userId, ['certificate_of_incorporation'], new Date());
    // pending: not live (the store's seller name and gate read the old papers)
    expect(await counted()).toEqual([]);
    // what the change would give, read for its decision: only with the change named
    expect((await recordEvidenceFor(app.prisma, o.userId, ['certificate_of_incorporation'], new Date(), { withChange: changeId })).map((r) => r.docType)).toEqual(['certificate_of_incorporation']);
    // refused WITHOUT its papers being closed (a paper decided at the same moment, say): still never live
    await system(() => app.prisma.accountChangeRequest.update({ where: { id: changeId }, data: { status: 'REFUSED', decidedAt: new Date(), decidedById: adminId, decisionReason: 'test: refused with a paper still approved' } }));
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: certificate.id } }))).state).toBe('COMMITTED');
    expect(await counted()).toEqual([]);
    expect(await recordEvidenceFor(app.prisma, o.userId, ['certificate_of_incorporation'], new Date(), { withChange: 'another-change' })).toEqual([]);
    expect(await sellerName(o)).toBe('Asha Ramdin');
    // a decided change is final: it can never be flipped to APPROVED afterwards
    await expect(system(() => app.prisma.accountChangeRequest.update({ where: { id: changeId }, data: { status: 'APPROVED' } }))).rejects.toThrow(/final/);
    // and a paper is never moved into or out of a change
    await expect(system(() => app.prisma.verificationDocument.update({ where: { id: certificate.id }, data: { accountChangeId: null } }))).rejects.toThrow(/fixed/);
  });

  it('the holder may withdraw a change waiting: the same as a refusal, nothing moves', async () => {
    const o = await ownNameStore();
    const changeId = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data.id as string;
    const res = await call('POST', `/api/v1/vendor/account-change/${changeId}/withdraw`, o);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('WITHDRAWN');
    expect(await owner(o.userId)).toMatchObject({ accountBasis: 'OWNER' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (d) Company account-holder handover
// ---------------------------------------------------------------------------------------------------------------------

async function nameNewHolder(o: Who, next: { phone: string }) {
  await grantStepUp(app, o.token);
  return call('POST', '/api/v1/vendor/account-change/handover', o, { phone: next.phone });
}

describe('(d) a company hands its account to a new account holder', () => {
  it('approved: access moves to the new person for every branch, the old holder loses it, open orders are untouched', async () => {
    const o = await companyStore();
    const branch = await system(async () => {
      const first = await app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId } });
      return app.prisma.vendor.create({ data: {
        ownerId: first.ownerId, name: `${first.name} North`, slug: `${first.slug}-n-${nanoid(5).toLowerCase()}`, vendorType: first.vendorType, phone: first.phone,
        addressLine1: first.addressLine1, city: first.city, region: first.region, latitude: first.latitude, longitude: first.longitude, tenantId: first.tenantId,
        status: 'ACTIVE', isVerified: true, acceptingOrders: true,
      } });
    });
    const next = await person('Devi', 'Singh');
    // the person named was a manager at the branch
    await system(() => app.prisma.vendorStaff.create({ data: { vendorId: branch.id, userId: next.userId, role: 'MANAGER', invitedBy: o.userId } }));
    const orderId = await placedOrder(o.vendorId);
    const orderBefore = await orderFacts(orderId);

    const named = await nameNewHolder(o, next);
    expect(named.statusCode, named.body).toBe(201);
    const changeId = named.json().data.id as string;
    expect(named.json().data).toMatchObject({ kind: 'HOLDER_HANDOVER', status: 'PENDING', accepted: false });
    // before a person approves, the person named has no store access at all
    expect((await call('GET', '/api/v1/vendor/account-change', { token: next.token })).statusCode).toBe(403);
    const waiting = (await call('GET', '/api/v1/customer/account-handovers', next)).json().data;
    expect(waiting.map((h: { id: string }) => h.id)).toEqual([changeId]);
    // papers are filed only after they say yes
    await expect(file(next.userId, 'account_holder_id')).rejects.toMatchObject({ code: 'INVALID_DOC_TYPE' });
    expect((await call('POST', `/api/v1/customer/account-handovers/${changeId}/accept`, next)).statusCode).toBe(200);
    for (const docType of COMPANY_STORE) {
      const doc = await file(next.userId, docType);
      expect(doc.accountChangeId, docType).toBe(changeId);
      await approve(doc.id, docType);
    }
    const oldSessions = await system(() => app.prisma.session.count({ where: { userId: o.userId } }));
    expect(oldSessions).toBeGreaterThan(0);

    const res = await admin('PUT', `/account-changes/${changeId}/approve`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('APPROVED');
    // the account (every branch) is the new person's
    expect(await system(() => app.prisma.vendorOwner.findUnique({ where: { userId: next.userId }, select: { vendors: { select: { id: true } } } })))
      .toMatchObject({ vendors: expect.arrayContaining([{ id: o.vendorId }, { id: branch.id }]) });
    expect(await system(() => app.prisma.vendorOwner.findUnique({ where: { userId: o.userId } }))).toBeNull();
    // the old holder is out: every session ended, the store role gone, the store refuses them
    expect(await system(() => app.prisma.session.count({ where: { userId: o.userId } }))).toBe(0);
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: o.userId } }))).roles).not.toContain('VENDOR_OWNER');
    expect((await call('GET', '/api/v1/vendor/account-change', o)).statusCode).toBe(401);
    // the new holder holds it: the role, no leftover manager place, and the store answers them as its owner
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: next.userId } }))).roles).toContain('VENDOR_OWNER');
    expect(await system(() => app.prisma.vendorStaff.count({ where: { userId: next.userId } }))).toBe(0);
    expect((await call('GET', '/api/v1/vendor/account-change', next)).json().data).toMatchObject({ current: 'COMPANY' });
    // both stores still sell, on the new holder's checked papers
    for (const id of [o.vendorId, branch.id]) {
      expect(await store(id), id).toMatchObject({ status: 'ACTIVE', isVerified: true });
      expect(await service.isRoleVerified(next.userId, 'STORE', app.prisma, id), id).toBe(true);
    }
    // money never follows the old holder: the MMG number they set is cleared; the open order keeps its own
    expect(await store(o.vendorId)).toMatchObject({ mmgNumber: null, mmgPayUrl: null });
    expect(await orderFacts(orderId)).toEqual(orderBefore);
    expect(await system(() => app.prisma.auditLog.count({ where: { entityId: changeId, action: 'APPROVE_ACCOUNT_HANDOVER', userId: adminId } }))).toBe(1);
    expect(await system(() => app.prisma.notification.count({ where: { userId: o.userId, data: { path: ['kind'], equals: 'account_handover_ended' } } }))).toBe(1);
  });

  it('refused: nothing changes — the old holder keeps the account and every session; the person named gets nothing', async () => {
    const o = await companyStore();
    const next = await person('Ravi', 'Khan');
    const changeId = (await nameNewHolder(o, next)).json().data.id as string;
    await call('POST', `/api/v1/customer/account-handovers/${changeId}/accept`, next);
    const id = await file(next.userId, 'account_holder_id');
    await approve(id.id, 'account_holder_id');
    const sessions = await system(() => app.prisma.session.count({ where: { userId: o.userId } }));
    const res = await admin('PUT', `/account-changes/${changeId}/refuse`, {}, 'The director’s letter names someone else as the account holder.');
    expect(res.statusCode, res.body).toBe(200);
    expect((await owner(o.userId)).userId).toBe(o.userId);
    expect(await system(() => app.prisma.session.count({ where: { userId: o.userId } }))).toBe(sessions);
    expect(await system(() => app.prisma.vendorOwner.findUnique({ where: { userId: next.userId } }))).toBeNull();
    expect((await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: next.userId } }))).roles).not.toContain('VENDOR_OWNER');
    expect(await store(o.vendorId)).toMatchObject({ status: 'ACTIVE', isVerified: true, mmgNumber: '+5926112233' });
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: id.id } }))).state).toBe('REVOKED');
  });

  it('never without a person: the new holder cannot be approved before saying yes, nor with a paper missing; only the holder names one', async () => {
    const o = await companyStore();
    const next = await person('Lena', 'Ali');
    // a manager, a stranger and the person named cannot start or withdraw it
    const manager = await person('Mo', 'Staff');
    await system(() => app.prisma.vendorStaff.create({ data: { vendorId: o.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: o.userId } }));
    await grantStepUp(app, manager.token);
    expect((await call('POST', '/api/v1/vendor/account-change/handover', { ...manager, vendorId: o.vendorId }, { phone: next.phone })).statusCode).toBe(403);
    // a fresh "confirm it's you" is owed
    expect((await call('POST', '/api/v1/vendor/account-change/handover', o, { phone: next.phone })).statusCode).toBeGreaterThanOrEqual(400);
    const changeId = (await nameNewHolder(o, next)).json().data.id as string;
    expect((await call('POST', `/api/v1/vendor/account-change/${changeId}/withdraw`, { token: next.token })).statusCode).toBe(403);
    const unaccepted = await admin('PUT', `/account-changes/${changeId}/approve`, {});
    expect(unaccepted.statusCode).toBe(409);
    await call('POST', `/api/v1/customer/account-handovers/${changeId}/accept`, next);
    await approve((await file(next.userId, 'account_holder_id')).id, 'account_holder_id');
    const incomplete = await admin('PUT', `/account-changes/${changeId}/approve`, {});
    expect(incomplete.json().error.code).toBe('CHANGE_PAPERS_INCOMPLETE');
    expect((await owner(o.userId)).userId).toBe(o.userId);
    // a business owner's account is never handed over (a new owner signs up with their own papers)
    const ownName = await ownNameStore();
    const other = await person('Nia', 'Roy');
    expect((await nameNewHolder(ownName, other)).json().error.code).toBe('HANDOVER_NOT_APPLICABLE');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The seller's legal name (#2476) follows the change, never the old business type or holder
// ---------------------------------------------------------------------------------------------------------------------

const REGISTRATION = ['business_registration', 'certificate_of_incorporation'];
const accountOf = (userId: string) => system(() => app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId },
  select: { id: true, accountBasis: true, sellerLegalName: true, sellerLegalNameAt: true, sellerLegalNameById: true, sellerLegalNameDocId: true } }));
const legalNameTrail = (vendorOwnerId: string, action = 'SET_SELLER_LEGAL_NAME') => system(() => app.prisma.auditLog.findMany({
  where: { action, entityId: vendorOwnerId }, orderBy: { createdAt: 'asc' }, select: { userId: true, entity: true, changes: true } }));

/** A live store whose registration paper a person checked, typing the seller's legal name from it (#2476). */
async function namedStore(o: Who, basis: 'OWNER' | 'COMPANY', legalName: string): Promise<string> {
  await become(o, { ...(basis === 'COMPANY' ? { accountBasis: 'COMPANY' } : {}), name: `Corner Shop ${RUN} ${seq}` });
  const checklist = (await call('GET', '/api/v1/verification/status?role=STORE', o)).json().data.checklist as string[];
  let paper = '';
  for (const docType of checklist) {
    const doc = await file(o.userId, docType);
    if (REGISTRATION.includes(docType)) paper = doc.id;
    await approve(doc.id, docType, REGISTRATION.includes(docType) ? { legalName } : {});
  }
  await makeLive(o.vendorId);
  expect(await service.isRoleVerified(o.userId, 'STORE', app.prisma, o.vendorId)).toBe(true);
  expect(await sellerName(o)).toBe(legalName);
  return paper;
}
/** The console's read of the change: what approving it would do to the account's legal name (FOLLOWUPS-2475). */
const previewOf = async (changeId: string) => {
  const res = await admin('GET', `/account-changes/${changeId}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.sellerLegalNameOnApproval as { effect: string; from: string | null; to: string | null; docType: string | null } | null;
};
/** Files (and a person approves) every paper the change still waits for; a registration paper gets `typed`. */
async function fileChangePapers(paperHolder: string, view: { papers: Array<{ docType: string; state: string }> }, typed: Record<string, unknown> = {}) {
  for (const { docType } of view.papers.filter((p) => p.state !== 'APPROVED')) {
    await approve((await file(paperHolder, docType)).id, docType, REGISTRATION.includes(docType) ? typed : {});
  }
}

describe('[R3 · review-2476] the seller legal name follows the change, never the old business type or holder', () => {
  it.each(['COMPANY', 'MANAGER'] as const)('approved to %s with no name typed for it: the old legal name is cleared, never shown for the new account', async (toOption) => {
    const o = await person('Asha', 'Ramdin');
    // (#2479: a person's own name is refused on every registration paper, so the old name is a business's)
    const oldPaper = await namedStore(o, 'OWNER', 'Ramdin Trading');
    const asked = await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption });
    expect(asked.statusCode, asked.body).toBe(201);
    const changeId = asked.json().data.id as string;
    await fileChangePapers(o.userId, asked.json().data); // nothing typed (an internal caller)
    expect(await sellerName(o)).toBe('Ramdin Trading'); // still selling on the old papers while it waits
    const name = (await store(o.vendorId)).name;
    // the reviewer sees, before deciding, that approval clears it (the queue and the change's own read agree)
    const preview = { effect: 'CLEARED', from: 'Ramdin Trading', to: null, docType: null };
    expect(await previewOf(changeId)).toEqual(preview);
    const queue = (await admin('GET', '/account-changes?status=PENDING')).json().data as Array<{ id: string; sellerLegalNameOnApproval: unknown }>;
    expect(queue.find((c) => c.id === changeId)?.sellerLegalNameOnApproval).toEqual(preview);

    const res = await admin('PUT', `/account-changes/${changeId}/approve`, { sellerNames: { [o.vendorId]: name } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.sellerLegalNameOnApproval).toBeNull(); // decided: nothing left to preview
    const account = await accountOf(o.userId);
    expect(account).toEqual({ id: account.id, accountBasis: toOption, sellerLegalName: null, sellerLegalNameAt: null, sellerLegalNameById: null, sellerLegalNameDocId: null });
    // the storefront names the store the approving person confirmed, never the owner's own name
    expect(await sellerName(o)).toBe(name);
    expect(await sellerName(o)).not.toBe('Ramdin Trading');
    // the trail: who cleared it, with which change, and what customers saw before
    const trail = await legalNameTrail(account.id);
    expect(trail.at(-1)).toEqual({ userId: adminId, entity: 'VendorOwner', changes: {
      accountId: o.userId, documentId: null, docType: null, changeId, from: 'Ramdin Trading', fromDocumentId: oldPaper, to: null,
    } });
  });

  it('a name typed from the change\'s own paper is HELD while it waits (customers keep the old one); refused, it never shows; approved, it names the seller', async () => {
    const o = await person('Ravi', 'Persaud');
    const oldPaper = await namedStore(o, 'OWNER', 'Persaud Trading');
    const first = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    const certificate = await file(o.userId, 'certificate_of_incorporation');
    // through the reviewer's console door, which writes the decision's trail
    const checked = await admin('PUT', `/verification/${certificate.id}/approve`, { registrationKind: 'COMPANY', legalName: 'Persaud Holdings Limited' });
    expect(checked.statusCode, checked.body).toBe(200);
    // waiting: the account's name and the storefront are unchanged; the new name is held on the change, with its trail
    expect(await accountOf(o.userId)).toMatchObject({ sellerLegalName: 'Persaud Trading', sellerLegalNameDocId: oldPaper });
    expect(await sellerName(o)).toBe('Persaud Trading');
    expect(await system(() => app.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: first.id }, select: { sellerLegalName: true, sellerLegalNameDocId: true, sellerLegalNameById: true } })))
      .toEqual({ sellerLegalName: 'Persaud Holdings Limited', sellerLegalNameDocId: certificate.id, sellerLegalNameById: adminId });
    expect((await legalNameTrail(first.id, 'HOLD_SELLER_LEGAL_NAME')).map((t) => t.changes)).toEqual([{
      accountId: o.userId, documentId: certificate.id, docType: 'certificate_of_incorporation', from: null, fromDocumentId: null, to: 'Persaud Holdings Limited',
    }]);
    // the reviewer reads what approval would do: the held name replaces the old one
    expect(await previewOf(first.id)).toEqual({ effect: 'SET', from: 'Persaud Trading', to: 'Persaud Holdings Limited', docType: 'certificate_of_incorporation' });

    // refused: the held name never names anyone; the old one stands
    expect((await admin('PUT', `/account-changes/${first.id}/refuse`, {}, 'The certificate is for a different company.')).statusCode).toBe(200);
    expect(await accountOf(o.userId)).toMatchObject({ sellerLegalName: 'Persaud Trading', sellerLegalNameDocId: oldPaper });
    expect(await sellerName(o)).toBe('Persaud Trading');

    // asked again and approved: the name typed from the change's own certificate names the seller, in the same commit
    const again = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    await fileChangePapers(o.userId, again, { legalName: 'Persaud Holdings Limited' });
    const certificateNow = await system(() => app.prisma.verificationDocument.findFirstOrThrow({ where: { accountChangeId: again.id, docType: 'certificate_of_incorporation' }, select: { id: true } }));
    expect(await sellerName(o)).toBe('Persaud Trading');
    expect(await previewOf(again.id)).toEqual({ effect: 'SET', from: 'Persaud Trading', to: 'Persaud Holdings Limited', docType: 'certificate_of_incorporation' });
    const name = (await store(o.vendorId)).name;
    expect((await admin('PUT', `/account-changes/${again.id}/approve`, { sellerNames: { [o.vendorId]: name } })).statusCode).toBe(200);
    const account = await accountOf(o.userId);
    expect(account).toMatchObject({ accountBasis: 'COMPANY', sellerLegalName: 'Persaud Holdings Limited', sellerLegalNameDocId: certificateNow.id, sellerLegalNameById: adminId });
    expect(await sellerName(o)).toBe('Persaud Holdings Limited');
    expect((await legalNameTrail(account.id)).at(-1)?.changes).toEqual({
      accountId: o.userId, documentId: certificateNow.id, docType: 'certificate_of_incorporation', changeId: again.id,
      from: 'Persaud Trading', fromDocumentId: oldPaper, to: 'Persaud Holdings Limited',
    });
  });

  it('a paper filed for a change to a manager\'s account is checked as a manager\'s: the holder\'s own name is refused', async () => {
    const o = await ownNameStore(); // Asha Ramdin, trading under her own name
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'MANAGER' })).json().data;
    const registration = await file(o.userId, 'business_registration');
    expect(registration.accountChangeId).toBe(asked.id);
    await expect(approve(registration.id, 'business_registration', { legalName: 'Asha Ramdin' })).rejects.toMatchObject({ code: 'LEGAL_NAME_IS_A_PERSON' });
    await approve(registration.id, 'business_registration', { legalName: 'Ramdin Family Business' });
    await fileChangePapers(o.userId, (await call('GET', '/api/v1/vendor/account-change', o)).json().data.change);
    expect(await sellerName(o)).toBe('Asha Ramdin'); // the own-name trader, until a person approves the change
    const name = (await store(o.vendorId)).name;
    expect((await admin('PUT', `/account-changes/${asked.id}/approve`, { sellerNames: { [o.vendorId]: name } })).statusCode).toBe(200);
    expect(await accountOf(o.userId)).toMatchObject({ accountBasis: 'MANAGER', sellerLegalName: 'Ramdin Family Business', sellerLegalNameDocId: registration.id });
    expect(await sellerName(o)).toBe('Ramdin Family Business');
  });

  it('a handover: the name typed from the new holder\'s own certificate names the seller; the old holder\'s paper no longer does', async () => {
    const o = await person('Kamla', 'Persaud');
    const oldPaper = await namedStore(o, 'COMPANY', 'Persaud Chicken Limited');
    const next = await person('Devi', 'Singh');
    const changeId = (await nameNewHolder(o, next)).json().data.id as string;
    expect((await call('POST', `/api/v1/customer/account-handovers/${changeId}/accept`, next)).statusCode).toBe(200);
    for (const docType of COMPANY_STORE) {
      await approve((await file(next.userId, docType)).id, docType, REGISTRATION.includes(docType) ? { legalName: 'Persaud Chicken Limited' } : {});
    }
    const theirs = await system(() => app.prisma.verificationDocument.findFirstOrThrow({ where: { accountChangeId: changeId, docType: 'certificate_of_incorporation' }, select: { id: true } }));
    expect(await accountOf(o.userId)).toMatchObject({ sellerLegalName: 'Persaud Chicken Limited', sellerLegalNameDocId: oldPaper });
    // the same words, now from the new holder's own certificate: the account's name is SET from it (not kept)
    expect(await previewOf(changeId)).toEqual({ effect: 'SET', from: 'Persaud Chicken Limited', to: 'Persaud Chicken Limited', docType: 'certificate_of_incorporation' });
    expect((await admin('PUT', `/account-changes/${changeId}/approve`, {})).statusCode).toBe(200);
    const account = await accountOf(next.userId);
    expect(account).toMatchObject({ sellerLegalName: 'Persaud Chicken Limited', sellerLegalNameDocId: theirs.id, sellerLegalNameById: adminId });
    expect(await sellerName({ ...next, vendorId: o.vendorId })).toBe('Persaud Chicken Limited');
    expect((await legalNameTrail(account.id)).at(-1)?.changes).toMatchObject({ accountId: next.userId, documentId: theirs.id, changeId, fromDocumentId: oldPaper });
  });

  it('no legal name now and none typed for the change: the console says approval keeps it so (nothing moves, no trail row)', async () => {
    const o = await ownNameStore(); // trading under her own name: no account legal name
    expect(await accountOf(o.userId)).toMatchObject({ sellerLegalName: null, sellerLegalNameDocId: null });
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    await fileChangePapers(o.userId, asked); // nothing typed (an internal caller)
    expect(await previewOf(asked.id)).toEqual({ effect: 'KEPT', from: null, to: null, docType: null });
    const name = (await store(o.vendorId)).name;
    expect((await admin('PUT', `/account-changes/${asked.id}/approve`, { sellerNames: { [o.vendorId]: name } })).statusCode).toBe(200);
    const account = await accountOf(o.userId);
    expect(account).toMatchObject({ accountBasis: 'COMPANY', sellerLegalName: null, sellerLegalNameDocId: null });
    expect(await legalNameTrail(account.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [review-2475] security fix round
// ---------------------------------------------------------------------------------------------------------------------

/** A company's account handed over (approved) to a new person; the old holder signs in again as a customer. */
async function handedOver(x: Who) {
  const next = await person('Devi', 'Singh');
  const named = await nameNewHolder(x, next);
  expect(named.statusCode, named.body).toBe(201);
  const changeId = named.json().data.id as string;
  expect((await call('POST', `/api/v1/customer/account-handovers/${changeId}/accept`, next)).statusCode).toBe(200);
  for (const docType of COMPANY_STORE) await approve((await file(next.userId, docType)).id, docType);
  const res = await admin('PUT', `/account-changes/${changeId}/approve`, {});
  expect(res.statusCode, res.body).toBe(200);
  x.token = await session(x.userId, 'CUSTOMER');
  return { next, changeId };
}

describe('[review-2475 F1] a company\'s papers never follow the person to another account', () => {
  it('the old holder\'s papers of the account leave service at the handover, in its transaction', async () => {
    const x = await companyStore();
    const before = await system(() => app.prisma.verificationDocument.findMany({ where: { userId: x.userId, docType: { in: COMPANY_STORE } }, select: { id: true } }));
    const { changeId } = await handedOver(x);
    const after = await system(() => app.prisma.verificationDocument.findMany({ where: { id: { in: before.map((d) => d.id) } }, select: { state: true } }));
    expect(after.map((d) => d.state)).toEqual(before.map(() => 'REVOKED'));
    expect(await recordEvidenceFor(app.prisma, x.userId, COMPANY_STORE, new Date())).toEqual([]);
    const audit = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { entityId: changeId, action: 'APPROVE_ACCOUNT_HANDOVER' } }));
    expect(audit.changes).toMatchObject({ oldHolderPapersRetired: before.length });
  });

  it('[P1] the ex-holder named for ANOTHER company files every paper for it: nothing of the first company counts', async () => {
    const x = await companyStore();
    await handedOver(x);
    const y = await companyStore();
    const xPhone = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: x.userId }, select: { phone: true } }))).phone;
    const named = await nameNewHolder(y, { phone: xPhone });
    expect(named.statusCode, named.body).toBe(201);
    const changeId = named.json().data.id as string;
    const accepted = (await call('POST', `/api/v1/customer/account-handovers/${changeId}/accept`, x)).json().data;
    expect(accepted.papers.map((p: { docType: string; state: string }) => [p.docType, p.state])).toEqual(COMPANY_STORE.map((d) => [d, 'MISSING']));
    expect(accepted.papersComplete).toBe(false);
    const res = await admin('PUT', `/account-changes/${changeId}/approve`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CHANGE_PAPERS_INCOMPLETE');
    expect((await owner(y.userId)).userId).toBe(y.userId);
  });

  it('[P2] the ex-holder opens a NEW company store: it does not pass on the handed-over company\'s papers', async () => {
    const x = await companyStore();
    await handedOver(x);
    x.vendorId = '';
    await become(x, { accountBasis: 'COMPANY', name: `Other Company ${RUN} ${seq}` });
    expect(await service.isRoleVerified(x.userId, 'STORE', app.prisma, x.vendorId)).toBe(false);
  });

  it('the console names the business the papers name: the legal name now, and the one typed for this change', async () => {
    const o = await person('Ravi', 'Persaud');
    await namedStore(o, 'OWNER', 'Persaud Trading');
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    const shown = async () => (await admin('GET', `/account-changes/${asked.id}`)).json().data.legalName;
    expect(await shown()).toEqual({ account: 'Persaud Trading', change: null });
    const certificate = await file(o.userId, 'certificate_of_incorporation');
    await approve(certificate.id, 'certificate_of_incorporation', { legalName: 'Persaud Holdings Limited' });
    expect(await shown()).toEqual({ account: 'Persaud Trading', change: 'Persaud Holdings Limited' });
  });
});

describe('[review-2475 F2] a saved card never outlives its holder\'s hold on the store', () => {
  it('the old holder\'s ACTIVE card on the store\'s weekly fee is revoked at the handover, its unsent charges closed, with a trail', async () => {
    const x = await companyStore();
    const sub = await system(async () => (await app.prisma.subscription.findFirst({ where: { vendorId: x.vendorId }, select: { id: true } }))
      ?? app.prisma.subscription.create({ data: {
        vendorId: x.vendorId, type: 'RETAIL_STORE', status: 'ACTIVE', weeklyRate: 1000, billingMethod: 'CARD',
        currentPeriodStart: new Date(Date.now() - 7 * DAY), currentPeriodEnd: new Date(Date.now() + DAY), nextBillingDate: new Date(Date.now() + DAY),
      }, select: { id: true } }));
    const card = await system(async () => app.prisma.paymentInstrument.create({ data: {
      subscriptionId: sub.id, userId: x.userId, provider: 'fakebank', environment: 'sandbox', providerAccount: `r2475-${RUN}`,
      ...(await sealVaultToken(`tok_${nanoid(10)}`)), brand: 'VISA', last4: '1111', expMonth: 12, expYear: new Date().getUTCFullYear() + 3,
      consentVersion: 'card-on-file-v1', consentAt: new Date(),
    }, select: { id: true } }));
    const { changeId } = await handedOver(x);
    expect(await system(() => app.prisma.paymentInstrument.findUniqueOrThrow({ where: { id: card.id }, select: { status: true, revokedBy: true } })))
      .toEqual({ status: 'REVOKED', revokedBy: adminId });
    const trail = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { action: 'CARD_REVOKED_ACCOUNT_HANDOVER', entityId: card.id } }));
    expect(trail.changes).toMatchObject({ subscriptionId: sub.id, changeId, status: 'REVOKED' });
    expect((await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { entityId: changeId, action: 'APPROVE_ACCOUNT_HANDOVER' } }))).changes).toMatchObject({ cardsRevoked: 1 });
  });
});

describe('[review-2475 F3] the account holder never reads a reviewer\'s note on the person named\'s papers', () => {
  it('[P3] the holder sees how far each paper got; the person named sees the note', async () => {
    const x = await companyStore();
    const next = await person('Ravi', 'Khan');
    const changeId = (await nameNewHolder(x, next)).json().data.id as string;
    await call('POST', `/api/v1/customer/account-handovers/${changeId}/accept`, next);
    const doc = await file(next.userId, 'account_holder_id');
    await service.rejectDocument(doc.id, adminId, 'PRIVATE NOTE ABOUT THE NAMED PERSONS ID');
    const holderView = (await call('GET', '/api/v1/vendor/account-change', x)).json().data;
    const paper = holderView.change.papers.find((p: { docType: string }) => p.docType === 'account_holder_id');
    expect(paper).toMatchObject({ state: 'REJECTED', note: null, documentId: null });
    expect(JSON.stringify(holderView)).not.toContain('PRIVATE NOTE');
    expect(JSON.stringify(holderView)).not.toContain(doc.id);
    const theirs = (await call('GET', '/api/v1/customer/account-handovers', next)).json().data[0];
    expect(theirs.papers.find((p: { docType: string }) => p.docType === 'account_holder_id')).toMatchObject({ note: 'PRIVATE NOTE ABOUT THE NAMED PERSONS ID', documentId: doc.id });
  });
});

describe('[review-2475 F5] the console and the registration check read the storefront\'s rule', () => {
  it('a registration approved for a change still waiting: the console still names the own-name trader, and no registration is on file yet', async () => {
    const o = await ownNameStore();
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'REGISTERED' })).json().data;
    const registration = await file(o.userId, 'business_registration');
    expect(registration.accountChangeId).toBe(asked.id);
    await approve(registration.id, 'business_registration', { legalName: 'Ramdin Supplies' });
    expect(await sellerName(o)).toBe('Asha Ramdin');
    expect((await sellerNameViews(app.prisma, [o.vendorId])).get(o.vendorId)).toEqual({ basis: 'OWN_NAME', value: 'Asha Ramdin' });
    expect(await validRegistrationRecord(app.prisma, o.userId)).toBeNull();
  });
});

describe('[review-2475 F6] recusal is checked again inside the decision\'s transaction', () => {
  it.each(['approve', 'refuse'] as const)('%s: a reviewer recused between the first check and the decision decides nothing', async (verb) => {
    const o = await ownNameStore();
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    if (verb === 'approve') await fileChangePapers(o.userId, asked);
    const name = (await store(o.vendorId)).name;
    recusal.armedFor = adminId; recusal.seen = 0;
    try {
      const res = await admin('PUT', `/account-changes/${asked.id}/${verb}`, verb === 'approve' ? { sellerNames: { [o.vendorId]: name } } : {});
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('REVIEWER_RECUSED');
      expect(recusal.seen).toBe(2);
    } finally { recusal.armedFor = null; }
    expect(await system(() => app.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: asked.id }, select: { status: true } }))).toEqual({ status: 'PENDING' });
  });
});

describe('[review-2475 F7] a change to "own name" is checked again when a person decides it', () => {
  it('a store renamed, or a registration on file, since the ask: the approval is refused and nothing moves', async () => {
    const o = await person('Asha', 'Ramdin');
    await become(o, { name: 'Asha Ramdin' }); // a registered business's store, not live yet, named as its owner
    const asked = await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'OWN_NAME' });
    expect(asked.statusCode, asked.body).toBe(201);
    const changeId = asked.json().data.id as string;
    const signed = await call('POST', '/api/v1/vendor/account-change/own-name', o, { accept: true, attestationVersion: 'v1' });
    expect(signed.statusCode, signed.body).toBe(201);
    await approve(signed.json().data.declaration.id, 'own_name_declaration');
    await fileChangePapers(o.userId, (await call('GET', '/api/v1/vendor/account-change', o)).json().data.change);
    // renamed since the ask
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { name: 'Ramdin Supplies' } }));
    const renamed = await admin('PUT', `/account-changes/${changeId}/approve`, {});
    expect(renamed.json().error?.code, renamed.body).toBe('OWN_NAME_MISMATCH');
    // named as the owner again, but a business registration was approved meanwhile
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { name: 'Asha Ramdin' } }));
    await approve((await file(o.userId, 'business_registration')).id, 'business_registration');
    const registered = await admin('PUT', `/account-changes/${changeId}/approve`, {});
    expect(registered.json().error?.code, registered.body).toBe('ALREADY_REGISTERED');
    expect(await owner(o.userId)).toMatchObject({ accountBasis: 'OWNER' });
    expect((await store(o.vendorId)).tradesUnderOwnName).toBe(false);
    expect(await system(() => app.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: changeId }, select: { status: true } }))).toEqual({ status: 'PENDING' });
  });
});

describe('[review-2475 F8] asking is limited', () => {
  it('an ask -> withdraw loop stops at 3 asks a day', async () => {
    const o = await ownNameStore();
    for (let i = 0; i < 3; i += 1) {
      const asked = await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' });
      expect(asked.statusCode, asked.body).toBe(201);
      expect((await call('POST', `/api/v1/vendor/account-change/${asked.json().data.id}/withdraw`, o)).statusCode).toBe(200);
    }
    const fourth = await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('BUSINESS_TYPE_DAILY_LIMIT');
  });

  it('naming numbers that can\'t be named counts too: after 5 tries a day, even a number that could be named gets the limit', async () => {
    const o = await companyStore();
    for (let i = 0; i < 5; i += 1) {
      const res = await nameNewHolder(o, { phone: `+5926${NUM}${80 + i}` });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('HANDOVER_PERSON_UNAVAILABLE');
    }
    const real = await person('Real', 'Person');
    const sixth = await nameNewHolder(o, real);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('HANDOVER_DAILY_LIMIT');
    // no number is ever written down for a try
    const tries = await system(() => app.prisma.auditLog.findMany({ where: { action: 'HANDOVER_NAME_REFUSED', userId: o.userId }, select: { changes: true } }));
    expect(tries).toHaveLength(5);
    expect(JSON.stringify(tries)).not.toContain(NUM);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [review-2475 delta] second fix round
// ---------------------------------------------------------------------------------------------------------------------

describe('[review-2475 delta D1] papers of an EARLIER business type never follow the old holder', () => {
  it('[P4] registered -> company -> handed over: the old business registration is withdrawn; a new store does not pass on it', async () => {
    const o = await person('Ravi', 'Persaud');
    const regPaper = await namedStore(o, 'OWNER', 'Persaud Trading');
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    await fileChangePapers(o.userId, asked);
    const name = (await store(o.vendorId)).name;
    expect((await admin('PUT', `/account-changes/${asked.id}/approve`, { sellerNames: { [o.vendorId]: name } })).statusCode).toBe(200);
    await handedOver(o);
    expect(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: regPaper }, select: { state: true } }))).toEqual({ state: 'REVOKED' });
    o.vendorId = '';
    await become(o, { name: `Brand New Shop ${RUN} ${seq}` });
    const evidence = await recordEvidenceFor(app.prisma, o.userId, ['owner_national_id', 'business_registration', 'storefront_photo'], new Date());
    // the person's own ID is theirs and stays; the handed-over business's registration does not
    expect(evidence.map((r) => r.docType)).toEqual(['owner_national_id']);
    await fileAndApprove(o.userId, ['storefront_photo']);
    expect(await service.isRoleVerified(o.userId, 'STORE', app.prisma, o.vendorId)).toBe(false);
  });

  it('own name -> company -> handed over: the own-name declaration is withdrawn too', async () => {
    const o = await ownNameStore();
    const declaration = await system(() => app.prisma.verificationDocument.findFirstOrThrow({ where: { userId: o.userId, docType: 'own_name_declaration' }, select: { id: true } }));
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    await fileChangePapers(o.userId, asked);
    const name = (await store(o.vendorId)).name;
    expect((await admin('PUT', `/account-changes/${asked.id}/approve`, { sellerNames: { [o.vendorId]: name } })).statusCode).toBe(200);
    await handedOver(o);
    expect(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: declaration.id }, select: { state: true } }))).toEqual({ state: 'REVOKED' });
    expect((await recordEvidenceFor(app.prisma, o.userId, ['own_name_declaration', 'owner_national_id'], new Date())).map((r) => r.docType)).toEqual(['owner_national_id']);
  });
});

describe('[review-2475 delta D2 · D4] the handover ends the old holder\'s card work, on the record, and tells the new holder', () => {
  it('their open "add a card" is cancelled (a Pay now is left to settle); the removal is in the fee history; the new holder is told to add their own card', async () => {
    const x = await companyStore();
    const sub = await system(async () => (await app.prisma.subscription.findFirst({ where: { vendorId: x.vendorId }, select: { id: true } }))
      ?? app.prisma.subscription.create({ data: {
        vendorId: x.vendorId, type: 'RETAIL_STORE', status: 'ACTIVE', weeklyRate: 1000, billingMethod: 'CARD',
        currentPeriodStart: new Date(Date.now() - 7 * DAY), currentPeriodEnd: new Date(Date.now() + DAY), nextBillingDate: new Date(Date.now() + DAY),
      }, select: { id: true } }));
    const card = await system(async () => app.prisma.paymentInstrument.create({ data: {
      subscriptionId: sub.id, userId: x.userId, provider: 'fakebank', environment: 'sandbox', providerAccount: `r2475d-${RUN}`,
      ...(await sealVaultToken(`tok_${nanoid(10)}`)), brand: 'VISA', last4: '4321', expMonth: 12, expYear: new Date().getUTCFullYear() + 3,
      consentVersion: 'card-on-file-v1', consentAt: new Date(),
    }, select: { id: true } }));
    const session = (purpose: 'ENROLL' | 'PAY_NOW') => system(() => app.prisma.cardSession.create({ data: {
      subscriptionId: sub.id, userId: x.userId, purpose, provider: 'fakebank', environment: 'sandbox', providerAccount: `r2475d-${RUN}`,
      stateHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 15 * 60_000),
      ...(purpose === 'ENROLL' ? { consentVersion: 'card-on-file-v1', consentAt: new Date() } : { amount: 1000, currencyCode: 'GYD', periodStart: new Date() }),
    }, select: { id: true } }));
    const enroll = await session('ENROLL');
    const payNow = await session('PAY_NOW');
    const { next } = await handedOver(x);
    const statusOf = (id: string) => system(() => app.prisma.cardSession.findUniqueOrThrow({ where: { id }, select: { status: true, failureCode: true } }));
    expect(await statusOf(enroll.id)).toEqual({ status: 'CANCELLED', failureCode: 'ACCOUNT_HANDED_OVER' });
    expect((await statusOf(payNow.id)).status).toBe('OPEN');
    const history = await system(() => app.prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: sub.id, idempotencyKey: `card:revoked:${card.id}` }, select: { type: true, note: true } }));
    expect(history.type).toBe('TIER_CHANGE');
    expect(history.note).toMatch(/ending 4321 removed: the account was handed over/);
    const notice = await system(() => app.prisma.notification.findFirstOrThrow({ where: { userId: next.userId, data: { path: ['kind'], equals: 'account_handover_completed' } }, select: { body: true } }));
    expect(notice.body).toContain('add your own card, or pay through the MMG checkout page');
    await system(() => app.prisma.cardSession.deleteMany({ where: { id: { in: [enroll.id, payNow.id] } } }));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// [review-2475 final] last round
// ---------------------------------------------------------------------------------------------------------------------

async function storeFee(vendorId: string, data: { billingMethod: 'CASH' | 'CARD' | 'MOBILE_MONEY'; mmgPayerMsisdn?: string | null }) {
  return system(async () => {
    const found = await app.prisma.subscription.findFirst({ where: { vendorId }, select: { id: true } });
    const sub = found ?? await app.prisma.subscription.create({ data: {
      vendorId, type: 'RETAIL_STORE', status: 'ACTIVE', weeklyRate: 1000, billingMethod: 'CASH',
      currentPeriodStart: new Date(Date.now() - 7 * DAY), currentPeriodEnd: new Date(Date.now() + DAY), nextBillingDate: new Date(Date.now() + DAY),
    }, select: { id: true } });
    await app.prisma.subscription.update({ where: { id: sub.id }, data: { billingMethod: data.billingMethod, mmgPayerMsisdn: data.mmgPayerMsisdn ?? null } });
    return sub;
  });
}
const phoneOf = async (userId: string) => (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } }))).phone;
const feeOf = (id: string) => system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id }, select: { billingMethod: true, mmgPayerMsisdn: true } }));

describe('[review-2475 final G1] the old holder\'s MMG number never stays on the store\'s weekly fee', () => {
  it('[P6] handed over: the fee goes back to a new fee\'s rail (CASH, no number), in its history; the new holder is told; nobody reads the old number', async () => {
    const x = await companyStore();
    const oldNumber = await phoneOf(x.userId);
    const sub = await storeFee(x.vendorId, { billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: oldNumber });
    const { next, changeId } = await handedOver(x);
    expect(await feeOf(sub.id)).toEqual({ billingMethod: 'CASH', mmgPayerMsisdn: null });
    const history = await system(() => app.prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: sub.id, idempotencyKey: `rail:handover:${changeId}:${sub.id}` }, select: { type: true, note: true } }));
    expect(history).toMatchObject({ type: 'TIER_CHANGE', note: expect.stringMatching(/previous holder's MMG number no longer pays the weekly fee; it is paid through the MMG checkout page/) });
    expect(JSON.stringify(history)).not.toContain(oldNumber);
    const notice = await system(() => app.prisma.notification.findFirstOrThrow({ where: { userId: next.userId, data: { path: ['kind'], equals: 'account_handover_completed' } }, select: { body: true } }));
    expect(notice.body).toContain('pay it through the MMG checkout page');
    const read = await call('GET', '/api/v1/vendor/subscription', { ...next, vendorId: x.vendorId, token: await session(next.userId, 'VENDOR_OWNER') });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().data).toMatchObject({ billingMethod: 'CASH', mmgPayerMsisdn: null });
    expect(read.body).not.toContain(oldNumber);
    expect((await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { entityId: changeId, action: 'APPROVE_ACCOUNT_HANDOVER' } }))).changes).toMatchObject({ feeRailsReset: 1 });
  });

  it('a card rail left with no card (the old holder\'s revoked) goes back to CASH too; a fee on CASH is left alone', async () => {
    const x = await companyStore();
    const sub = await storeFee(x.vendorId, { billingMethod: 'CARD' });
    await system(async () => app.prisma.paymentInstrument.create({ data: {
      subscriptionId: sub.id, userId: x.userId, provider: 'fakebank', environment: 'sandbox', providerAccount: `r2475f-${RUN}`,
      ...(await sealVaultToken(`tok_${nanoid(10)}`)), brand: 'VISA', last4: '9876', expMonth: 12, expYear: new Date().getUTCFullYear() + 3,
      consentVersion: 'card-on-file-v1', consentAt: new Date(),
    } }));
    const { changeId } = await handedOver(x);
    expect(await feeOf(sub.id)).toEqual({ billingMethod: 'CASH', mmgPayerMsisdn: null });
    expect((await system(() => app.prisma.billingEvent.findFirstOrThrow({ where: { idempotencyKey: `rail:handover:${changeId}:${sub.id}` } }))).note).toMatch(/previous holder's card/);
    const y = await companyStore();
    const cash = await storeFee(y.vendorId, { billingMethod: 'CASH' });
    const second = await handedOver(y);
    expect(await system(() => app.prisma.billingEvent.count({ where: { idempotencyKey: `rail:handover:${second.changeId}:${cash.id}` } }))).toBe(0);
  });

  it('GET /vendor/subscription shows an MMG payer number only to the person whose number it is; a plan on MMG resumes on its stored number', async () => {
    const o = await companyStore();
    // A resumed MMG plan records payer evidence, which is immutable: this synthetic account is left in the test database.
    users.splice(users.indexOf(o.userId), 1);
    const sub = await storeFee(o.vendorId, { billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: `+5926${NUM}77` });
    expect((await call('GET', '/api/v1/vendor/subscription', o)).json().data.mmgPayerMsisdn).toBeNull();
    const own = await phoneOf(o.userId);
    await system(() => app.prisma.subscription.update({ where: { id: sub.id }, data: { mmgPayerMsisdn: own } }));
    expect((await call('GET', '/api/v1/vendor/subscription', o)).json().data.mmgPayerMsisdn).toBe(own);
    // the app may send no number (it reads none it doesn't own): the plan keeps the number it has
    await system(() => app.prisma.subscription.update({ where: { id: sub.id }, data: { mmgPayerMsisdn: `+5926${NUM}77` } }));
    await grantStepUp(app, o.token);
    const resumed = await call('PUT', '/api/v1/vendor/subscription/billing-method', o, { method: 'MOBILE_MONEY' });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(await feeOf(sub.id)).toEqual({ billingMethod: 'MOBILE_MONEY', mmgPayerMsisdn: `+5926${NUM}77` });
  });
});

describe('[review-2475 final G2] the old holder\'s letters of authority end at the handover', () => {
  it('a letter still waiting to be signed is cancelled (link dead, keys cleared), audited with the reason', async () => {
    const x = await companyStore();
    const owner0 = await owner(x.userId);
    const letter = await system(() => app.prisma.authorityLetterRequest.create({ data: {
      userId: x.userId, vendorId: x.vendorId, docType: 'company_authority_letter', accountBasis: owner0.accountBasis,
      businessName: 'Synthetic Company Limited', registrationNumber: 'C-0000', requesterName: 'Kamla Persaud', requesterRole: 'Manager',
      signerName: 'Devon Director', signerPhone: `+5926${NUM}66`, letterText: 'Letter\nline', letterSha256: 'b'.repeat(64),
      tokenHash: Buffer.from(nanoid(32)).toString('hex'), linkExpiresAt: new Date(Date.now() + 72 * 3_600_000), lastSentAt: new Date(), codeHash: 'c'.repeat(64), signingKeyHash: 'd'.repeat(64),
    }, select: { id: true } }));
    const { changeId } = await handedOver(x);
    expect(await system(() => app.prisma.authorityLetterRequest.findUniqueOrThrow({ where: { id: letter.id }, select: { status: true, codeHash: true, signingKeyHash: true, endedAt: true } })))
      .toEqual({ status: 'CANCELLED', codeHash: null, signingKeyHash: null, endedAt: expect.any(Date) });
    const trail = await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { entity: 'AuthorityLetterRequest', entityId: letter.id, action: 'AUTHORITY_LETTER_CANCELLED' } }));
    expect(trail).toMatchObject({ userId: adminId, changes: { reason: 'account_handed_over', changeId } });
    expect((await system(() => app.prisma.auditLog.findFirstOrThrow({ where: { entityId: changeId, action: 'APPROVE_ACCOUNT_HANDOVER' } }))).changes).toMatchObject({ letterRequestsCancelled: 1 });
    await system(() => app.prisma.authorityLetterRequest.deleteMany({ where: { id: letter.id } }));
  });
});

describe('[review-2479 × #2475] a held legal name that is a person\'s by the time of the decision is never stamped', () => {
  it('a name held from the change\'s certificate, then given as the director\'s on a letter of authority: dropped at approval, the account names nobody by it', async () => {
    const o = await person('Ravi', 'Persaud');
    await namedStore(o, 'OWNER', 'Persaud Trading');
    const asked = (await call('POST', '/api/v1/vendor/account-change/business-type', o, { toOption: 'COMPANY' })).json().data;
    await fileChangePapers(o.userId, asked, { legalName: 'Devon Director' }); // no letter names Devon yet: held
    expect((await system(() => app.prisma.accountChangeRequest.findUniqueOrThrow({ where: { id: asked.id }, select: { sellerLegalName: true } }))).sellerLegalName).toBe('Devon Director');
    await system(() => app.prisma.authorityLetterRequest.create({ data: {
      userId: o.userId, vendorId: o.vendorId, docType: 'company_authority_letter', accountBasis: 'COMPANY',
      businessName: 'Synthetic Company Limited', registrationNumber: 'C-0001', requesterName: 'Ravi Persaud', requesterRole: 'Manager',
      signerName: 'Devon Director', signerPhone: `+5926${NUM}65`, letterText: 'Letter\nline', letterSha256: 'b'.repeat(64),
      tokenHash: Buffer.from(nanoid(32)).toString('hex'), linkExpiresAt: new Date(Date.now() + 72 * 3_600_000), lastSentAt: new Date(),
    } }));
    const name = (await store(o.vendorId)).name;
    expect((await admin('PUT', `/account-changes/${asked.id}/approve`, { sellerNames: { [o.vendorId]: name } })).statusCode).toBe(200);
    expect(await accountOf(o.userId)).toMatchObject({ accountBasis: 'COMPANY', sellerLegalName: null, sellerLegalNameDocId: null });
    expect(await sellerName(o)).toBe(name); // the store name the person confirmed, never the director's
    await system(() => app.prisma.authorityLetterRequest.deleteMany({ where: { userId: o.userId } }));
  });
});
