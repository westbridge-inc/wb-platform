/**
 * [COMPANY-DOCS · owner rulings 10 Nov 2026 ~07:0xZ, ~07:2xZ, ~07:3xZ] Who signs up a store decides its papers:
 *  - a registered COMPANY (e.g. KFC) gives NO owner's ID: its certificate of incorporation (or the company's business
 *    registration), the ID of the ONE person who manages the Swift account (National ID, Digital ID card or passport) and a
 *    director's letter of authority (or the director listing). One set for the whole account: branches upload nothing.
 *  - a registered business's MANAGER gives their own ID, the owner's letter of authority and the business registration.
 *  - the owner of a registered business, and a trader under their own name, keep today's papers (existing stores unchanged).
 * A person at Swift checks every one. The account holder's ID is stored and protected exactly like an owner's ID, the
 * face rules of #2454 are unchanged (a store's account holder never takes a selfie, so no face is ever compared), and it
 * never puts the account holder's name on the storefront.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { VerificationService, IDENTITY_FACE_MATCH_DOCS, identityFaceMatchApplies } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider, SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { approvedIdentityDocumentNumber, reviewerTypedFields } from '../modules/verification/identity-signal-policy';
import { DEFAULT_DOCUMENT_CHECKLISTS, PLATFORM_CONFIG_VERSION, desiredPlatformConfig } from '../modules/ops/platform-config';
import {
  ACCOUNT_HOLDER_ID_DOC_TYPE, BUCKET_OF, COMPANY_TIER, FIELD_CATALOGUE, IDENTITY_DOC_TYPES, IMAGE_POLICY_OF_BUCKET, MANAGER_TIER,
  NAME_CHECKED_DOC_TYPES, PERSON_ONLY_DOC_TYPES, REGISTRATION_DOC_TYPES, RETIRED_FIELDS, SELFIE_COMPARE_DOC_TYPES, seedDocRegistry, splitChecklistKey,
} from '../modules/verification/doc-registry';
import { docTypeName } from '../modules/verification/doc-names';
import { isPersonalDocType } from '../modules/verification/retention-rules';
import { reviewQueueRow } from '../modules/admin/review-queue-row';
import { compileActivationDisclosure } from '../modules/verification/storefront-disclosure';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { ownedVerificationFixture } from './helpers/verification-object';
import { grantStepUp } from './helpers/step-up';
import { wordFreeTag } from './helpers/fixture-ids';

const COMPANY_PAPERS = ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter'];
const STORE_TYPES = ['RESTAURANT', 'SUPERMARKET', 'STORE'] as const;

describe('[COMPANY-DOCS] the checklists per kind of sign-up', () => {
  it('a registered company never gives an owner’s ID: its three papers replace the owner’s ID and the registration, the type’s other papers stay', () => {
    for (const role of STORE_TYPES) {
      const standard = DEFAULT_DOCUMENT_CHECKLISTS[role]!;
      const company = DEFAULT_DOCUMENT_CHECKLISTS[`${role}_COMPANY`]!;
      expect(company, role).not.toContain('owner_national_id');
      expect(company.slice(0, 3), role).toEqual(COMPANY_PAPERS);
      expect(company.slice(3), role).toEqual(standard.filter((t) => t !== 'owner_national_id' && t !== 'business_registration'));
    }
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_COMPANY']).toContain('gra_restaurant_licence');
    // a service business that is a company: the same three, in place of the owner's ID
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_COMPANY']).toEqual(COMPANY_PAPERS);
  });

  it('a registered business’s manager gives their own ID and the owner’s letter, and keeps the business registration', () => {
    for (const role of STORE_TYPES) {
      const standard = DEFAULT_DOCUMENT_CHECKLISTS[role]!;
      const manager = DEFAULT_DOCUMENT_CHECKLISTS[`${role}_MANAGER`]!;
      expect(manager, role).not.toContain('owner_national_id');
      expect(manager, role).toEqual(['account_holder_id', 'owner_authority_letter', ...standard.filter((t) => t !== 'owner_national_id')]);
      expect(manager, role).toContain('business_registration');
    }
    // no manager path for a service business: no registration names its owner
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SERVICE_MANAGER']).toBeUndefined();
  });

  it('[review F1] a checklist change is a config change: 2026-11-10.1 carries the new lists into the next owner-signed seed', () => {
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-11-10.1');
    const desired = desiredPlatformConfig();
    expect(desired.version).toBe('2026-11-10.1');
    for (const c of desired.countries) {
      const lists = c.policy['documentChecklists'] as Record<string, string[]>;
      for (const key of ['RESTAURANT_COMPANY', 'SUPERMARKET_COMPANY', 'STORE_COMPANY', 'SERVICE_COMPANY', 'RESTAURANT_MANAGER', 'SUPERMARKET_MANAGER', 'STORE_MANAGER']) {
        expect(lists[key], `${c.code} ${key}`).toEqual(DEFAULT_DOCUMENT_CHECKLISTS[key]);
      }
    }
  });

  it('the registry reads the new lists as tiers of the same role', () => {
    expect(splitChecklistKey('RESTAURANT_COMPANY')).toEqual({ actorRole: 'RESTAURANT', tier: COMPANY_TIER, optional: false });
    expect(splitChecklistKey('STORE_MANAGER')).toEqual({ actorRole: 'STORE', tier: MANAGER_TIER, optional: false });
    expect(splitChecklistKey('SERVICE_COMPANY')).toEqual({ actorRole: 'SERVICE', tier: COMPANY_TIER, optional: false });
    expect(splitChecklistKey('STORE_OWN_NAME')).toEqual({ actorRole: 'STORE', tier: 'OWN_NAME', optional: false });
    expect(splitChecklistKey('STORE')).toEqual({ actorRole: 'STORE', tier: 'STANDARD', optional: false });
  });

  it('every new paper has a plain name, the same on the server and the phone (doc-names.test holds the lists equal)', () => {
    for (const t of [...COMPANY_PAPERS, 'owner_authority_letter']) expect(docTypeName(t), t).not.toMatch(/_|^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(docTypeName('account_holder_id')).toContain('passport');
    expect(docTypeName('certificate_of_incorporation')).toContain('Certificate of Incorporation');
  });
});

describe('[COMPANY-DOCS] the account holder’s ID is protected exactly like an owner’s ID', () => {
  it('same bucket (a person’s ID: purged after review), same fields, same retired fields', () => {
    expect(BUCKET_OF[ACCOUNT_HOLDER_ID_DOC_TYPE]).toBe(BUCKET_OF['owner_national_id']);
    expect(BUCKET_OF[ACCOUNT_HOLDER_ID_DOC_TYPE]).toBe('PERSONAL');
    expect(IMAGE_POLICY_OF_BUCKET[BUCKET_OF[ACCOUNT_HOLDER_ID_DOC_TYPE]!]).toBe('PURGE_AFTER_REVIEW');
    expect(FIELD_CATALOGUE[ACCOUNT_HOLDER_ID_DOC_TYPE]).toEqual(FIELD_CATALOGUE['owner_national_id']);
    expect(RETIRED_FIELDS[ACCOUNT_HOLDER_ID_DOC_TYPE]).toEqual(RETIRED_FIELDS['owner_national_id']);
  });

  it('same reviewer check (the number, blind-indexed for the duplicate-account check) and the same name check', () => {
    expect(reviewerTypedFields(ACCOUNT_HOLDER_ID_DOC_TYPE)).toEqual(reviewerTypedFields('owner_national_id'));
    expect(approvedIdentityDocumentNumber(ACCOUNT_HOLDER_ID_DOC_TYPE, 'APPROVED', 'P1234567')).toBe(approvedIdentityDocumentNumber('owner_national_id', 'APPROVED', 'P1234567'));
    expect(approvedIdentityDocumentNumber(ACCOUNT_HOLDER_ID_DOC_TYPE, 'PENDING', 'P1234567')).toBeNull();
    expect(NAME_CHECKED_DOC_TYPES).toContain(ACCOUNT_HOLDER_ID_DOC_TYPE);
  });

  it('the same face rules (#2454): compared by eye only for a selfie-taker, never a store’s account holder', () => {
    expect(SELFIE_COMPARE_DOC_TYPES.has(ACCOUNT_HOLDER_ID_DOC_TYPE)).toBe(SELFIE_COMPARE_DOC_TYPES.has('owner_national_id'));
    expect(IDENTITY_FACE_MATCH_DOCS.has(ACCOUNT_HOLDER_ID_DOC_TYPE)).toBe(IDENTITY_FACE_MATCH_DOCS.has('owner_national_id'));
  });

  it('but it is NOT a proprietor’s ID: it never makes “<name> trading as <store>” on a storefront', () => {
    expect(IDENTITY_DOC_TYPES).not.toContain(ACCOUNT_HOLDER_ID_DOC_TYPE);
  });

  it('a person checks every company and manager paper; the letters keep no field a name or signature could be copied into', () => {
    for (const t of [...COMPANY_PAPERS, 'owner_authority_letter']) expect(PERSON_ONLY_DOC_TYPES.has(t), t).toBe(true);
    expect(FIELD_CATALOGUE['company_authority_letter']).toEqual([]);
    expect(FIELD_CATALOGUE['owner_authority_letter']).toEqual([]);
    // the company's certificate is a registration: the reviewer says if it is a company's (never expires) or a business name
    expect(REGISTRATION_DOC_TYPES).toContain('certificate_of_incorporation');
    // [R3 · review F1] and types the legal name printed on it: the storefront names the seller by it
    expect(reviewerTypedFields('certificate_of_incorporation')).toEqual(['registrationKind', 'certificateYear', 'legalName']);
    expect((FIELD_CATALOGUE['certificate_of_incorporation'] ?? []).some((f) => f.fieldCode === 'proprietor_name')).toBe(false);
  });

  it('[REVIEW-M #2046 S4 pattern] the vendor_owners column is added under a 10 s lock timeout, existing accounts OWNER', () => {
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/20261110150000_vendor_account_basis/migration.sql'), 'utf8');
    const lock = sql.indexOf("SET lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(sql.indexOf('ALTER TABLE "vendor_owners"'));
    expect(sql).toContain(`NOT NULL DEFAULT 'OWNER'`);
  });
});

describe('[COMPANY-DOCS] the review queue says which path a store account signed up on', () => {
  it('sends OWNER, COMPANY or MANAGER beside the paper, and never the owner row itself', () => {
    const base = {
      id: 'd1', userId: 'u1', role: 'VENDOR_OWNER', docType: 'account_holder_id', status: 'PENDING', subjectId: null, createdAt: new Date(), expiresAt: null,
      consentAt: null, privacyNoticeVersion: 'v1', reviewedBy: null, approvalHeldAt: null, approvalHeldBy: null, previousDecision: null,
    };
    const row = reviewQueueRow({ ...base, user: { id: 'u1', firstName: 'A', lastName: 'B', phone: '+5926001234', countryCode: 'GY', driver: null, vendorOwner: { accountBasis: 'COMPANY' } } } as never);
    expect(row.accountBasis).toBe('COMPANY');
    expect(row.user).not.toHaveProperty('vendorOwner');
    expect(row.user?.phone).not.toBe('+5926001234');
    expect(row.reviewerTypes).toEqual(['documentNumber']);
    // [review] a manager's account says so too
    const manager = reviewQueueRow({ ...base, docType: 'owner_authority_letter', user: { id: 'u3', firstName: 'E', lastName: 'F', phone: '+5926001236', countryCode: 'GY', driver: null, vendorOwner: { accountBasis: 'MANAGER' } } } as never);
    expect(manager.accountBasis).toBe('MANAGER');
    expect(manager.reviewerTypes).toEqual([]);
    const rider = reviewQueueRow({ ...base, user: { id: 'u2', firstName: 'C', lastName: 'D', phone: '+5926001235', countryCode: 'GY', driver: null, vendorOwner: null } } as never);
    expect(rider.accountBasis).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Against the database: sign-up, the checklist the server gives, storage, and branches.
// ---------------------------------------------------------------------------------------------------------------------
const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'company-signup-documents-test');
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
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: `+5927${NUM}00`, firstName: 'Company', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  adminId = admin.id; users.push(admin.id);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    const vendors = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: users } } }, select: { id: true } })).map((v) => v.id);
    const subs = await app.prisma.subscription.findMany({ where: { vendorId: { in: vendors } }, select: { id: true } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendors } } });
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: users } } });
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.documentRecord.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
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

/** A signed-in account with no store yet (the sign-up creates it). */
async function person(firstName = 'Asha', lastName = 'Ramdin') {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+5927${NUM}${String(seq).padStart(2, '0')}`, firstName, lastName, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `co-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token, vendorId: '' };
}
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, o: { token: string; vendorId?: string }, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, ...(o.vendorId ? { 'x-vendor-id': o.vendorId } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const business = (over: Record<string, unknown> = {}) => ({
  name: `Chicken Co ${RUN} ${seq}`, vendorType: 'RESTAURANT', phone: '+5926000000', addressLine1: '1 Company Road', city: 'Georgetown',
  region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, ...over,
});
async function become(o: { userId: string; token: string; vendorId: string }, over: Record<string, unknown> = {}) {
  const vendorType = String(over['vendorType'] ?? 'RESTAURANT');
  const quote = await signupQuote(app.prisma, o.userId, { role: 'VENDOR', vendorType });
  const res = await call('POST', '/api/v1/partner/become', o, {
    role: 'VENDOR', acceptAgreement: true, weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode }, business: business(over),
  });
  if (res.statusCode < 300) {
    o.vendorId = (await system(() => app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: o.userId } }, select: { id: true } }))).id;
    // the sign-up's role switch issues a new session role; the test keeps its own token for the owner
    o.token = app.jwt.sign({ userId: o.userId, role: 'VENDOR_OWNER', jti: nanoid(8) });
    await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: o.userId, token: o.token, refreshToken: nanoid(24), deviceId: `co-owner-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  }
  return res;
}
const statusOf = async (o: { token: string; vendorId: string }, role = 'RESTAURANT') => (await call('GET', `/api/v1/verification/status?role=${role}`, o)).json().data;
const basisOf = async (userId: string) => (await system(() => app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId } }))).accountBasis;
const statusOfDoc = async (id: string) => (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id }, select: { status: true } }))).status;
async function approveAll(o: { userId: string }, role: 'RESTAURANT' | 'STORE', docTypes: string[]) {
  for (const docType of docTypes) {
    const doc = await service.submitDocument(o.userId, role, docType, await ownedVerificationFixture(app.prisma, o.userId, `co-${docType}`), 'v1');
    const typed = docType === 'account_holder_id' || docType === 'owner_national_id' ? { documentNumber: `ID${NUM}${seq}` }
      : docType === 'certificate_of_incorporation' ? { registrationKind: 'COMPANY' as const }
      : docType === 'business_registration' ? { registrationKind: 'BUSINESS_NAME' as const, certificateYear: new Date().getUTCFullYear() }
      : docType === 'gra_restaurant_licence' ? { certificateYear: new Date().getUTCFullYear() } : {};
    await service.approveDocument(doc.id, adminId, undefined, undefined, typed);
  }
}

describe('[COMPANY-DOCS] sign-up: the choice drives the server checklist', () => {
  it('“We’re a registered company”: the account is a company’s and its checklist asks for no owner’s ID', async () => {
    const o = await person();
    const res = await become(o, { accountBasis: 'COMPANY' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await basisOf(o.userId)).toBe('COMPANY');
    const status = await statusOf(o);
    expect(status.checklist).toEqual(['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'gra_restaurant_licence', 'storefront_photo', 'food_handler_attestation']);
    expect(status.checklist).not.toContain('owner_national_id');
    expect(status.accountBasis).toBe('COMPANY');
    expect(status.nameBasis).toBe('REGISTERED');
    // a company is never offered the own-name route, and the route refuses it
    expect(Object.values(status.ownNameFits ?? {})).not.toContain(true);
    const own = await call('POST', '/api/v1/vendor/onboarding/own-name', o, { accept: true, attestationVersion: 'v1' });
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe('ACCOUNT_BASIS_OWN_NAME');
  });

  it('“I’m the manager, not the owner”: the manager’s ID and the owner’s letter, with the business registration', async () => {
    const o = await person();
    expect((await become(o, { vendorType: 'STORE', accountBasis: 'MANAGER' })).statusCode).toBeLessThan(300);
    expect(await basisOf(o.userId)).toBe('MANAGER');
    expect((await statusOf(o, 'STORE')).checklist).toEqual(['account_holder_id', 'owner_authority_letter', 'business_registration', 'storefront_photo']);
    // [review] only the owner trades under their own name: the route refuses a manager's account too
    const own = await call('POST', '/api/v1/vendor/onboarding/own-name', o, { accept: true, attestationVersion: 'v1' });
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe('ACCOUNT_BASIS_OWN_NAME');
    expect(Object.values((await statusOf(o, 'STORE')).ownNameFits ?? {})).not.toContain(true);
  });

  it('an older app that sends no choice signs up the owner, exactly as before (existing stores unchanged)', async () => {
    const o = await person();
    expect((await become(o, { vendorType: 'STORE' })).statusCode).toBeLessThan(300);
    expect(await basisOf(o.userId)).toBe('OWNER');
    const status = await statusOf(o, 'STORE');
    expect(status.checklist).toEqual(['owner_national_id', 'business_registration', 'storefront_photo']);
    expect(status.accountBasis).toBe('OWNER');
  });

  it('refuses what does not fit: a company or manager trading under an own name; a manager of a service business', async () => {
    const a = await person('Ramesh', 'Persaud');
    const own = await become(a, { name: 'R. Persaud', vendorType: 'STORE', nameBasis: 'OWN_NAME', accountBasis: 'COMPANY' });
    expect(own.statusCode).toBe(400);
    expect(own.json().error.code).toBe('ACCOUNT_BASIS_OWN_NAME');
    const service = await become(a, { vendorType: 'SERVICE', accountBasis: 'MANAGER' });
    expect(service.statusCode).toBe(400);
    expect(service.json().error.code).toBe('ACCOUNT_BASIS_NOT_APPLICABLE');
    // nothing was created by either refusal
    expect(await system(() => app.prisma.vendorOwner.count({ where: { userId: a.userId } }))).toBe(0);
    // a service business that is a company: its three papers, no owner's ID
    const b = await person();
    expect((await become(b, { vendorType: 'SERVICE', accountBasis: 'COMPANY' })).statusCode).toBeLessThan(300);
    expect((await statusOf(b, 'SERVICE')).checklist).toEqual(COMPANY_PAPERS);
  });
});

describe('[COMPANY-DOCS] storage and the person-checks-it rule', () => {
  it('the account holder’s ID is filed encrypted, as a person’s ID, and waits for a person even when an engine would approve it', async () => {
    const o = await person();
    expect((await become(o, { accountBasis: 'COMPANY' })).statusCode).toBeLessThan(300);
    const auto = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    for (const docType of [...COMPANY_PAPERS]) {
      const fileUrl = await ownedVerificationFixture(app.prisma, o.userId, `auto-approve-${docType}`);
      const doc = await auto.submitDocument(o.userId, 'RESTAURANT', docType, fileUrl, 'v1');
      expect(doc, docType).toMatchObject({ status: 'PENDING', reviewedBy: null });
    }
    // the image goes after review, as an owner's ID does (retention reads the bucket); every upload is encrypted the
    // same way whatever its type (POST /verification/upload takes no type)
    expect(isPersonalDocType(ACCOUNT_HOLDER_ID_DOC_TYPE)).toBe(true);
    expect(isPersonalDocType(ACCOUNT_HOLDER_ID_DOC_TYPE)).toBe(isPersonalDocType('owner_national_id'));
    const row = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: 'GY.account_holder_id' } }));
    const owners = await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code: 'GY.owner_national_id' } }));
    expect({ bucket: row.bucket, imagePolicy: row.imagePolicy, persistRetentionDays: row.persistRetentionDays, subjectKind: row.subjectKind })
      .toEqual({ bucket: owners.bucket, imagePolicy: owners.imagePolicy, persistRetentionDays: owners.persistRetentionDays, subjectKind: owners.subjectKind });
    for (const code of ['GY.certificate_of_incorporation', 'GY.company_authority_letter', 'GY.owner_authority_letter']) {
      expect((await system(() => app.prisma.docType.findUniqueOrThrow({ where: { code } }))).alwaysReview, code).toBe(true);
    }
  });

  it('a store’s account holder is never face-matched: no selfie is asked of them (#2454)', async () => {
    const o = await person();
    expect((await become(o, { accountBasis: 'COMPANY' })).statusCode).toBeLessThan(300);
    expect(await identityFaceMatchApplies(app.prisma, ACCOUNT_HOLDER_ID_DOC_TYPE, 'RESTAURANT', o.userId, { FEATURE_BIOMETRIC_FACE_MATCH: '1' })).toBe(false);
  });
});

describe('[COMPANY-DOCS · review F3] a company’s business-name registration counts only when its proprietor is a company', () => {
  it('approving it as a business name needs the reviewer’s word that the proprietor is a company; a company certificate never does', async () => {
    const o = await person();
    expect((await become(o, { accountBasis: 'COMPANY' })).statusCode).toBeLessThan(300);
    const file = async (tag: string) => service.submitDocument(o.userId, 'RESTAURANT', 'certificate_of_incorporation', await ownedVerificationFixture(app.prisma, o.userId, `co-cert-${tag}`), 'v1');
    const year = new Date().getUTCFullYear();
    const named = await file('bn');
    await expect(service.approveDocument(named.id, adminId, undefined, undefined, { registrationKind: 'BUSINESS_NAME', certificateYear: year }))
      .rejects.toMatchObject({ code: 'PROPRIETOR_NOT_A_COMPANY' });
    await expect(service.approveDocument(named.id, adminId, undefined, undefined, { registrationKind: 'BUSINESS_NAME', certificateYear: year, proprietorIsCompany: false }))
      .rejects.toMatchObject({ code: 'PROPRIETOR_NOT_A_COMPANY' });
    const approved = await service.approveDocument(named.id, adminId, undefined, undefined, { registrationKind: 'BUSINESS_NAME', certificateYear: year, proprietorIsCompany: true });
    expect(approved.status).toBe('APPROVED');
    // an owner's own business registration is unchanged: no such word is asked of it
    const owner = await person();
    expect((await become(owner, { vendorType: 'STORE' })).statusCode).toBeLessThan(300);
    const reg = await service.submitDocument(owner.userId, 'STORE', 'business_registration', await ownedVerificationFixture(app.prisma, owner.userId, 'own-bn'), 'v1');
    expect((await service.approveDocument(reg.id, adminId, undefined, undefined, { registrationKind: 'BUSINESS_NAME', certificateYear: year })).status).toBe('APPROVED');
  });
});

// [R3 · CAA s.70(1) · owner ruling 10 Nov 2026 · review F1] A company's certificate is a registration paper: the person
// approving it types the company's legal name printed on it, and the storefront names the seller by that name — never
// the account holder (a person), never the store's trading name unchecked.
describe('[R3 · review F1] a company’s certificate names the company as the seller, never its account holder', () => {
  it('the person approving the certificate must type the legal name; the store is then sold by it', async () => {
    const o = await person('Synthetic', 'Accountholder');
    expect((await become(o, { accountBasis: 'COMPANY' })).statusCode).toBeLessThan(300);
    await approveAll(o, 'RESTAURANT', ['account_holder_id']);
    const cert = await service.submitDocument(o.userId, 'RESTAURANT', 'certificate_of_incorporation', await ownedVerificationFixture(app.prisma, o.userId, 'co-cert-legal'), 'v1');
    const blockOf = () => system(() => compileActivationDisclosure(app.prisma, o.vendorId, { accountId: o.userId, tenantId: 'swift-default' }));
    // the console's contract: not without the name printed on it
    await expect(system(() => service.approveDocument(cert.id, adminId, undefined, undefined, { required: true, registrationKind: 'COMPANY' })))
      .rejects.toMatchObject({ code: 'LEGAL_NAME_REQUIRED' });
    expect(await statusOfDoc(cert.id)).toBe('PENDING');
    await system(() => service.approveDocument(cert.id, adminId, undefined, undefined, { required: true, registrationKind: 'COMPANY', legalName: 'Sample Holdings Limited' }));
    const block = await blockOf();
    expect(block.legalName).toEqual({ value: 'Sample Holdings Limited', source: 'REGISTRATION', docType: 'certificate_of_incorporation', recordId: expect.any(String) });
    expect(block.pendingPersonCheck).toEqual([]);
    // the account holder is a person: never named as the seller of a company
    expect(JSON.stringify(block.legalName)).not.toMatch(/Synthetic|Accountholder/);
  });
});

describe('[COMPANY-DOCS] one set of papers for the whole account: branches upload nothing', () => {
  it('a company’s branch rides the company’s checked papers, and cannot sign up any other way', async () => {
    const o = await person();
    expect((await become(o, { accountBasis: 'COMPANY' })).statusCode).toBeLessThan(300);
    await approveAll(o, 'RESTAURANT', ['certificate_of_incorporation', 'account_holder_id', 'company_authority_letter', 'gra_restaurant_licence', 'storefront_photo']);
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { status: 'ACTIVE', isVerified: true, acceptingOrders: true } }));
    await grantStepUp(app, o.token);
    const quote = await signupQuote(app.prisma, o.userId, { role: 'VENDOR', vendorType: 'RESTAURANT' });
    const ack = { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode };
    const add = (over: Record<string, unknown>) => call('POST', '/api/v1/vendor/stores', o, { publicPhone: '+5926007788', business: business({ name: `Chicken Co North ${RUN} ${wordFreeTag(6)}`, ...over }), weeklyFeeAck: ack });
    // a branch never changes how the account signed up
    const other = await add({ accountBasis: 'OWNER' });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('ACCOUNT_BASIS_FIXED');
    const branch = await add({});
    expect(branch.statusCode, branch.body).toBe(201);
    const branchId = branch.json().data.id as string;
    const gate = await service.activationChecklist(o.userId, 'RESTAURANT', { vendorId: branchId });
    expect(gate.checklist.slice(0, 3)).toEqual(COMPANY_PAPERS);
    expect(gate.checklist).not.toContain('owner_national_id');
    // the branch's papers are the company's, already checked: nothing is missing for it
    expect(gate.items.filter((i) => i.state !== 'APPROVED').map((i) => i.docType)).toEqual([]);
    expect(gate.complete).toBe(true);
    expect(await system(() => app.prisma.verificationDocument.count({ where: { userId: o.userId } }))).toBe(5);
  });
});
