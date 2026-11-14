/**
 * [DOC-1 §8.4 · P8-4] test_support_cannot_read_documents — DOC-INV-19.
 *
 * The review console's roles are capability presets an admin grant is made
 * from, and the server honours the narrowing. SUPPORT reads counts and never
 * a document, a case's fields, a name or a phone; DOC_REVIEWER reads the
 * queue, renders (logged), decides and claims — but places no hold and
 * administers no registry; DOC_SENIOR adds the clearance outcome; DOC_ADMIN
 * holds everything under verification.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import {
  ADMIN_CAPABILITIES, ADMIN_ROUTE_AUTHORITY, REVIEW_CONSOLE_PRESETS,
  DOC_REVIEWER_CAPABILITIES, DOC_SENIOR_CAPABILITIES, DOC_ADMIN_CAPABILITIES, SUPPORT_OPERATOR_CAPABILITIES, holdsCapability,
} from '../modules/admin/admin-authority';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { ownedVerificationFixture } from './helpers/verification-object';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const REASON = `Reviewed against the registry ${RUN}; legible and current`;
/** Capabilities a preset may declare AHEAD of a route (the clearance outcome route is not built yet) — pinned so a typo cannot hide here. */
const DECLARED_AHEAD = ['verification.clearance.read'];

let app: FastifyInstance;
const users: string[] = [];
let subjectId = '';
let subjectPhone = '';
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-review-rbac-test');

async function admin(permissions: readonly string[]) {
  seq += 1;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59280${NUM}${seq}`, firstName: 'Rbac', lastName: `Admin${seq}`, roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: [...permissions] } },
  } }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `rbac-${RUN}-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { id: u.id, token };
}
const call = (token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) => app.inject({
  method, url: `/api/v1/admin${url}`, ...(payload !== undefined ? { payload } : {}),
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
});
async function pendingDoc() {
  return runWithTenant('swift-default', () => app.prisma.verificationDocument.create({ data: {
    userId: subjectId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: '', status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
  } }));
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  subjectPhone = `+59280${NUM}0`;
  const s = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: subjectPhone, firstName: `Zelda${RUN}`, lastName: 'Subject', activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true } }));
  subjectId = s.id; users.push(subjectId);
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.updateMany({ where: { userId: subjectId }, data: { legalHoldId: null } });
    await app.prisma.docLegalHold.deleteMany({ where: { subjectUserId: subjectId } });
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: subjectId }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: subjectId } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P8-4] the review console roles, as capability presets the server honours', () => {
  it('the presets are made only of capabilities a route registers (or is declared ahead), and the §8.4 table holds: SUPPORT counts only; reviewer no holds; DOC_ADMIN everything under verification', () => {
    for (const [name, caps] of Object.entries(REVIEW_CONSOLE_PRESETS)) {
      for (const cap of caps) {
        if (cap.endsWith('.*')) continue;
        expect(ADMIN_CAPABILITIES.includes(cap) || DECLARED_AHEAD.includes(cap), `${name} names ${cap}, which no route registers`).toBe(true);
      }
    }
    const forbiddenForSupport = ['verification.read', 'verification.document.read', 'verification.decide', 'verification.hold', 'verification.hold.read', 'verification.case.claim'];
    for (const cap of forbiddenForSupport) expect(holdsCapability(SUPPORT_OPERATOR_CAPABILITIES, cap), `SUPPORT must not hold ${cap}`).toBe(false);
    expect(holdsCapability(SUPPORT_OPERATOR_CAPABILITIES, 'verification.counts')).toBe(true);
    for (const cap of ['verification.hold', 'verification.hold.read', 'verification.clearance.read']) expect(holdsCapability(DOC_REVIEWER_CAPABILITIES, cap), `a reviewer must not hold ${cap}`).toBe(false);
    for (const cap of ['verification.read', 'verification.document.read', 'verification.decide', 'verification.case.claim']) expect(holdsCapability(DOC_REVIEWER_CAPABILITIES, cap)).toBe(true);
    expect(holdsCapability(DOC_SENIOR_CAPABILITIES, 'verification.clearance.read')).toBe(true);
    expect(holdsCapability(DOC_SENIOR_CAPABILITIES, 'verification.hold')).toBe(false);
    for (const cap of ['verification.read', 'verification.hold', 'verification.hold.read', 'verification.decide', 'verification.clearance.read', 'verification.counts']) expect(holdsCapability(DOC_ADMIN_CAPABILITIES, cap)).toBe(true);
    expect(ADMIN_ROUTE_AUTHORITY['GET /verification/queue/counts']).toMatchObject({ cls: 'C0', capability: 'verification.counts' });
  });

  it('test_support_cannot_read_documents: SUPPORT is refused the queue, a render, a decision, a hold and a claim — and gets counts that carry no one’s name, phone or file', async () => {
    const doc = await pendingDoc();
    const support = await admin(SUPPORT_OPERATOR_CAPABILITIES);
    expect((await call(support.token, 'GET', '/verification/queue?status=PENDING')).statusCode).toBe(403);
    expect((await call(support.token, 'GET', `/verification/${doc.id}/document-url`)).statusCode).toBe(403);
    expect((await call(support.token, 'PUT', `/verification/${doc.id}/approve`, {})).statusCode).toBe(403);
    expect((await call(support.token, 'PUT', `/verification/${doc.id}/reject`, { reason: REASON, reasonCode: 'UNREADABLE' })).statusCode).toBe(403);
    expect((await call(support.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() })).statusCode).toBe(403);
    expect((await call(support.token, 'GET', '/verification/legal-holds')).statusCode).toBe(403);
    const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
    expect((await call(support.token, 'POST', `/verification/cases/${kase.id}/claim`, {})).statusCode).toBe(403);
    const counts = await call(support.token, 'GET', '/verification/queue/counts');
    expect(counts.statusCode).toBe(200);
    expect(counts.json().data.byStatus.PENDING).toBeGreaterThanOrEqual(1);
    expect(counts.json().data.openCases).toBeGreaterThanOrEqual(1);
    const text = counts.body;
    expect(text).not.toContain(`Zelda${RUN}`);
    expect(text).not.toContain(subjectPhone);
    expect(text).not.toMatch(/fileUrl|firstName|phone|docType|userId/);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('PENDING');
  });

  it('DOC_REVIEWER reads the queue with the person on it, renders (past the guard), claims and decides — but may neither place nor list a hold', async () => {
    const doc = await pendingDoc();
    const kase = await system(() => app.prisma.reviewCase.create({ data: { submissionId: doc.id, slaDueAt: new Date(Date.now() + DAY) } }));
    // [VERIFY-DOCS V3] The preset ALONE no longer opens or decides a document:
    // that takes the explicit document reviewer grant, which no preset, prefix
    // or `*` confers. Granted beside the preset, the reviewer's work is as before.
    const presetOnly = await admin(DOC_REVIEWER_CAPABILITIES);
    const refusedOpen = await call(presetOnly.token, 'GET', `/verification/${doc.id}/document-url`);
    expect(refusedOpen.statusCode).toBe(403);
    expect(refusedOpen.json().error.code).toBe('DOCUMENT_REVIEWER_REQUIRED');
    expect((await call(presetOnly.token, 'PUT', `/verification/${doc.id}/approve`, {})).statusCode).toBe(403);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('PENDING');
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const queue = await call(reviewer.token, 'GET', '/verification/queue?status=PENDING');
    expect(queue.statusCode).toBe(200);
    expect(queue.body).toContain(`Zelda${RUN}`);
    expect((await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`)).statusCode).not.toBe(403);
    expect((await call(reviewer.token, 'POST', `/verification/cases/${kase.id}/claim`, {})).statusCode).toBe(200);
    expect((await call(reviewer.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() })).statusCode).toBe(403);
    expect((await call(reviewer.token, 'GET', '/verification/legal-holds')).statusCode).toBe(403);
    const approved = await call(reviewer.token, 'PUT', `/verification/${doc.id}/approve`, { registrationKind: 'COMPANY', legalName: 'Fixture Registered Name Ltd' }); // [R16]
    expect(approved.statusCode).toBe(200);
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('APPROVED');
  });

  it('DOC_ADMIN places and lists holds; the counts endpoint answers every preset that holds verification.counts', async () => {
    await pendingDoc();
    const docAdmin = await admin(DOC_ADMIN_CAPABILITIES);
    const placed = await call(docAdmin.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() });
    expect(placed.statusCode).toBe(201);
    expect((await call(docAdmin.token, 'GET', '/verification/legal-holds')).statusCode).toBe(200);
    expect((await call(docAdmin.token, 'GET', '/verification/queue/counts')).statusCode).toBe(200);
    const senior = await admin(DOC_SENIOR_CAPABILITIES);
    expect((await call(senior.token, 'GET', '/verification/queue/counts')).statusCode).toBe(200);
    expect((await call(senior.token, 'POST', '/verification/legal-holds', { subjectUserId: subjectId, reviewBy: new Date(Date.now() + 30 * DAY).toISOString() })).statusCode).toBe(403);
  });
});

// [Item 98] Face-matching is off at launch (row 54), so the reviewer compares
// the applicant's own signup selfie with the identity document by eye. The
// selfie travels only with an audited, granted document view of an identity
// document, and only when the stored pointer is the applicant's own capture.
describe('[Item 98] the signup selfie accompanies a granted identity-document view', () => {
  async function identityDoc() {
    return system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'VENDOR_OWNER', docType: 'owner_national_id', fileUrl, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
  }

  it('supplies the applicant-owned captured selfie with an identity document, audited once with the view', async () => {
    const capturedAt = new Date('2026-10-07T00:00:00.000Z');
    // [OWNER-ASKS 9 Nov 2026] shown for a person who takes the selfie (here a rider who also owns a store)
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, selfieCapturedAt: capturedAt } }));
    const doc = await identityDoc();
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const viewed = await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`);
    expect(viewed.statusCode, viewed.body).toBe(200);
    expect(viewed.json().data.signupSelfie).toEqual({ url: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, capturedAt: capturedAt.toISOString() });
    expect(viewed.json().data.signupSelfieExpected).toBe(true);
    const audits = await system(() => app.prisma.auditLog.findMany({ where: { userId: reviewer.id, action: 'VIEW_VERIFICATION_DOC', entityId: doc.id } }));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.changes).toMatchObject({ signupSelfieShown: true });
    // Without the grant nothing is shown — not the document, not the selfie.
    const presetOnly = await admin(DOC_REVIEWER_CAPABILITIES);
    const refused = await call(presetOnly.token, 'GET', `/verification/${doc.id}/document-url`);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain('avatars');
  });

  it('never substitutes a pointer outside the applicant\'s own selfie folder, an uncaptured photo, or a non-identity document', async () => {
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const doc = await identityDoc();
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: '/uploads/avatars/someone-else/synthetic.jpg', selfieCapturedAt: new Date() } }));
    expect((await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`)).json().data.signupSelfie).toBeNull();
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { avatar: `/uploads/avatars/${subjectId}/../someone-else/x.jpg`, selfieCapturedAt: new Date() } }));
    expect((await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`)).json().data.signupSelfie).toBeNull();
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { avatar: `/uploads/avatars/${subjectId}/..`, selfieCapturedAt: new Date() } }));
    expect((await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`)).json().data.signupSelfie).toBeNull();
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { avatar: `/uploads/avatars/${subjectId}/synthetic.jpg`, selfieCapturedAt: null } }));
    expect((await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`)).json().data.signupSelfie).toBeNull();
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { selfieCapturedAt: new Date() } }));
    const business = await system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
    expect((await call(reviewer.token, 'GET', `/verification/${business.id}/document-url`)).json().data.signupSelfie).toBeNull();
  });

  // [Owner ruling 13 Oct 2026, row 30] The selfie goes beside WHICHEVER photo ID was sent: a national ID, a
  // passport or a driver's licence (a motorised mover's licence is their photo ID). A vehicle paper is not one.
  it('a passport or a driver\'s licence carries the selfie too; a vehicle paper does not', async () => {
    const capturedAt = new Date('2026-10-08T00:00:00.000Z');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, selfieCapturedAt: capturedAt } }));
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const docOf = (docType: string) => system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'MOVER', docType, fileUrl, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
    for (const docType of ['passport', 'drivers_licence', 'national_id']) {
      const viewed = await call(reviewer.token, 'GET', `/verification/${(await docOf(docType)).id}/document-url`);
      expect(viewed.statusCode, viewed.body).toBe(200);
      expect(viewed.json().data.signupSelfie, docType).toEqual({ url: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, capturedAt: capturedAt.toISOString() });
    }
    const paper = await call(reviewer.token, 'GET', `/verification/${(await docOf('vehicle_registration')).id}/document-url`);
    expect(paper.statusCode, paper.body).toBe(200);
    expect(paper.json().data.signupSelfie).toBeNull();
    expect(paper.json().data.signupSelfieExpected).toBe(false);
  });

  // [OWNER-ASKS · owner ruling 9 Nov 2026] A store owner (and store staff, and an in-shop business) takes no selfie: the
  // reviewer checks the ID alone. A photo an owner took before stays stored and protected as it was — it is simply not
  // put beside the ID, and the console is told the ID is the whole review (`signupSelfieExpected: false`).
  it('[owner 9 Nov] a store owner is reviewed on the ID alone, even with an older selfie on file', async () => {
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER'], avatar: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, selfieCapturedAt: new Date('2026-10-09T00:00:00.000Z') } }));
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const doc = await identityDoc();
    const viewed = await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`);
    expect(viewed.statusCode, viewed.body).toBe(200);
    expect(viewed.json().data.url).toBeTruthy();
    expect(viewed.json().data.signupSelfie).toBeNull();
    expect(viewed.json().data.signupSelfieExpected).toBe(false);
    expect(viewed.body).not.toContain('avatars');
    const audits = await system(() => app.prisma.auditLog.findMany({ where: { userId: reviewer.id, action: 'VIEW_VERIFICATION_DOC', entityId: doc.id } }));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.changes).toMatchObject({ signupSelfieShown: false });
    // The stored photo is untouched.
    const kept = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: subjectId }, select: { avatar: true, selfieCapturedAt: true } }));
    expect(kept.avatar).toBe(`/uploads/avatars/${subjectId}/synthetic-selfie.jpg`);
    expect(kept.selfieCapturedAt).not.toBeNull();
  });

  it('[owner 9 Nov] a rider with no selfie on file: the console is told one is expected', async () => {
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: null, selfieCapturedAt: null } }));
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const doc = await identityDoc();
    const viewed = await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`);
    expect(viewed.statusCode, viewed.body).toBe(200);
    expect(viewed.json().data.signupSelfie).toBeNull();
    expect(viewed.json().data.signupSelfieExpected).toBe(true);
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER'] } }));
  });
});

// [OWNER-ASKS · security review 9 Nov 2026] A selfie taken after the ID was approved is compared with that ID by a PERSON
// before home visits book: the reviewer's decision door, with the reviewer grant and a stated reason, records which
// selfie (by its capture time) was compared with which approved ID.
describe('[security review 9 Nov] a person compares the selfie with the approved ID', () => {
  async function approvedId() {
    return system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'MOVER', docType: 'national_id', fileUrl, status: 'APPROVED', state: 'COMMITTED', reviewedAt: new Date(), reviewedBy: 'synthetic-reviewer', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
  }

  it('the reviewer records a match for THIS selfie; the record names the ID and the capture', async () => {
    const capturedAt = new Date('2026-11-09T10:00:00.000Z');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, selfieCapturedAt: capturedAt } }));
    const doc = await approvedId();
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const queue = await call(reviewer.token, 'GET', '/verification/selfie-checks');
    expect(queue.statusCode, queue.body).toBe(200);
    const res = await call(reviewer.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true, selfieCapturedAt: capturedAt.toISOString() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ documentId: doc.id, selfieCapturedAt: capturedAt.toISOString(), outcome: 'MATCH' });
    const rows = await system(() => app.prisma.auditLog.findMany({ where: { action: 'SELFIE_ID_COMPARED', entityId: subjectId } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(reviewer.id);
    expect(rows[0]!.changes).toMatchObject({ documentId: doc.id, selfieCapturedAt: capturedAt.toISOString(), avatar: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, outcome: 'MATCH' });
  });

  // [security review 9 Nov, 2nd] The decision binds to the selfie the reviewer was SHOWN: a retake between the view and
  // the answer is refused, and nothing is recorded for the unseen face.
  it('the owner retakes the selfie between the reviewer’s view and the answer: refused 409, no MATCH recorded', async () => {
    const shown = new Date('2026-11-09T11:00:00.000Z');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, selfieCapturedAt: shown } }));
    const doc = await approvedId();
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const viewed = await call(reviewer.token, 'GET', `/verification/${doc.id}/document-url`);
    expect(viewed.json().data.signupSelfie.capturedAt).toBe(shown.toISOString());
    // the retake lands after the view
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { avatar: `/uploads/avatars/${subjectId}/synthetic-retake.jpg`, selfieCapturedAt: new Date('2026-11-09T11:05:00.000Z') } }));
    const before = await system(() => app.prisma.auditLog.count({ where: { action: 'SELFIE_ID_COMPARED', entityId: subjectId } }));
    const res = await call(reviewer.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true, selfieCapturedAt: shown.toISOString() });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SELFIE_CHANGED');
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'SELFIE_ID_COMPARED', entityId: subjectId } }))).toBe(before);
    // and a decision that names no shown selfie is refused outright
    expect((await call(reviewer.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true })).statusCode).toBe(400);
  });

  it('without the reviewer grant: refused, nothing recorded', async () => {
    const doc = await approvedId();
    const presetOnly = await admin(DOC_REVIEWER_CAPABILITIES);
    const before = await system(() => app.prisma.auditLog.count({ where: { action: 'SELFIE_ID_COMPARED', entityId: subjectId } }));
    expect((await call(presetOnly.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true, selfieCapturedAt: new Date().toISOString() })).statusCode).toBe(403);
    expect((await call(presetOnly.token, 'GET', '/verification/selfie-checks')).statusCode).toBe(403);
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'SELFIE_ID_COMPARED', entityId: subjectId } }))).toBe(before);
  });

  it('a person who takes no selfie (a store owner), a document that is not an approved photo ID, or no selfie on file: refused', async () => {
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const doc = await approvedId();
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER'], avatar: `/uploads/avatars/${subjectId}/synthetic-selfie.jpg`, selfieCapturedAt: new Date() } }));
    const storeOnly = await call(reviewer.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true, selfieCapturedAt: new Date().toISOString() });
    expect(storeOnly.statusCode, storeOnly.body).toBe(409);
    expect(storeOnly.json().error.code).toBe('SELFIE_NOT_TAKEN_BY_THIS_PERSON');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], selfieCapturedAt: null } }));
    expect((await call(reviewer.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true, selfieCapturedAt: new Date().toISOString() })).json().error.code).toBe('NO_SELFIE_ON_FILE');
    const pending = await system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'MOVER', docType: 'national_id', fileUrl, status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
    expect((await call(reviewer.token, 'POST', `/verification/${pending.id}/selfie-check`, { match: true, selfieCapturedAt: new Date().toISOString() })).json().error.code).toBe('NOT_AN_APPROVED_PHOTO_ID');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER'] } }));
  });
});

// [review F3/F6 · 9 Nov 2026] A "no match" stands against its own author; another reviewer's match is an override; the
// stated reason is inside the decision record.
describe('[review] a standing "no match", and the reason in the record', () => {
  it('reviewer A says no match (reason recorded); A cannot then say match; B can, recorded as an override', async () => {
    const shown = new Date('2026-11-09T12:00:00.000Z');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: `/uploads/avatars/${subjectId}/synthetic-f3.jpg`, selfieCapturedAt: shown } }));
    const doc = await system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'MOVER', docType: 'national_id', fileUrl, status: 'APPROVED', state: 'COMMITTED', reviewedAt: new Date(), reviewedBy: 'synthetic-reviewer', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
    const a = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const b = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const no = await call(a.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: false, selfieCapturedAt: shown.toISOString() });
    expect(no.statusCode, no.body).toBe(200);
    const rows = () => system(() => app.prisma.auditLog.findMany({ where: { action: 'SELFIE_ID_COMPARED', entityId: subjectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    expect((await rows()).at(-1)!.changes).toMatchObject({ outcome: 'NO_MATCH', reason: REASON });
    const again = await call(a.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true, selfieCapturedAt: shown.toISOString() });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('NO_MATCH_STANDS');
    const override = await call(b.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: true, selfieCapturedAt: shown.toISOString() });
    expect(override.statusCode, override.body).toBe(200);
    expect((await rows()).at(-1)!.changes).toMatchObject({ outcome: 'MATCH', overridesNoMatch: true, reason: REASON });
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER'] } }));
  });
});

// [OWNER-ASKS · round-4 review 3] Off, the selfie-check queue leaves independent pros out (the live phones cannot take
// their photo); on, a pro with a photo and an approved ID waits there for a person.
describe('[owner 9 Nov] the selfie-check queue and the pro switch', () => {
  it('switch off: a pro is not queued; switch on: the pro is queued', async () => {
    const proUser = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59281${NUM}7`, firstName: `Pro${RUN}`, lastName: 'Queue', activeRole: 'CUSTOMER', roles: ['CUSTOMER'], countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, avatar: '/uploads/avatars/PLACEHOLDER/synthetic-pro.jpg', selfieCapturedAt: new Date() } }));
    users.push(proUser.id);
    await system(async () => {
      await app.prisma.user.update({ where: { id: proUser.id }, data: { avatar: `/uploads/avatars/${proUser.id}/synthetic-pro.jpg` } });
      await app.prisma.serviceProvider.create({ data: { userId: proUser.id, trade: 'cleaner' } });
      const fileUrl = await ownedVerificationFixture(app.prisma, proUser.id);
      await app.prisma.verificationDocument.create({ data: { userId: proUser.id, role: 'CUSTOMER', docType: 'national_id', fileUrl, status: 'APPROVED', state: 'COMMITTED', reviewedAt: new Date(), reviewedBy: 'synthetic-reviewer', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
    const reviewer = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    const queued = async () => ((await call(reviewer.token, 'GET', '/verification/selfie-checks')).json().data.pending as Array<{ userId: string }>).map((p) => p.userId);
    vi.stubEnv('PRO_HOME_JOBS_SELFIE', '');
    try { expect(await queued()).not.toContain(proUser.id); } finally { vi.unstubAllEnvs(); }
    vi.stubEnv('PRO_HOME_JOBS_SELFIE', '1');
    try { expect(await queued()).toContain(proUser.id); } finally { vi.unstubAllEnvs(); }
    await system(() => app.prisma.serviceProvider.deleteMany({ where: { userId: proUser.id } }));
  });
});

// [round-5 review S4] The pro "home jobs are paused" notice follows the switch; an override is flagged only over a
// STANDING "no match".
describe('[round 5] the pro notice and the override flag', () => {
  it('a rider who is also a pro: switch off -> no pro notice on a "no match"; switch on -> the pro notice, in the customer inbox', async () => {
    const shown = new Date('2026-11-09T13:00:00.000Z');
    await system(async () => {
      await app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: `/uploads/avatars/${subjectId}/synthetic-r5.jpg`, selfieCapturedAt: shown } });
      await app.prisma.serviceProvider.create({ data: { userId: subjectId, trade: 'cleaner' } });
    });
    const doc = await system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'MOVER', docType: 'national_id', fileUrl, status: 'APPROVED', state: 'COMMITTED', reviewedAt: new Date(), reviewedBy: 'synthetic-reviewer', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
    const notices = () => system(() => app.prisma.notification.findMany({ where: { userId: subjectId, title: 'Home jobs are paused' } }));
    const a = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    vi.stubEnv('PRO_HOME_JOBS_SELFIE', '');
    try {
      expect((await call(a.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: false, selfieCapturedAt: shown.toISOString() })).statusCode).toBe(200);
      expect(await notices()).toHaveLength(0);
    } finally { vi.unstubAllEnvs(); }
    const b = await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']);
    vi.stubEnv('PRO_HOME_JOBS_SELFIE', '1');
    try {
      expect((await call(b.token, 'POST', `/verification/${doc.id}/selfie-check`, { match: false, selfieCapturedAt: shown.toISOString() })).statusCode).toBe(200);
      const sent = await notices();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.data).toMatchObject({ audience: 'customer' });
    } finally { vi.unstubAllEnvs(); }
    await system(() => app.prisma.serviceProvider.deleteMany({ where: { userId: subjectId } }));
    await system(() => app.prisma.notification.deleteMany({ where: { userId: subjectId } }));
  });

  it('a match over a standing "no match" is an override; a later match over that match is not', async () => {
    const shown = new Date('2026-11-09T14:00:00.000Z');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER', 'MOVER', 'RIDER'], avatar: `/uploads/avatars/${subjectId}/synthetic-r5b.jpg`, selfieCapturedAt: shown } }));
    const doc = await system(async () => {
      const fileUrl = await ownedVerificationFixture(app.prisma, subjectId);
      return app.prisma.verificationDocument.create({ data: { userId: subjectId, role: 'MOVER', docType: 'national_id', fileUrl, status: 'APPROVED', state: 'COMMITTED', reviewedAt: new Date(), reviewedBy: 'synthetic-reviewer', consentAt: new Date(), privacyNoticeVersion: 'v1' } });
    });
    const [a, b, c] = [await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']), await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review']), await admin([...DOC_REVIEWER_CAPABILITIES, 'documents.review'])];
    const decide = (token: string, match: boolean) => call(token, 'POST', `/verification/${doc.id}/selfie-check`, { match, selfieCapturedAt: shown.toISOString() });
    const last = async () => (await system(() => app.prisma.auditLog.findMany({ where: { action: 'SELFIE_ID_COMPARED', entityId: subjectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))).at(-1)!.changes as Record<string, unknown>;
    expect((await decide(a.token, false)).statusCode).toBe(200);
    expect((await decide(b.token, true)).statusCode).toBe(200);
    expect(await last()).toMatchObject({ outcome: 'MATCH', overridesNoMatch: true });
    expect((await decide(c.token, true)).statusCode).toBe(200);
    expect(await last()).toMatchObject({ outcome: 'MATCH' });
    expect(await last()).not.toHaveProperty('overridesNoMatch');
    await system(() => app.prisma.user.update({ where: { id: subjectId }, data: { roles: ['VENDOR_OWNER'] } }));
  });
});

