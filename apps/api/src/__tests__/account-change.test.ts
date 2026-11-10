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
      : docType === 'own_name_declaration' ? { ownNameConfirmed: true as const } : {};

async function file(userId: string, docType: string, role: 'STORE' | 'RESTAURANT' = 'STORE') {
  return service.submitDocument(userId, role, docType, await ownedVerificationFixture(app.prisma, userId, `ac-${docType}`), 'v1');
}
async function approve(docId: string, docType: string) {
  return service.approveDocument(docId, adminId, undefined, undefined, typedFor(docType));
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
  it('a person approves with a reason; the company papers count, the own-name ones no longer gate, the company name is shown', async () => {
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
    expect(await store(o.vendorId)).toMatchObject({
      status: 'ACTIVE', isVerified: true, acceptingOrders: true, tradesUnderOwnName: false, sellerNameCheckedName: name, sellerNameCheckedById: adminId,
    });
    const status = (await call('GET', '/api/v1/verification/status?role=STORE', o)).json().data;
    expect(status.checklist).toEqual(['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'storefront_photo']);
    expect(status.accountBasis).toBe('COMPANY');
    expect(await service.isRoleVerified(o.userId, 'STORE', app.prisma, o.vendorId)).toBe(true);
    // the seller is the business now, never the owner's own name
    expect(await sellerName(o)).toBe(name);
    const audit = await system(() => app.prisma.auditLog.findFirst({ where: { entityId: changeId, action: 'APPROVE_BUSINESS_TYPE_CHANGE' } }));
    expect(audit?.userId).toBe(adminId);
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
