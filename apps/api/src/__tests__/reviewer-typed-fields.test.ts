/**
 * [VERIFY-DOCS] REVIEWERS TYPE WHAT THE KEPT RECORD NEEDS, AT APPROVAL.
 *
 * Owner ruling, 6 Oct 2026 (21:25 GYT): "Reviewers TYPE at approval: the police
 * clearance issue date (yearly re-check) + the ID/licence number (stored as a
 * blind index, only for duplicate-account checks)"; coordinator ruling the same
 * evening: "a licence-number duplicate signal comes from the typed licence
 * number".
 *
 * With manual review (staging and production run KYC_PROVIDER=manual) nothing
 * is extracted, so before this change:
 *   - an approved national ID left no identity number at all — the duplicate
 *     account (trial-abuse) check never saw one, and motorised movers may now
 *     give a licence instead of an ID (PR-V1), which no check ever read;
 *   - a police clearance carries an ISSUE date, not a printed expiry, and the
 *     reviewer was asked for an expiry the document does not print.
 *
 * Now the approval asks for exactly what the document type needs:
 *   - national ID / owner's ID / passport: the number → a HARD
 *     ID_DOC_NUMBER identity key (an HMAC blind index; the number itself is
 *     stored nowhere);
 *   - driver's licence: the licence number → the same key type, in its own
 *     namespace (a licence number never matches an ID number);
 *   - police clearance: the issue date → kept on the document's record, and
 *     the re-check falls due one year after it.
 * The queue tells the console which of these each document needs.
 *
 * A CUSTOMER's ID (identity_l2) is asked for nothing: rule of 11 Oct 2026
 * (coordinator, under the owner's delegation), "no ID-number duplicate check
 * at launch (collects less data; revisit after launch)". A number sent anyway
 * is dropped unread.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { createHmac, randomBytes } from 'node:crypto';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { clusterMemberIds } from '../modules/integrity/identity.service';
import { isPersonsFullName, splitFullName } from '../modules/verification/verification.service';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Typed-field review ${RUN}: checked against the document`;
// The same salt the identity service uses outside production (normalize.ts).
const blind = (normalized: string) => createHmac('sha256', process.env['IDENTITY_SALT'] || 'dev-identity-salt').update(normalized).digest('hex');

let app: FastifyInstance;
let adminToken = '';
let adminId = '';
const users: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'reviewer-typed-fields-test');

type Role = 'MOVER' | 'VENDOR_OWNER' | 'CUSTOMER';
async function subject(role: Role = 'MOVER') {
  seq += 1;
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+59278${NUM}${String(seq).padStart(2, '0')}`, firstName: `Tf${RUN}`, lastName: `S${seq}`,
    roles: [role] as never[], activeRole: role as never, status: 'ACTIVE', isPhoneVerified: true, countryCode: 'GY',
    ...(role === 'CUSTOMER' ? { trustLevel: 'L1' as const } : {}),
  } }));
  users.push(u.id);
  return u.id;
}
async function pending(userId: string, docType: string, role: Role = 'MOVER') {
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role, docType, fileUrl: '', status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
}
const approve = (docId: string, payload: Record<string, unknown>) => app.inject({
  method: 'PUT', url: `/api/v1/admin/verification/${docId}/approve`, payload,
  headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
const statusOf = async (id: string) =>
  (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }))).status;
const keysOf = (accountId: string) =>
  system(() => app.prisma.identityKey.findMany({ where: { accountId }, select: { type: true, valueHash: true, source: true } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const a = await system(() => app.prisma.user.create({ data: {
    phone: `+59278${NUM}99`, firstName: 'Tf', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
    status: 'ACTIVE', isPhoneVerified: true,
    // `documents.review`: the explicit document reviewer grant (PR-V3); harmless where it is not yet demanded.
    admin: { create: { permissions: ['*', 'documents.review'] } },
  } }));
  users.push(a.id);
  adminId = a.id;
  adminToken = app.jwt.sign({ userId: a.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: a.id, token: adminToken, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `tf-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
});

afterAll(async () => {
  await system(async () => {
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } }).catch(() => {});
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.documentRecord.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } }).catch(() => {});
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } }).catch(() => {});
    await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: users } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[typed fields] the ID or licence number', () => {
  it('a national ID is not approved until the reviewer types its number', async () => {
    const doc = await pending(await subject(), 'national_id');
    const res = await approve(doc.id, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DOCUMENT_NUMBER_REQUIRED');
    expect(await statusOf(doc.id)).toBe('PENDING');
  });

  it('the typed number becomes a HARD identity key as a blind index only — the number is stored and echoed nowhere', async () => {
    const who = await subject();
    const doc = await pending(who, 'national_id');
    const typed = `${NUM}-${RUN.slice(0, 3)}-77`;
    const res = await approve(doc.id, { documentNumber: typed });
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(doc.id)).toBe('APPROVED');
    const normalized = typed.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    expect(await keysOf(who)).toContainEqual({ type: 'ID_DOC_NUMBER', valueHash: blind(normalized), source: 'REVIEWER_TYPED' });
    expect(res.body).not.toContain(typed);
    expect(res.body).not.toContain(normalized);
    const stored = JSON.stringify(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })));
    expect(stored).not.toContain(normalized);
    const audits = JSON.stringify(await system(() => app.prisma.auditLog.findMany({ where: { entityId: doc.id } })));
    expect(audits).not.toContain(normalized);
    expect(audits).not.toContain(typed);
  });

  it('two accounts presenting the same ID number become one identity (the trial-abuse check sees it)', async () => {
    const first = await subject();
    const second = await subject('VENDOR_OWNER');
    const number = `9${NUM}${RUN.slice(0, 2)}1`;
    expect((await approve((await pending(first, 'national_id')).id, { documentNumber: number })).statusCode).toBe(200);
    expect((await approve((await pending(second, 'owner_national_id', 'VENDOR_OWNER')).id, { documentNumber: ` ${number.slice(0, 3)} ${number.slice(3)} ` })).statusCode).toBe(200);
    const members = await system(() => clusterMemberIds(app.prisma, first));
    expect(members.sort()).toEqual([first, second].sort());
  });

  it('a driver’s licence needs its licence number; two accounts with one licence are one identity; a licence never matches an ID number', async () => {
    const first = await subject();
    const second = await subject();
    const third = await subject();
    const number = `L${NUM}${RUN.slice(0, 3)}`;
    const missing = await approve((await pending(first, 'drivers_licence')).id, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('DOCUMENT_NUMBER_REQUIRED');
    const expiresAt = new Date(Date.now() + 400 * DAY).toISOString();
    expect((await approve((await pending(first, 'drivers_licence')).id, { documentNumber: number, expiresAt })).statusCode).toBe(200);
    expect((await approve((await pending(second, 'drivers_licence')).id, { documentNumber: number.toLowerCase(), expiresAt })).statusCode).toBe(200);
    expect((await system(() => clusterMemberIds(app.prisma, first))).sort()).toEqual([first, second].sort());
    // the same characters typed from a national ID belong to another number space
    expect((await approve((await pending(third, 'national_id')).id, { documentNumber: number })).statusCode).toBe(200);
    expect(await system(() => clusterMemberIds(app.prisma, third))).not.toContain(first);
  });

  it('a number too short to identify anyone is refused', async () => {
    const doc = await pending(await subject(), 'national_id');
    const res = await approve(doc.id, { documentNumber: '1-2' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DOCUMENT_NUMBER_INVALID');
    expect(await statusOf(doc.id)).toBe('PENDING');
  });
});

describe('[typed fields] the police clearance issue date', () => {
  it('is required, kept on the record, and sets the re-check one year after issue', async () => {
    const who = await subject();
    const missing = await approve((await pending(who, 'police_clearance')).id, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('ISSUE_DATE_REQUIRED');
    const doc = await pending(who, 'police_clearance');
    const issuedOn = new Date(Date.now() - 60 * DAY);
    issuedOn.setUTCHours(0, 0, 0, 0);
    const res = await approve(doc.id, { issuedOn: issuedOn.toISOString().slice(0, 10) });
    expect(res.statusCode, res.body).toBe(200);
    const row = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }));
    expect(row.expiresAt?.toISOString()).toBe(new Date(issuedOn.getTime() + 365 * DAY).toISOString());
    const record = await system(() => app.prisma.documentRecord.findUniqueOrThrow({ where: { submissionId: doc.id } }));
    expect(record.issuedOn?.toISOString()).toBe(issuedOn.toISOString());
    expect(record.expiresOn?.toISOString()).toBe(row.expiresAt?.toISOString());
  });

  it('a clearance issued more than a year ago, or dated in the future, is refused', async () => {
    const who = await subject();
    const old = await approve((await pending(who, 'police_clearance')).id, { issuedOn: new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10) });
    expect(old.statusCode).toBe(400);
    expect(old.json().error.code).toBe('CLEARANCE_TOO_OLD');
    const future = await approve((await pending(who, 'police_clearance')).id, { issuedOn: new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10) });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe('ISSUE_DATE_IN_FUTURE');
  });
});

describe('[typed fields] a business registration says what it is (R16)', () => {
  it('an empty body is refused with REGISTRATION_KIND_REQUIRED; a company also needs the legal name printed on it [R3 · review F1]', async () => {
    const doc = await pending(await subject('VENDOR_OWNER'), 'business_registration', 'VENDOR_OWNER');
    const empty = await approve(doc.id, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('REGISTRATION_KIND_REQUIRED');
    expect(await statusOf(doc.id)).toBe('PENDING');
    // the storefront names the seller by the legal name typed from this paper: it must be typed
    const unnamed = await approve(doc.id, { registrationKind: 'COMPANY' });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json().error.code).toBe('LEGAL_NAME_REQUIRED');
    expect(await statusOf(doc.id)).toBe('PENDING');
    expect((await approve(doc.id, { registrationKind: 'COMPANY', legalName: 'Fixture Registered Name Ltd' })).statusCode).toBe(200);
    expect(await statusOf(doc.id)).toBe('APPROVED');
  });

  it('the queue tells the console what each document needs typed', async () => {
    const who = await subject();
    const id = await pending(who, 'national_id');
    const pc = await pending(who, 'police_clearance');
    const lic = await pending(who, 'drivers_licence');
    // the queue is oldest-first and shared with every other suite: page until ours are seen
    const rows: Array<{ id: string; reviewerTypes: string[] }> = [];
    for (let page = 1; page <= 200; page += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/admin/verification/queue?status=PENDING&limit=50&page=${page}`,
        headers: { authorization: `Bearer ${adminToken}` } });
      expect(res.statusCode).toBe(200);
      const batch = res.json().data as Array<{ id: string; reviewerTypes: string[] }>;
      rows.push(...batch);
      if (batch.length < 50 || [id.id, pc.id, lic.id].every((want) => rows.some((r) => r.id === want))) break;
    }
    expect(rows.find((r) => r.id === id.id)?.reviewerTypes).toEqual(['documentNumber']);
    expect(rows.find((r) => r.id === pc.id)?.reviewerTypes).toEqual(['issuedOn']);
    expect(rows.find((r) => r.id === lic.id)?.reviewerTypes).toEqual(['documentNumber']);
  });
});

// [R3 · owner ruling 10 Nov 2026 · review-2476 F1/F2] The legal name typed from a registration paper names the seller of
// every branch of the account. It is on the trail (who, when, which account and paper, what it replaced), and it is the
// business's or company's name: never the account holder's own name for a company's or a manager's account.
describe('[R3 · review-2476] the seller legal name typed at approval', () => {
  const thisYear = new Date(Date.now() - 4 * 3_600_000).getUTCFullYear(); // Guyana's year (UTC-4)
  async function account(basis: 'OWNER' | 'COMPANY' | 'MANAGER', firstName: string, lastName: string) {
    const id = await subject('VENDOR_OWNER');
    await system(() => app.prisma.user.update({ where: { id }, data: { firstName, lastName } }));
    await system(() => app.prisma.vendorOwner.create({ data: { userId: id, accountBasis: basis } }));
    return id;
  }
  const sellerOf = (userId: string) => system(() => app.prisma.vendorOwner.findUniqueOrThrow({ where: { userId }, select: { id: true, sellerLegalName: true, sellerLegalNameDocId: true } }));
  const trailOf = (vendorOwnerId: string) => system(() => app.prisma.auditLog.findMany({ where: { action: 'SET_SELLER_LEGAL_NAME', entityId: vendorOwnerId }, select: { userId: true, entity: true, changes: true, createdAt: true } }));

  it('[F1] the trail says who set it, when, for which account and paper, and what customers saw before', async () => {
    const who = await account('COMPANY', 'Synthetic', `Holder${RUN}`);
    const first = await pending(who, 'certificate_of_incorporation', 'VENDOR_OWNER');
    const before = Date.now();
    const res = await approve(first.id, { registrationKind: 'COMPANY', legalName: '  Sample Holdings Limited  ' });
    expect(res.statusCode, res.body).toBe(200);
    const owner = await sellerOf(who);
    expect(owner).toMatchObject({ sellerLegalName: 'Sample Holdings Limited', sellerLegalNameDocId: first.id });
    const one = await trailOf(owner.id);
    expect(one.map(({ userId, entity, changes }) => ({ userId, entity, changes }))).toEqual([{ userId: adminId, entity: 'VendorOwner', changes: {
      accountId: who, documentId: first.id, docType: 'certificate_of_incorporation', from: null, fromDocumentId: null, to: 'Sample Holdings Limited',
    } }]);
    expect(one[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    // a later paper replaces it: the trail keeps what customers saw before, and from which paper
    const second = await pending(who, 'certificate_of_incorporation', 'VENDOR_OWNER');
    expect((await approve(second.id, { registrationKind: 'COMPANY', legalName: 'Sample Holdings (Guyana) Limited' })).statusCode).toBe(200);
    const both = await trailOf(owner.id);
    expect(both.find((t) => (t.changes as Record<string, unknown>)['documentId'] === second.id)).toMatchObject({ userId: adminId, changes: {
      accountId: who, documentId: second.id, docType: 'certificate_of_incorporation', from: 'Sample Holdings Limited', fromDocumentId: first.id, to: 'Sample Holdings (Guyana) Limited',
    } });
    expect(both).toHaveLength(2);
    // the decision's own row is unchanged, and nothing personal rides on either
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'APPROVE_VERIFICATION_DOC', entityId: { in: [first.id, second.id] } } }))).toBe(2);
    expect(JSON.stringify(both)).not.toMatch(/Synthetic|Holder/);
  });

  it.each([
    ['COMPANY', 'certificate_of_incorporation', { registrationKind: 'COMPANY' }],
    ['MANAGER', 'business_registration', { registrationKind: 'BUSINESS_NAME', certificateYear: thisYear }],
  ] as const)('[F2] a %s account: the account holder\'s own name is refused (first+last or last+first, any case or spacing)', async (basis, docType, kind) => {
    const who = await account(basis, 'Synthetic', `Holder${RUN}`);
    const doc = await pending(who, docType, 'VENDOR_OWNER');
    for (const typed of [`Synthetic Holder${RUN}`, `  holder${RUN.toLowerCase()}   SYNTHETIC `, `SyntheticHolder${RUN}`]) {
      const res = await approve(doc.id, { ...kind, legalName: typed });
      expect(res.statusCode, typed).toBe(400);
      expect(res.json().error.code).toBe('LEGAL_NAME_IS_A_PERSON');
    }
    expect(await statusOf(doc.id)).toBe('PENDING');
    expect(await sellerOf(who)).toMatchObject({ sellerLegalName: null, sellerLegalNameDocId: null });
    expect(await trailOf((await sellerOf(who)).id)).toEqual([]);
    // the business's own registered name is accepted
    expect((await approve(doc.id, { ...kind, legalName: 'Sample Holdings Limited' })).statusCode).toBe(200);
    expect(await sellerOf(who)).toMatchObject({ sellerLegalName: 'Sample Holdings Limited', sellerLegalNameDocId: doc.id });
  });

  // [COORD ruling under the owner's 10 Nov rule · review-2476 delta A] The store card names the business. A trader under
  // their own name goes through the own-name declaration, never a registration paper: so an OWNER account is refused too,
  // whatever kind of registration the paper is.
  it('[F2 · delta A] an OWNER account: the owner\'s own name is refused on a business name registration and on a company\'s certificate', async () => {
    const who = await account('OWNER', 'Synthetic', `Trader${RUN}`);
    const doc = await pending(who, 'business_registration', 'VENDOR_OWNER');
    const asCompany = await approve(doc.id, { registrationKind: 'COMPANY', legalName: `trader${RUN} synthetic` });
    expect(asCompany.statusCode).toBe(400);
    expect(asCompany.json().error.code).toBe('LEGAL_NAME_IS_A_PERSON');
    const asBusinessName = await approve(doc.id, { registrationKind: 'BUSINESS_NAME', certificateYear: thisYear, legalName: `Synthetic Trader${RUN}` });
    expect(asBusinessName.statusCode).toBe(400);
    expect(asBusinessName.json().error.code).toBe('LEGAL_NAME_IS_A_PERSON');
    expect(await statusOf(doc.id)).toBe('PENDING');
    expect(await sellerOf(who)).toMatchObject({ sellerLegalName: null, sellerLegalNameDocId: null });
    // the business's registered name is accepted
    expect((await approve(doc.id, { registrationKind: 'BUSINESS_NAME', certificateYear: thisYear, legalName: `Trader${RUN} Hardware` })).statusCode).toBe(200);
    expect(await sellerOf(who)).toMatchObject({ sellerLegalName: `Trader${RUN} Hardware`, sellerLegalNameDocId: doc.id });
  });

  // [review-2476 delta B] Honest copying errors from a proprietor line still name the person: the name's words are compared
  // (accents folded, apostrophes and hyphens ignored, commas and full stops as word breaks), in any order, with the
  // middle names on record and initials allowed, as long as the first name (or its initial) and the last name are there.
  it('[F2 · delta B] the holder\'s name is refused word by word: accents, order, commas, initials, middle names, apostrophes and hyphens', async () => {
    const who = await account('COMPANY', 'José Antonio', `O’Brien-Holder${RUN}`);
    const doc = await pending(who, 'certificate_of_incorporation', 'VENDOR_OWNER');
    for (const typed of [
      `Jose O'Brien-Holder${RUN}`,
      `O’Brien-Holder${RUN}, José`,
      `J. A. OBrien Holder${RUN}`,
      `José Antonio O'Brien-Holder${RUN}`,
      `ANTONIO O’BRIEN-HOLDER${RUN}`,
    ]) {
      const res = await approve(doc.id, { registrationKind: 'COMPANY', legalName: typed });
      expect(res.statusCode, typed).toBe(400);
      expect(res.json().error.code, typed).toBe('LEGAL_NAME_IS_A_PERSON');
    }
    expect(await statusOf(doc.id)).toBe('PENDING');
    expect((await approve(doc.id, { registrationKind: 'COMPANY', legalName: `O'Brien-Holder${RUN} Trading Limited` })).statusCode).toBe(200);
  });

  it('[delta B] the word rule, case by case: a person\'s name with or without middle names and initials; never a business name', () => {
    const person = { firstName: 'Mary Ann', lastName: 'Persaud-Singh' };
    for (const typed of ['Mary Ann Persaud-Singh', 'persaud singh, mary', 'M. A. Persaud Singh', 'Ann PersaudSingh', 'Máry Persaud–Singh', 'MaryAnnPersaud-Singh', 'Persaud-Singh Mary Ann'])
      expect(isPersonsFullName(typed, person), typed).toBe(true);
    for (const typed of ['Persaud-Singh', 'Persaud-Singh Holdings Limited', 'Mary Ann’s Bakery', 'Persaud-Singh & Sons', 'Mary Ann', 'Sample Holdings Limited'])
      expect(isPersonsFullName(typed, person), typed).toBe(false);
    expect(isPersonsFullName('Anyone', { firstName: null, lastName: null })).toBe(false);
  });

  // [review-2476 delta B] A company's director (or a business's owner) who signed its letter of authority in Swift is a
  // person the server knows by name: the legal name may not be theirs either.
  it('[F2 · delta B] the name of the person who signed the account\'s letter of authority is refused too', async () => {
    const who = await account('COMPANY', 'Synthetic', `Holder${RUN}`);
    const now = new Date();
    const hex = () => randomBytes(32).toString('hex');
    await system(() => app.prisma.authorityLetterRequest.create({ data: {
      userId: who, vendorId: `fixture-vendor-${RUN}`, docType: 'company_authority_letter', accountBasis: 'COMPANY',
      businessName: 'Sample Holdings Limited', registrationNumber: `C-${RUN}`, requesterName: `Synthetic Holder${RUN}`, requesterRole: 'Manager',
      signerName: `Dana Director${RUN}`, signerPhone: `+59278${NUM}88`, letterText: 'Synthetic letter text', letterSha256: hex(), tokenHash: hex(),
      status: 'SIGNED', linkExpiresAt: new Date(now.getTime() + 3 * DAY), lastSentAt: now, codeVerifiedAt: now, signedAt: now,
      signatureSha256: hex(), documentId: `fixture-letter-${RUN}`, pdfFileKey: `fixture/${RUN}.pdf`,
    } }));
    const doc = await pending(who, 'certificate_of_incorporation', 'VENDOR_OWNER');
    for (const typed of [`Dana Director${RUN}`, `director${RUN}, DANA`, `D. Director${RUN}`]) {
      const res = await approve(doc.id, { registrationKind: 'COMPANY', legalName: typed });
      expect(res.statusCode, typed).toBe(400);
      expect(res.json().error.code, typed).toBe('LEGAL_NAME_IS_A_PERSON');
      // [review-2479 F1] a letter counts whatever its status, so the words never claim it was signed
      expect(res.json().error.message, typed).toMatch(/named in its letter of authority/);
    }
    expect(await statusOf(doc.id)).toBe('PENDING');
    expect((await approve(doc.id, { registrationKind: 'COMPANY', legalName: 'Sample Holdings Limited' })).statusCode).toBe(200);
  });

  // [review-2479 F1] The signer's name is free text the holder types. A company's name typed there by mistake (then
  // cancelled) is not a person: it must never block that company's own legal name.
  it('[review-2479 F1] a cancelled letter whose signer field holds the company\'s name never refuses that name', async () => {
    const who = await account('COMPANY', 'Synthetic', `Mistyped${RUN}`);
    const now = new Date();
    const hex = () => randomBytes(32).toString('hex');
    const companyName = `Sample${RUN} Holdings Limited`;
    await system(() => app.prisma.authorityLetterRequest.create({ data: {
      userId: who, vendorId: `fixture-vendor-c-${RUN}`, docType: 'company_authority_letter', accountBasis: 'COMPANY',
      businessName: companyName, registrationNumber: `C2-${RUN}`, requesterName: `Synthetic Mistyped${RUN}`, requesterRole: 'Manager',
      signerName: companyName, signerPhone: `+59278${NUM}87`, letterText: 'Synthetic letter text', letterSha256: hex(), tokenHash: hex(),
      status: 'CANCELLED', linkExpiresAt: new Date(now.getTime() + 3 * DAY), lastSentAt: now, endedAt: now,
    } }));
    const doc = await pending(who, 'certificate_of_incorporation', 'VENDOR_OWNER');
    const res = await approve(doc.id, { registrationKind: 'COMPANY', legalName: companyName });
    expect(res.statusCode, res.body).toBe(200);
    expect(await sellerOf(who)).toMatchObject({ sellerLegalName: companyName, sellerLegalNameDocId: doc.id });
  });

  it('[review-2479 F1] a recorded name with a company word is never a person\'s name', () => {
    for (const name of ['Sample Holdings Limited', 'Sample Holdings Inc.', 'Persaud Trading Ltd', 'Persaud & Co', 'Persaud Company', 'Persaud Corp', 'Persaud Corporation', 'Persaud LLC', 'Persaud Incorporated'])
      expect(isPersonsFullName(name, splitFullName(name)), name).toBe(false);
  });

  it('[review-2479 F2] initials stand for first and middle names only, never a part of the last name', () => {
    const mary = { firstName: 'Mary', lastName: 'Persaud' };
    expect(isPersonsFullName('M & P Persaud', mary)).toBe(false);
    expect(isPersonsFullName('M and P Persaud', mary)).toBe(false);
    expect(isPersonsFullName('M. Persaud', mary)).toBe(true);
    expect(isPersonsFullName('M & P Persaud', { firstName: 'Mary Paula', lastName: 'Persaud' })).toBe(true);
  });

  it('[review-2479 F3] a title before the name is ignored', () => {
    const ravi = { firstName: 'Ravi', lastName: 'Persaud' };
    for (const typed of ['Mrs Ravi Persaud', 'Mr. R. Persaud', 'Dr Ravi Persaud', 'Ms. Ravi Persaud', 'Miss Ravi Persaud', 'Prof. Ravi Persaud', 'Rev Ravi Persaud', 'Sir Ravi Persaud', 'Hon. Ravi Persaud', 'Mx Ravi Persaud'])
      expect(isPersonsFullName(typed, ravi), typed).toBe(true);
    expect(isPersonsFullName('Ravi Persaud', splitFullName('Dr. Ravi Persaud'))).toBe(true);
    expect(isPersonsFullName('Mr', ravi)).toBe(false);
  });

  it('[review-2479 F4] a generational suffix never stands for the last name', () => {
    expect(splitFullName('John Smith Jr.')).toEqual({ firstName: 'John', lastName: 'Smith' });
    expect(splitFullName('John Smith III')).toEqual({ firstName: 'John', lastName: 'Smith' });
    for (const signer of ['John Smith Jr.', 'John Smith Sr', 'John Smith II', 'John Smith III', 'John Smith IV'])
      expect(isPersonsFullName('John Smith', splitFullName(signer)), signer).toBe(true);
    expect(isPersonsFullName('John Smith Jr', { firstName: 'John', lastName: 'Smith' })).toBe(true);
    expect(isPersonsFullName('John Smith', { firstName: 'John', lastName: 'Smith Jr.' })).toBe(true);
  });
});

describe('[typed fields] a customer’s ID is never asked for its number (rule 11 Oct 2026: no ID-number duplicate check at launch)', () => {
  const user = (id: string) => system(() => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { trustLevel: true } }));

  // [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 (b) — a DELIBERATE change] Swift keeps no customer ID: one still waiting
  // is never approved (it is withdrawn and deleted by the daily sweep), so nothing is typed and nobody reaches L2.
  it('a waiting customer ID is not approved any more, with or without anything typed', async () => {
    const who = await subject('CUSTOMER');
    const doc = await pending(who, 'identity_l2', 'CUSTOMER');
    const res = await approve(doc.id, {});
    expect(res.statusCode, res.body).toBe(410);
    expect(res.json().error.code).toBe('CUSTOMER_ID_RETIRED');
    expect(await statusOf(doc.id)).toBe('PENDING');
    expect(await user(who)).toEqual({ trustLevel: 'L1' });
    expect((await keysOf(who)).filter((k) => k.type === 'ID_DOC_NUMBER')).toEqual([]);
  });

  it('a number sent anyway is dropped: no identity key, no link to an account that holds the same number, stored nowhere', async () => {
    const number = `C${NUM}${RUN.slice(0, 3)}9`;
    const normalized = number.toUpperCase();
    // A partner whose national ID carries the same number (that one IS a signal).
    const partner = await subject();
    expect((await approve((await pending(partner, 'national_id')).id, { documentNumber: number })).statusCode).toBe(200);
    expect(await keysOf(partner)).toContainEqual({ type: 'ID_DOC_NUMBER', valueHash: blind(normalized), source: 'REVIEWER_TYPED' });

    const who = await subject('CUSTOMER');
    const doc = await pending(who, 'identity_l2', 'CUSTOMER');
    const res = await approve(doc.id, { documentNumber: number });
    expect(res.statusCode, res.body).toBe(410); // [CHECKLIST-LEGAL] never approved now; the number is still dropped
    expect(await user(who)).toEqual({ trustLevel: 'L1' });
    expect((await keysOf(who)).filter((k) => k.type === 'ID_DOC_NUMBER')).toEqual([]);
    expect(await system(() => clusterMemberIds(app.prisma, who))).not.toContain(partner);
    expect(await system(() => clusterMemberIds(app.prisma, partner))).not.toContain(who);
    expect(res.body).not.toContain(normalized);
    const stored = JSON.stringify(await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })));
    expect(stored).not.toContain(normalized);
    const audits = JSON.stringify(await system(() => app.prisma.auditLog.findMany({ where: { entityId: doc.id } })));
    expect(audits).not.toContain(normalized);
  });

  it('the queue asks nothing typed for a customer ID — and still asks for a partner’s ID and licence numbers', async () => {
    const customer = await pending(await subject('CUSTOMER'), 'identity_l2', 'CUSTOMER');
    const who = await subject();
    const id = await pending(who, 'national_id');
    const lic = await pending(who, 'drivers_licence');
    // The customer lane is asked for on purpose; the operator lane is the default view.
    const lane = async (role: 'customer' | 'operator', wanted: string[]) => {
      const rows: Array<{ id: string; reviewerTypes: string[] }> = [];
      for (let page = 1; page <= 200; page += 1) {
        const res = await app.inject({ method: 'GET', url: `/api/v1/admin/verification/queue?status=PENDING&role=${role}&limit=50&page=${page}`,
          headers: { authorization: `Bearer ${adminToken}` } });
        expect(res.statusCode).toBe(200);
        const batch = res.json().data as Array<{ id: string; reviewerTypes: string[] }>;
        rows.push(...batch);
        if (batch.length < 50 || wanted.every((want) => rows.some((r) => r.id === want))) break;
      }
      return rows;
    };
    const customers = await lane('customer', [customer.id]);
    const operators = await lane('operator', [id.id, lic.id]);
    expect(customers.find((r) => r.id === customer.id)?.reviewerTypes).toEqual([]);
    expect(operators.find((r) => r.id === id.id)?.reviewerTypes).toEqual(['documentNumber']);
    expect(operators.find((r) => r.id === lic.id)?.reviewerTypes).toEqual(['documentNumber']);
  });
});
