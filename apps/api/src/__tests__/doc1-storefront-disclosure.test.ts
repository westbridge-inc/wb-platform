/**
 * [DOC-1 Part XIX · DOC-INV-27 · P19] test_no_storefront_without_disclosure
 *
 * The supplier-information block is compiled from VALID document records and labelled
 * fallbacks, never hand-written: the store's own checked name (a business or company is never
 * named by its owner's personal name; only a trader under their OWN name shows their full name,
 * owner ruling 10 Nov 2026), the self-declared address labelled as such, the
 * verified account contact, every VALID licence record, and the platform operator block
 * from the ONE OPERATOR constant [R3]. It is derived on every read: an expired licence leaves the block in
 * the same sweep. Once the country's business document types are ACTIVE, a store with an
 * incomplete block cannot go live; before activation the block is shown but does not gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { seedDocRegistry, registryCode } from '../modules/verification/doc-registry';
import { compileActivationDisclosure, disclosureGateEngaged, platformOperator } from '../modules/verification/storefront-disclosure';
import { documentRecordDdl } from '../modules/verification/document-record';
import { docStateMachineDdl } from '../modules/verification/doc-state';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';
import crypto from 'node:crypto';
import { encryptBuffer, generateDek, getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { packCiphertext } from '../modules/verification/extraction-ledger';
import { OPERATOR as OPERATOR_FACTS, OPERATOR_ADDRESS } from '../modules/legal/operator';
import { wordFreeTag } from './helpers/fixture-ids';
import { giveFoodHandlersTick } from './helpers/food-handlers-tick';

grantSuiteCapability('ddl');

const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const OPERATOR = { PLATFORM_LEGAL_NAME: 'Westbridge Inc.', PLATFORM_REGISTERED_ADDRESS: '1 Main Street, Georgetown, Guyana', SUPPORT_EMAIL: 'support@example.gy' };
const prevEnv: Record<string, string | undefined> = {};

let app: FastifyInstance;
let service: VerificationService;
const users: string[] = [];
const activated: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-storefront-disclosure-test');

async function store(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59266${NUM}${n}`, firstName: 'Priya', lastName: `Persaud${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER'], countryCode: 'GY', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: u.id, vendors: { create: {
    name: `Priya's Snackette ${RUN}${n}`, slug: `priyas-snackette-${RUN.toLowerCase()}-${n}`, vendorType: 'RESTAURANT', phone: `+59266${NUM}${n}`,
    addressLine1: `${n} Sheriff Street`, addressLine2: 'Georgetown', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'PENDING_APPROVAL',
    // [owner #51, 14 Oct] A first go-live needs a published phone; set, so the disclosure block alone decides here.
    publicPhone: '+5926001200',
  } } }, include: { vendors: true } }));
  return { userId: u.id, vendorId: owner.vendors[0]!.id };
}
const approved = (userId: string, docType: string, extra: Record<string, unknown> = {}) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'VENDOR_OWNER', docType, fileUrl: `/uploads/verification/${RUN}/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'disclosure-test', reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY), ...extra,
} }));
const vendorOf = (id: string) => system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id }, select: { isVerified: true, status: true } }));
const checklistFor = async (userId: string) => (service as unknown as { checklistFor: (u: string, c: string, r: string) => Promise<string[]> }).checklistFor(userId, 'GY', 'RESTAURANT');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  for (const [k, v] of Object.entries(OPERATOR)) { prevEnv[k] = process.env[k]; process.env[k] = v; }
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile', 'document_record'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`))), ...docStateMachineDdl(), ...documentRecordDdl()]);
  service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  for (const k of Object.keys(OPERATOR)) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  await system(async () => {
    if (activated.length) await app.prisma.docType.updateMany({ where: { code: { in: activated } }, data: { isActive: false, legalFactsVerifiedAt: null } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: owners.map((o) => o.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P19] the disclosure is compiled, never written', () => {
  it('names what is missing; with the owner’s ID on file the store’s name waits for a person, who confirms it; the address is labelled self-declared; the contact is the verified account; licences appear while VALID and leave when they expire', async () => {
    const { userId, vendorId } = await store(1);
    const bare = await system(() => compileActivationDisclosure(app.prisma, vendorId, { accountId: userId, tenantId: 'swift-default' }));
    expect(bare.complete).toBe(false);
    expect(bare.missing).toEqual(['legalName']);
    expect(bare.pendingPersonCheck).toEqual([]);
    expect(bare.address).toMatchObject({ source: 'SELF_DECLARED', value: '1 Sheriff Street, Georgetown' });
    expect(bare.contact).toMatchObject({ source: 'ACCOUNT' });
    // [R3] The operator is the ONE OPERATOR constant, not the configuration this suite sets.
    expect(bare.operator).toEqual({ legalName: OPERATOR_FACTS.name, registeredAddress: OPERATOR_ADDRESS, supportEmail: OPERATOR_FACTS.supportEmail });

    await approved(userId, 'owner_national_id');
    // [security review 10 Nov 2026] complete (the ID alone sufficed before, so no store is made incomplete), but the
    // store's self-typed name is never presented as a checked name: it names nobody until a person confirms it
    const pending = await system(() => compileActivationDisclosure(app.prisma, vendorId, { accountId: userId, tenantId: 'swift-default' }));
    expect(pending).toMatchObject({ complete: true, missing: [], pendingPersonCheck: ['legalName'], legalName: null });
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { sellerNameCheckedName: `Priya's Snackette ${RUN}1`, sellerNameCheckedAt: new Date(), sellerNameCheckedById: 'disclosure-test' } }));
    const named = await system(() => compileActivationDisclosure(app.prisma, vendorId, { accountId: userId, tenantId: 'swift-default' }));
    expect(named.complete).toBe(true);
    expect(named.pendingPersonCheck).toEqual([]);
    // no record lends the store's name provenance: no document type, no record id
    expect(named.legalName).toEqual({ value: `Priya's Snackette ${RUN}1`, source: 'STORE_NAME' });

    const licence = await approved(userId, 'food_handler_cert');
    expect((await system(() => compileActivationDisclosure(app.prisma, vendorId, { accountId: userId, tenantId: 'swift-default' }))).licences).toEqual([{ value: 'on file', source: 'RECORD', docType: 'food_handler_cert', recordId: expect.any(String) }]);
    await system(() => app.prisma.verificationDocument.update({ where: { id: licence.id }, data: { expiresAt: new Date(Date.now() - DAY) } }));
    await system(() => service.expireLapsedDocuments());
    expect((await system(() => compileActivationDisclosure(app.prisma, vendorId, { accountId: userId, tenantId: 'swift-default' }))).licences).toEqual([]);
  });

  it('the storefront read carries the block; the operator is the one OPERATOR constant, configured or not [R3]', async () => {
    const { vendorId } = await store(2);
    const pending = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${vendorId}` });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().data.disclosure).toBeNull();
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE', isVerified: true } }));
    const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${vendorId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.disclosure).toMatchObject({ complete: false, missing: ['legalName'] });
    const operator = { legalName: OPERATOR_FACTS.name, registeredAddress: OPERATOR_ADDRESS, supportEmail: OPERATOR_FACTS.supportEmail };
    expect(res.json().data.disclosure.operator).toEqual(operator);
    const saved = Object.fromEntries(Object.keys(OPERATOR).map((k) => [k, process.env[k]]));
    for (const k of Object.keys(OPERATOR)) delete process.env[k];
    try { expect(platformOperator()).toEqual(operator); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it('DOC-INV-27: once the business types are active, a store with an incomplete block cannot go live; complete it and it activates', async () => {
    const { userId, vendorId } = await store(3);
    // [FOOD-PERMIT] a registered restaurant also needs its owner's food handlers tick: given up front, so the block
    // alone decides below
    await system(() => giveFoodHandlersTick(app.prisma, userId, vendorId));
    const checklist = await checklistFor(userId);
    for (const t of checklist.filter((x) => x !== 'owner_national_id')) await approved(userId, t);
    const beforeGate = await system(() => disclosureGateEngaged(app.prisma, 'GY'));
    expect(beforeGate).toBe(false);
    // activate a BUSINESS-bucket type: the gate engages
    const code = registryCode('GY', 'business_registration');
    await system(() => app.prisma.docType.update({ where: { code }, data: { isActive: true, legalFactsVerifiedAt: new Date() } }));
    activated.push(code);
    expect(await system(() => disclosureGateEngaged(app.prisma, 'GY'))).toBe(true);
    // the checklist still lacks the identity document → not verified, and the block is incomplete
    expect(await system(() => service.isRoleVerified(userId, 'RESTAURANT'))).toBe(false);
    // give it every checklist type EXCEPT via a path that leaves the block incomplete: take the typed address away
    // ([R3] the operator block can no longer be the missing element — it is the ONE OPERATOR constant)
    await approved(userId, 'owner_national_id');
    expect(await system(() => service.isRoleVerified(userId, 'RESTAURANT'))).toBe(true);
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { addressLine1: '', addressLine2: null } }));
    const projection = service as unknown as { projectVendorActivation: (db: unknown, u: string) => Promise<void> };
    await system(() => projection.projectVendorActivation(app.prisma, userId));
    expect(await vendorOf(vendorId)).toMatchObject({ isVerified: false, status: 'PENDING_APPROVAL' });
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { addressLine1: '3 Sheriff Street', addressLine2: 'Georgetown' } }));
    await system(() => projection.projectVendorActivation(app.prisma, userId));
    expect(await vendorOf(vendorId)).toMatchObject({ isVerified: true, status: 'ACTIVE' });
  });

  it('[VERIFY-DOCS · ruling 5] a food handler’s permit shows "on file", never its number — it is a person’s permit; a business licence still shows its number', async () => {
    const prevKek = process.env['MASTER_KEK'];
    process.env['MASTER_KEK'] = crypto.randomBytes(32).toString('base64');
    resetKeyProviderForTests();
    try {
      const { userId, vendorId } = await store(4);
      /** The number a reviewer or processor read, stored as the ledger stores it (encrypted under a run key). */
      const withNumber = async (submissionId: string, fieldCode: string, value: string) => {
        const dek = generateDek();
        const wrappedDek = await getKeyProvider()!.wrapDek(dek);
        await system(() => app.prisma.extractionRun.create({ data: {
          submissionId, profileCode: 'UNPROFILED', engineName: 'disclosure-test', engineVersion: '1', startedAt: new Date(), finishedAt: new Date(), outcome: 'OK',
          wrappedDek: new Uint8Array(wrappedDek),
          fields: { create: [{ submissionId, fieldCode, valueCt: new Uint8Array(packCiphertext(encryptBuffer(Buffer.from(value, 'utf8'), dek))), source: 'PROVIDER' }] },
        } }));
      };
      const permit = await approved(userId, 'food_handler_cert');
      const trade = await approved(userId, 'trade_licence');
      await withNumber(permit.id, 'permit_number', `FH-${NUM}`);
      await withNumber(trade.id, 'licence_number', `TL-${NUM}`);
      const block = await system(() => compileActivationDisclosure(app.prisma, vendorId, { accountId: userId, tenantId: 'swift-default' }));
      expect(block.licences.find((l) => l.docType === 'trade_licence')?.value).toBe(`TL-${NUM}`);
      expect(block.licences.find((l) => l.docType === 'food_handler_cert')?.value).toBe('on file');
      expect(JSON.stringify(block)).not.toContain(`FH-${NUM}`);
    } finally {
      if (prevKek === undefined) delete process.env['MASTER_KEK']; else process.env['MASTER_KEK'] = prevKek;
      resetKeyProviderForTests();
    }
  });
});

// [R3 · CAA s.70(1) · owner ruling 10 Nov 2026 · security review] The seller's name is the BUSINESS's name. An owner's
// personal name is never shown for a registered business or company, and never as "<person> trading as <store>"; only a
// person who trades under their OWN name (own-name declaration, no business registration) is named by their full name,
// because that name is their trading name. A store's self-typed name names the seller only once a PERSON at Swift
// confirmed that exact name; until then the block names nobody, and no record lends the name provenance.
describe('[R3 · owner ruling 10 Nov 2026] who sells: the business’s own name; a person’s full name only when they trade under it', () => {
  const blockOf = (userId: string, vendorId: string) => system(() => compileActivationDisclosure(app.prisma, vendorId, { accountId: userId, tenantId: 'swift-default' }));
  const setStore = (vendorId: string, data: Record<string, unknown>) => system(() => app.prisma.vendor.update({ where: { id: vendorId }, data }));
  /** A person at Swift confirms the store's exact name as the seller's (the console's approve or seller-name check). */
  const personConfirms = (vendorId: string, name: string) => setStore(vendorId, { sellerNameCheckedName: name, sellerNameCheckedAt: new Date(), sellerNameCheckedById: 'disclosure-test' });
  const PERSONAL = /Priya|Persaud\d|trading as/;

  it('a registered company: names nobody until a person confirms its name, then its company name only — never its owner’s name', async () => {
    const { userId, vendorId } = await store(5);
    await setStore(vendorId, { name: `Sample Holdings Inc. ${RUN}5` });
    await approved(userId, 'business_registration');
    // the registration alone makes the block complete (a company's papers may come before any one person's ID), but the
    // self-typed name is not a checked name: nobody is named yet
    const registered = await blockOf(userId, vendorId);
    expect(registered).toMatchObject({ complete: true, missing: [], pendingPersonCheck: ['legalName'], legalName: null });
    await approved(userId, 'owner_national_id');
    const unconfirmed = await blockOf(userId, vendorId);
    expect(unconfirmed).toMatchObject({ pendingPersonCheck: ['legalName'], legalName: null });
    expect(JSON.stringify(unconfirmed)).not.toMatch(PERSONAL);
    await personConfirms(vendorId, `Sample Holdings Inc. ${RUN}5`);
    const confirmed = await blockOf(userId, vendorId);
    expect(confirmed).toMatchObject({ complete: true, pendingPersonCheck: [] });
    expect(confirmed.legalName).toEqual({ value: `Sample Holdings Inc. ${RUN}5`, source: 'STORE_NAME' });
    expect(JSON.stringify(confirmed.legalName)).not.toMatch(PERSONAL);
  });

  it('a confirmation is of an EXACT name: a renamed store names nobody again until a person confirms the new name', async () => {
    const { userId, vendorId } = await store(8);
    await setStore(vendorId, { name: `Sample Traders ${RUN}8` });
    await approved(userId, 'owner_national_id');
    await approved(userId, 'business_registration');
    await personConfirms(vendorId, `Sample Traders ${RUN}8`);
    expect((await blockOf(userId, vendorId)).legalName).toEqual({ value: `Sample Traders ${RUN}8`, source: 'STORE_NAME' });
    await setStore(vendorId, { name: `Sample Traders Two ${RUN}8` });
    expect(await blockOf(userId, vendorId)).toMatchObject({ complete: true, pendingPersonCheck: ['legalName'], legalName: null });
  });

  it('a registered business name: that name only once confirmed — even when it carries the owner’s surname, and even for a store that once declared its own name', async () => {
    const { userId, vendorId } = await store(6);
    await setStore(vendorId, { name: `Persaud's Hardware ${RUN}6`, tradesUnderOwnName: true });
    await approved(userId, 'owner_national_id');
    await approved(userId, 'own_name_declaration');
    await approved(userId, 'business_registration');
    // a registration on file: not an own-name trader, so never the owner's full name
    expect(await blockOf(userId, vendorId)).toMatchObject({ pendingPersonCheck: ['legalName'], legalName: null });
    await personConfirms(vendorId, `Persaud's Hardware ${RUN}6`);
    const b = await blockOf(userId, vendorId);
    expect(b.legalName).toEqual({ value: `Persaud's Hardware ${RUN}6`, source: 'STORE_NAME' });
    expect(b.legalName!.value).not.toContain('Priya');
  });

  it('a person approving the store confirms exactly the name they saw: another name is refused and confirms nothing; the shown name goes live named', async () => {
    const { userId, vendorId } = await store(9);
    await setStore(vendorId, { name: `Sample Foods Ltd ${RUN}9` });
    await system(() => giveFoodHandlersTick(app.prisma, userId, vendorId));
    for (const t of await checklistFor(userId)) await approved(userId, t);
    const refused = await system(() => service.activateStore(userId, vendorId, undefined, { by: 'approver-test', name: `Sample Foods ${RUN}9` })).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: 'SELLER_NAME_CHANGED' });
    expect(await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { status: true, sellerNameCheckedName: true } })))
      .toEqual({ status: 'PENDING_APPROVAL', sellerNameCheckedName: null });
    await system(() => service.activateStore(userId, vendorId, undefined, { by: 'approver-test', name: `Sample Foods Ltd ${RUN}9` }));
    expect(await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { status: true, sellerNameCheckedName: true, sellerNameCheckedById: true } })))
      .toEqual({ status: 'ACTIVE', sellerNameCheckedName: `Sample Foods Ltd ${RUN}9`, sellerNameCheckedById: 'approver-test' });
    expect((await blockOf(userId, vendorId)).legalName).toEqual({ value: `Sample Foods Ltd ${RUN}9`, source: 'STORE_NAME' });
  });

  it('a trader under their OWN name: their full name, once a person checked the declaration — and only while the store trades under it', async () => {
    const { userId, vendorId } = await store(7);
    await setStore(vendorId, { name: 'P. Persaud7', tradesUnderOwnName: true });
    await approved(userId, 'owner_national_id');
    // declared, not yet checked by a person: nobody is named, never the account's name
    expect(await blockOf(userId, vendorId)).toMatchObject({ pendingPersonCheck: ['legalName'], legalName: null });
    await approved(userId, 'own_name_declaration');
    const own = await blockOf(userId, vendorId);
    expect(own).toMatchObject({ complete: true, pendingPersonCheck: [] });
    // the declaration was signed for THIS store's name, so it is the provenance
    expect(own.legalName).toEqual({ value: 'Priya Persaud7', source: 'PROPRIETOR', docType: 'own_name_declaration', recordId: expect.any(String) });
    expect(own.legalName!.value).not.toContain('trading as');
    // the choice is per store: switched to a business name, nobody is named until a person confirms the store's name
    await setStore(vendorId, { tradesUnderOwnName: false });
    expect(await blockOf(userId, vendorId)).toMatchObject({ pendingPersonCheck: ['legalName'], legalName: null });
  });
});
