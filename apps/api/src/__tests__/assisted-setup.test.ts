/**
 * [ASSISTED SETUP · owner 12 Nov 2026] "A Swift admin uploads a store's papers and menu for it from the console, with the
 * store's consent recorded (who agreed, how, when) and every action audited under the admin's name. Approving a paper the
 * same admin uploaded must be flagged (second-person approval when a second admin exists)."
 *
 * Red first: on the old code none of the /assisted-setup routes exist (every call is refused as an unclassified admin
 * route or not found), papers carry no uploader, and the uploader may approve their own upload.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
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
import { adminRoutes } from '../modules/admin/admin.routes';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { UPLOAD_CONSENT } from '../modules/verification/upload-consent';
import { wordFreeTag } from './helpers/fixture-ids';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { uniquePng } from './helpers/real-image';
import sharp from 'sharp';
import { liveConsent, storeForAssist } from '../modules/admin/assisted-setup';

// The live admin count, as the same-person rule reads it: overridden to "one admin" for the sole-admin cases only.
const roster = vi.hoisted(() => ({ soleAdmin: null as string | null }));
vi.mock('../modules/admin/solo-approval', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/admin/solo-approval')>();
  return {
    ...real,
    approverRoster: async (...args: Parameters<typeof real.approverRoster>) => {
      const all = await real.approverRoster(...args);
      return roster.soleAdmin ? all.filter((entry) => entry.userId === roster.soleAdmin) : all;
    },
  };
});

const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const REASON = 'Store owner asked us at the shop to set up their papers and menu.';
const OTHER_TENANT = `as-${RUN.toLowerCase()}`;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'assisted-setup-test');

let app: FastifyInstance;
const users: string[] = [];
let seq = 0;
let adminA = { id: '', token: '' };
let adminB = { id: '', token: '' };
let narrowed = { id: '', token: '' };

type Who = { userId: string; token: string; vendorId: string };

async function session(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(24), authMethod: 'OTP', deviceId: `as-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return token;
}
async function makeAdmin(permissions: string[], tenantId?: string) {
  seq += 1;
  const u = await system(() => app.prisma.user.create({ data: {
    phone: `+5926${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Assist', lastName: `Admin${seq}`, roles: ['ADMIN'], activeRole: 'ADMIN',
    isPhoneVerified: true, status: 'ACTIVE', ...(tenantId ? { tenantId } : {}), admin: { create: { permissions } },
  } }));
  users.push(u.id);
  return { id: u.id, token: await session(u.id, 'ADMIN') };
}
async function person(): Promise<Who> {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+5926${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Shan', lastName: 'Persaud', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  return { userId: user.id, token: await session(user.id, 'CUSTOMER'), vendorId: '' };
}
const call = (method: 'GET' | 'POST' | 'PUT', url: string, o: { token: string; vendorId?: string }, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, ...(o.vendorId ? { 'x-vendor-id': o.vendorId } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
});
const admin = (who: { token: string }, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>, reason: string | null = REASON) => app.inject({
  method, url: `/api/v1/admin${url}`, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${who.token}`, ...(reason ? { 'x-swift-reason': reason } : {}), ...(payload ? { 'content-type': 'application/json' } : {}) },
});
function multipartBody(file: Buffer, filename: string, type: string) {
  const boundary = `----as${nanoid(10)}`;
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${type}\r\n\r\n`),
      file, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
const adminUpload = (who: { token: string }, url: string, file: Buffer, filename = 'paper.png', type = 'image/png', reason: string | null = REASON) => {
  const { boundary, body } = multipartBody(file, filename, type);
  return app.inject({ method: 'POST', url: `/api/v1/admin${url}`, payload: body,
    headers: { authorization: `Bearer ${who.token}`, 'content-type': `multipart/form-data; boundary=${boundary}`, ...(reason ? { 'x-swift-reason': reason } : {}) } });
};
const storeUpload = (o: Who, url: string, file: Buffer) => {
  const { boundary, body } = multipartBody(file, 'own.png', 'image/png');
  return app.inject({ method: 'POST', url, payload: body,
    headers: { authorization: `Bearer ${o.token}`, 'x-vendor-id': o.vendorId, 'content-type': `multipart/form-data; boundary=${boundary}` } });
};

async function store(vendorType = 'STORE'): Promise<Who> {
  const o = await person();
  const quote = await signupQuote(app.prisma, o.userId, { role: 'VENDOR', vendorType });
  const res = await call('POST', '/api/v1/partner/become', o, {
    role: 'VENDOR', acceptAgreement: true, weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode },
    business: { name: `Assist Shop ${RUN} ${seq}`, vendorType, phone: '+5926000000', addressLine1: '1 Assist Road', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16 },
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  o.vendorId = (await system(() => app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: o.userId } }, select: { id: true } }))).id;
  o.token = await session(o.userId, 'VENDOR_OWNER');
  return o;
}
const consentBody = (over: Record<string, unknown> = {}) => ({
  agreedByName: 'Shan Persaud', agreedByRole: 'Owner', channel: 'IN_PERSON', agreedAt: new Date(Date.now() - 60_000).toISOString(),
  reference: 'Visit at the shop', wordsRead: true, consentVersion: UPLOAD_CONSENT.document_v1.version, ...over,
});
async function consentFor(o: Who, who = adminA): Promise<string> {
  const res = await admin(who, 'POST', `/vendors/${o.vendorId}/assisted-setup/consent`, consentBody());
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.id as string;
}
const auditRows = (where: Record<string, unknown>) => system(() => app.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } }));
const docsOf = (userId: string) => system(() => app.prisma.verificationDocument.findMany({ where: { userId } }));

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 9).toString('base64'));
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  await system(() => app.prisma.tenant.create({ data: { id: OTHER_TENANT, name: `AS other ${RUN}`, slug: OTHER_TENANT, isActive: true } }));
  adminA = await makeAdmin(['*', 'documents.review']);
  adminB = await makeAdmin(['*', 'documents.review']);
  narrowed = await makeAdmin(['vendor.read', 'verification.read']);
});

afterAll(async () => {
  roster.soleAdmin = null;
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    const vendors = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: users } } }, select: { id: true } })).map((v) => v.id);
    await app.prisma.assistedSetupConsent.deleteMany({ where: { vendorId: { in: vendors } } });
    const items = (await app.prisma.item.findMany({ where: { vendorId: { in: vendors } }, select: { id: true } })).map((i) => i.id);
    await app.prisma.stockMovement.deleteMany({ where: { itemId: { in: items } } }).catch(() => {});
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendors } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendors } } });
    const subs = await app.prisma.subscription.findMany({ where: { vendorId: { in: vendors } }, select: { id: true } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await cleanupBillingClocks(app.prisma, subs.map((s) => s.id));
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
    // The second market goes too: a second ACTIVE tenant left behind makes every public catalogue read in the shared
    // database refuse (PUBLIC_TENANT_UNRESOLVED).
    await app.prisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
  });
  await app.close();
});

describe('who may act for a store', () => {
  it('ADMIN holds store.assist by role; an admin whose grant leaves it out, and a store owner, are refused every door', async () => {
    const o = await store();
    expect((await admin(adminA, 'GET', `/vendors/${o.vendorId}/assisted-setup`)).statusCode).toBe(200);
    const doors: Array<[('GET' | 'POST'), string]> = [
      ['GET', `/vendors/${o.vendorId}/assisted-setup`],
      ['POST', `/vendors/${o.vendorId}/assisted-setup/consent`],
      ['POST', `/vendors/${o.vendorId}/assisted-setup/menu/preview`],
      ['POST', `/vendors/${o.vendorId}/assisted-setup/menu/apply`],
    ];
    for (const [method, url] of doors) {
      const res = await admin(narrowed, method, url, method === 'POST' ? consentBody() : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.body).toContain('store.assist');
    }
    expect((await call('GET', `/api/v1/admin/vendors/${o.vendorId}/assisted-setup`, o)).statusCode).toBe(403);
    // Nothing was recorded for the store by the refused calls.
    expect(await system(() => app.prisma.assistedSetupConsent.count({ where: { vendorId: o.vendorId } }))).toBe(0);
  });

  it('another market’s store is not found; another market’s admin never sees this one', async () => {
    const o = await store();
    const foreign = await makeAdmin(['*'], OTHER_TENANT);
    expect((await admin(foreign, 'GET', `/vendors/${o.vendorId}/assisted-setup`)).statusCode).toBe(404);
    expect((await admin(foreign, 'POST', `/vendors/${o.vendorId}/assisted-setup/consent`, consentBody())).statusCode).toBe(404);
  });
});

describe('the store’s OK comes first', () => {
  it('a consent needs a reason and the current words; recorded, it names who agreed, how and when, under the admin, audited', async () => {
    const o = await store();
    expect((await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/consent`, consentBody(), null)).statusCode).toBe(400);
    const stale = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/consent`, consentBody({ consentVersion: 'v0' }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error?.code ?? stale.json().code).toBe('CONSENT_WORDS_CHANGED');
    const future = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/consent`, consentBody({ agreedAt: new Date(Date.now() + DAY).toISOString() }));
    expect(future.statusCode).toBe(400);
    const notRead = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/consent`, consentBody({ wordsRead: false }));
    expect(notRead.statusCode).toBe(400);

    const consentId = await consentFor(o);
    const row = await system(() => app.prisma.assistedSetupConsent.findUniqueOrThrow({ where: { id: consentId } }));
    expect(row).toMatchObject({
      vendorId: o.vendorId, holderId: o.userId, agreedByName: 'Shan Persaud', agreedByRole: 'Owner', channel: 'IN_PERSON',
      reference: 'Visit at the shop', recordedByAdminId: adminA.id, reason: REASON, consentVersion: UPLOAD_CONSENT.document_v1.version,
    });
    const audits = await auditRows({ userId: adminA.id, entityId: o.vendorId, action: { contains: '/assisted-setup/consent' } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.changes)).toContain(consentId);
    // The panel shows the words to read, the OK, and the store's paper list.
    const panel = (await admin(adminA, 'GET', `/vendors/${o.vendorId}/assisted-setup`)).json().data;
    expect(panel.script.consentText).toBe(UPLOAD_CONSENT.document_v1.text);
    expect(panel.consents[0]).toMatchObject({ id: consentId, live: true, channel: 'IN_PERSON' });
    expect(panel.papers.checklist.length).toBeGreaterThan(0);
  });

  it('no paper, menu or photo without a live OK for THIS store: nothing is stored', async () => {
    const o = await store();
    const other = await store();
    const otherConsent = await consentFor(other);
    const png = uniquePng(`as-noconsent-${RUN}`);
    for (const query of ['', `&consentId=${otherConsent}`, '&consentId=nope']) {
      const res = await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/documents?docType=storefront_photo${query}`, png);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.body).toContain('ASSISTED_CONSENT_REQUIRED');
    }
    expect(await system(() => app.prisma.encryptedObject.count({ where: { createdBy: o.userId } }))).toBe(0);
    expect(await docsOf(o.userId)).toHaveLength(0);
    const apply = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/menu/apply`, { consentId: otherConsent, csv: 'category,name,basePrice\nDrinks,Mauby,300' });
    expect(apply.statusCode).toBe(409);
    const preview = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/menu/preview`, { consentId: otherConsent, csv: 'category,name,basePrice\nDrinks,Mauby,300' });
    expect(preview.statusCode).toBe(409);
    // An OK past its days covers nothing (read 15 days on; a recorded OK is never edited, so the clock moves instead).
    const old = await consentFor(o);
    const assistStore = await system(() => storeForAssist(app.prisma, o.vendorId));
    await expect(system(() => liveConsent(app.prisma, assistStore, old))).resolves.toMatchObject({ id: old });
    await expect(system(() => liveConsent(app.prisma, assistStore, old, new Date(Date.now() + 15 * DAY)))).rejects.toThrow(/Record the store/);
  });
});

describe('papers filed for the store', () => {
  it('filed exactly as the store’s own upload, naming the admin and the OK; waits for a person; the store sees it and its tick', async () => {
    const o = await store();
    const consentId = await consentFor(o);
    const res = await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/documents?docType=storefront_photo&consentId=${consentId}`, uniquePng(`as-doc-${RUN}`));
    expect(res.statusCode, res.body).toBe(201);
    const [doc] = await docsOf(o.userId);
    expect(doc).toMatchObject({ userId: o.userId, docType: 'storefront_photo', status: 'PENDING', assistedById: adminA.id, assistedConsentId: consentId, privacyNoticeVersion: 'assisted-v1' });
    // Kept in the account holder's own folder, owned by them, as their own upload is.
    expect(doc!.fileUrl).toContain(`verification/${o.userId}/`);
    const object = await system(() => app.prisma.encryptedObject.findUniqueOrThrow({ where: { fileKey: doc!.fileUrl } }));
    expect(object.createdBy).toBe(o.userId);
    // The record, the audit row and the store's tick, all naming the OK.
    expect(await system(() => app.prisma.assistedSetupAction.findMany({ where: { vendorId: o.vendorId } }))).toEqual([
      expect.objectContaining({ kind: 'DOCUMENT', targetId: doc!.id, consentId, adminId: adminA.id, detail: 'storefront_photo' }),
    ]);
    const audits = await auditRows({ userId: adminA.id, action: { contains: '/assisted-setup/documents' } });
    expect(audits.some((a) => JSON.stringify(a.changes).includes(doc!.id) && JSON.stringify(a.changes).includes(consentId))).toBe(true);
    const tick = await system(() => app.prisma.consentRecord.findFirst({ where: { subjectId: o.userId, documentType: 'document_processing_consent' }, orderBy: { capturedAt: 'desc' } }));
    expect(tick).toMatchObject({ action: 'granted', surface: 'admin' });
    expect(JSON.stringify(tick!.evidence)).toContain(consentId);
    const status = (await call('GET', '/api/v1/verification/status?role=STORE', o)).json().data;
    expect(status.documentConsent.given).toBe(true);
    expect(status.documents.find((d: { id: string }) => d.id === doc!.id)).toMatchObject({ addedBySwift: true });
    // Who at Swift is never shown to the store.
    expect(JSON.stringify(status)).not.toContain(adminA.id);
  });

  it('a paper that is not on the store’s list, or carries its own consent, is refused before anything is stored', async () => {
    const o = await store();
    const consentId = await consentFor(o);
    for (const docType of ['police_clearance', 'own_name_declaration', 'not_a_paper']) {
      const res = await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/documents?docType=${docType}&consentId=${consentId}`, uniquePng(`as-${docType}-${RUN}`));
      expect(res.statusCode, `${docType} ${res.body}`).toBe(400);
    }
    expect(await system(() => app.prisma.encryptedObject.count({ where: { createdBy: o.userId } }))).toBe(0);
  });

  it('who filed a paper is fixed (database): it is never moved onto or off an upload later', async () => {
    const o = await store();
    const consentId = await consentFor(o);
    await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/documents?docType=storefront_photo&consentId=${consentId}`, uniquePng(`as-fixed-${RUN}`));
    const [doc] = await docsOf(o.userId);
    await expect(system(() => app.prisma.verificationDocument.update({ where: { id: doc!.id }, data: { assistedById: adminB.id } }))).rejects.toThrow(/fixed/);
    await expect(system(() => app.prisma.assistedSetupConsent.update({ where: { id: consentId }, data: { agreedByName: 'Someone Else' } }))).rejects.toThrow(/written once/);
  });
});

describe('the same admin approving their own upload', () => {
  async function filedBy(who: { id: string; token: string }) {
    const o = await store();
    const consentId = await consentFor(o, who);
    const res = await adminUpload(who, `/vendors/${o.vendorId}/assisted-setup/documents?docType=storefront_photo&consentId=${consentId}`, uniquePng(`as-same-${nanoid(6)}`));
    expect(res.statusCode, res.body).toBe(201);
    return { o, docId: (await docsOf(o.userId))[0]!.id };
  }
  const approve = (who: { token: string }, docId: string, body: Record<string, unknown> = {}) =>
    admin(who, 'PUT', `/verification/${docId}/approve`, body, 'Checked the storefront photo against the address.');

  it('with a second admin, the uploader is refused and the paper stays waiting; the second admin approves it', async () => {
    const { docId } = await filedBy(adminA);
    for (const body of [{}, { soleAdminChecked: true }]) {
      const refused = await approve(adminA, docId, body);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.body).toContain('ASSISTED_UPLOADER_CANNOT_APPROVE');
    }
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } }))).status).toBe('PENDING');
    const ok = await approve(adminB, docId);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('the only admin is warned and needs "I checked it myself"; the acknowledgement is audited', async () => {
    const { docId } = await filedBy(adminA);
    roster.soleAdmin = adminA.id;
    try {
      const warned = await approve(adminA, docId);
      expect(warned.statusCode, warned.body).toBe(409);
      expect(warned.body).toContain('ASSISTED_UPLOADER_ACK_REQUIRED');
      expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } }))).status).toBe('PENDING');
      const ok = await approve(adminA, docId, { soleAdminChecked: true });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      roster.soleAdmin = null;
    }
    const ack = await auditRows({ userId: adminA.id, entityId: docId, action: 'ASSISTED_SAME_ADMIN_APPROVAL' });
    expect(ack).toHaveLength(1);
    expect(JSON.stringify(ack[0]!.changes)).toContain('no second admin available');
  });

  it('a paper the store sent itself is untouched by the rule', async () => {
    const o = await store();
    const up = await storeUpload(o, '/api/v1/verification/upload', uniquePng(`as-own-${RUN}`));
    expect(up.statusCode, up.body).toBe(200);
    const filed = await call('POST', '/api/v1/verification/documents', o, {
      role: 'STORE', docType: 'storefront_photo', fileUrl: up.json().data.url, consent: true, privacyNoticeVersion: 'web-v1', consentTick: 'document_v1',
    });
    expect(filed.statusCode, filed.body).toBe(201);
    expect(filed.json().data.assistedById ?? null).toBeNull();
    const doc = (await docsOf(o.userId))[0]!;
    if (doc.status === 'PENDING') expect((await approve(adminA, doc.id)).statusCode).toBe(200);
  });
});

describe('a menu imported for the store', () => {
  const CSV = [
    'category,name,basePrice,sku',
    'Drinks,Mauby,300,MB-1',
    'Drinks,Sorrel,,SR-1',
    'Snacks,Cheese Roll,250,CR-1',
    'Snacks,Cheese Roll again,250,CR-1',
  ].join('\n');

  it('an unverified store still adds no new items: the preview says so, the apply is refused, nothing is written', async () => {
    const o = await store();
    const consentId = await consentFor(o);
    const preview = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/menu/preview`, { consentId, csv: CSV });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().data.canAddItems).toBe(false);
    const apply = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/menu/apply`, { consentId, csv: preview.json().data.automap.normalizedCsv });
    expect(apply.statusCode, apply.body).toBe(403);
    expect(apply.body).toContain('VERIFICATION_REQUIRED');
    expect(await system(() => app.prisma.item.count({ where: { vendorId: o.vendorId } }))).toBe(0);
  });

  it('the preview shows the same row errors the store’s own import gives; applied, each item names the OK and the store sees it', async () => {
    const o = await store();
    const twin = await store();
    await system(() => app.prisma.vendor.updateMany({ where: { id: { in: [o.vendorId, twin.vendorId] } }, data: { isVerified: true } }));
    const consentId = await consentFor(o);
    const preview = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/menu/preview`, { consentId, csv: CSV });
    expect(preview.statusCode, preview.body).toBe(200);
    const { automap, plan, canAddItems } = preview.json().data;
    expect(canAddItems).toBe(true);
    expect(plan.imported).toBe(2);
    expect(plan.failures.map((f: { row: number }) => f.row)).toEqual([3, 5]);
    // Nothing written by the preview.
    expect(await system(() => app.prisma.item.count({ where: { vendorId: o.vendorId } }))).toBe(0);

    // The store's own import of the same file gives the same row errors.
    const own = await call('POST', '/api/v1/vendor/items/import', twin, { csv: automap.normalizedCsv });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().data.failures).toEqual(plan.failures);

    const apply = await admin(adminA, 'POST', `/vendors/${o.vendorId}/assisted-setup/menu/apply`, { consentId, csv: automap.normalizedCsv });
    expect(apply.statusCode, apply.body).toBe(200);
    expect(apply.json().data).toMatchObject({ imported: 2, failedCount: 2 });
    expect(apply.json().data.failures).toEqual(plan.failures);
    const items = await system(() => app.prisma.item.findMany({ where: { vendorId: o.vendorId }, select: { id: true, name: true } }));
    expect(items.map((i) => i.name).sort()).toEqual(['Cheese Roll', 'Mauby']);
    const actions = await system(() => app.prisma.assistedSetupAction.findMany({ where: { vendorId: o.vendorId, kind: 'MENU_ITEM' } }));
    expect(actions.map((a) => a.targetId).sort()).toEqual(items.map((i) => i.id).sort());
    expect(actions.every((a) => a.consentId === consentId && a.adminId === adminA.id)).toBe(true);
    expect(await auditRows({ userId: adminA.id, action: 'ASSISTED_MENU_ITEM_ADDED', entityId: { in: items.map((i) => i.id) } })).toHaveLength(2);
    expect(await auditRows({ userId: adminA.id, entityId: o.vendorId, action: { contains: '/assisted-setup/menu/apply' } })).toHaveLength(1);

    const listed = (await call('GET', '/api/v1/vendor/items', o)).json().data as Array<{ name: string; addedBySwiftAt?: string }>;
    expect(listed.every((i) => typeof i.addedBySwiftAt === 'string')).toBe(true);
    const twinListed = (await call('GET', '/api/v1/vendor/items', twin)).json().data as Array<{ addedBySwiftAt?: string }>;
    expect(twinListed.every((i) => i.addedBySwiftAt === undefined)).toBe(true);
  });
});

/** A photo whose pixels decode (the store photo door draws it again); a shade per call keeps each file unique. */
let shade = 10;
const drawnPng = () => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: (shade += 7) % 255, g: 60, b: 90 } } }).png().toBuffer();

describe('item photos added for the store', () => {
  it('kept in the store’s own photo folder; the store sees "added by Swift" until it replaces the photo', async () => {
    const o = await store();
    const other = await store();
    const consentId = await consentFor(o);
    const item = await system(async () => {
      const category = await app.prisma.category.create({ data: { vendorId: o.vendorId, name: 'Drinks' } });
      return app.prisma.item.create({ data: { vendorId: o.vendorId, categoryId: category.id, name: 'Mauby', basePrice: 300, dietaryTags: [], allergens: [] } });
    });
    const foreignItem = await system(async () => {
      const category = await app.prisma.category.create({ data: { vendorId: other.vendorId, name: 'Drinks' } });
      return app.prisma.item.create({ data: { vendorId: other.vendorId, categoryId: category.id, name: 'Sorrel', basePrice: 300, dietaryTags: [], allergens: [] } });
    });

    // Another store's item through this store's door: not found, nothing set.
    const idor = await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/items/${foreignItem.id}/photo?consentId=${consentId}`, await drawnPng());
    expect(idor.statusCode).toBe(404);
    expect((await system(() => app.prisma.item.findUniqueOrThrow({ where: { id: foreignItem.id } }))).imageUrl).toBeNull();
    // No OK, no photo.
    expect((await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/items/${item.id}/photo`, await drawnPng())).statusCode).toBe(409);
    // A file that is not a photo is refused as the store's own upload refuses it.
    expect((await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/items/${item.id}/photo?consentId=${consentId}`, Buffer.from('%PDF-1.4 not a photo'), 'menu.pdf', 'application/pdf')).statusCode).toBe(400);

    const res = await adminUpload(adminA, `/vendors/${o.vendorId}/assisted-setup/items/${item.id}/photo?consentId=${consentId}`, await drawnPng());
    expect(res.statusCode, res.body).toBe(200);
    const set = await system(() => app.prisma.item.findUniqueOrThrow({ where: { id: item.id } }));
    expect(set.imageUrl).toContain(`items/${o.vendorId}/`);
    expect(await system(() => app.prisma.assistedSetupAction.findMany({ where: { vendorId: o.vendorId, kind: 'ITEM_PHOTO' } }))).toEqual([
      expect.objectContaining({ targetId: item.id, consentId, adminId: adminA.id, detail: set.imageUrl }),
    ]);
    let listed = (await call('GET', '/api/v1/vendor/items', o)).json().data as Array<{ id: string; photoAddedBySwiftAt?: string }>;
    expect(listed.find((i) => i.id === item.id)?.photoAddedBySwiftAt).toEqual(expect.any(String));

    // The store replaces it with its own: no longer "added by Swift".
    const own = await storeUpload(o, `/api/v1/vendor/items/${item.id}/image`, await drawnPng());
    expect(own.statusCode, own.body).toBe(200);
    listed = (await call('GET', '/api/v1/vendor/items', o)).json().data as Array<{ id: string; photoAddedBySwiftAt?: string }>;
    expect(listed.find((i) => i.id === item.id)?.photoAddedBySwiftAt).toBeUndefined();
  });
});

describe('the tenant wall on the new tables', () => {
  it('both tables force row-level security with the tenant policy, and another market reads none of the rows', async () => {
    const o = await store();
    const consentId = await consentFor(o);
    const rls = await system(() => app.prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('assisted_setup_consents', 'assisted_setup_actions') ORDER BY relname`);
    expect(rls).toEqual([
      { relname: 'assisted_setup_actions', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'assisted_setup_consents', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const policies = await system(() => app.prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename IN ('assisted_setup_consents', 'assisted_setup_actions')`);
    expect(policies).toHaveLength(2);
    expect(await runWithTenant(OTHER_TENANT, () => app.prisma.assistedSetupConsent.findMany({ where: { id: consentId } }))).toEqual([]);
    expect(await runWithTenant('swift-default', () => app.prisma.assistedSetupConsent.count({ where: { id: consentId } }))).toBe(1);
    // The database refuses a consent named for the wrong market or the wrong account holder.
    await expect(system(() => app.prisma.assistedSetupConsent.create({ data: {
      tenantId: OTHER_TENANT, vendorId: o.vendorId, holderId: o.userId, agreedByName: 'X Y', agreedByRole: 'Owner', channel: 'PHONE', agreedAt: new Date(),
      consentDocumentType: 'document_processing_consent', consentVersion: 'v1', recordedByAdminId: adminA.id, reason: REASON,
    } }))).rejects.toThrow(/lineage/);
    await expect(system(() => app.prisma.assistedSetupConsent.create({ data: {
      tenantId: 'swift-default', vendorId: o.vendorId, holderId: adminA.id, agreedByName: 'X Y', agreedByRole: 'Owner', channel: 'PHONE', agreedAt: new Date(),
      consentDocumentType: 'document_processing_consent', consentVersion: 'v1', recordedByAdminId: adminA.id, reason: REASON,
    } }))).rejects.toThrow(/account holder/);
  });
});
