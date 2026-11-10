import { readFeePause } from '../billing/mmg-pause';
import { validExpiryOr } from './document-validity';
import { liveSubmissionWhere } from './evidence';
/**
 * [DOC-1 Part XIX · DOC-INV-27 · P19] The storefront disclosure compiler.
 *
 * The ECT Act supplier-information block is a COMPILED artifact, never hand-written
 * prose: every legally required element is sourced from a VALID document record (its
 * submission's extracted fields), or from a fallback the spec names and LABELS
 * (PROPRIETOR = the full name of a trader under their OWN name, which is their trading name;
 * STORE_NAME = the store's own name, only while it is exactly the name a PERSON at Swift
 * confirmed as the seller's business or company name — a business or company is never named by
 * its owner's personal name [owner ruling 10 Nov 2026]; SELF_DECLARED = the address the vendor typed; ACCOUNT = the verified account
 * contact; PLATFORM = the operator block from the ONE OPERATOR constant). A required element with no
 * source leaves the block INCOMPLETE — it never falls back to self-reported text for a
 * legal fact. A store name no person has confirmed yet is PENDING a person's check: the block
 * names nobody (never a self-typed name as a checked one), and no store is held or taken down
 * for it (the go-live rules are unchanged; a person confirms the name in the console).
 * Nothing is stored: the block is derived on every read, so a lapsed licence
 * disappears from the storefront the moment its record leaves VALID.
 *
 * The go-live gate (a vendor cannot activate with an incomplete block) engages by the
 * registry law — when the country's BUSINESS-bucket document types are ACTIVE — so it
 * cannot dark every storefront before the registry is live.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { getKeyProvider } from '../../providers/storage/envelope';
import { unpackAndDecrypt } from './extraction-ledger';
import { BUCKET_OF, IDENTITY_DOC_TYPES, LICENCE_DISCLOSURE_TYPES, OWN_NAME_DOC_TYPE, REGISTRATION_DOC_TYPES } from './doc-registry';
import { vendorTenantForCaller } from '../vendor/vendor-visibility';
import { inoperableSubscriptionWhere } from '../subscription/operate-gate';
import { getTenantId } from '../../plugins/tenant-context';
import { safePublicPhone } from '../../utils/vendor-public-phone';
import { OPERATOR, OPERATOR_ADDRESS } from '../legal/operator';

type Db = Prisma.TransactionClient | PrismaClient;

export type DisclosureSource = 'RECORD' | 'PROPRIETOR' | 'STORE_NAME' | 'SELF_DECLARED' | 'ACCOUNT' | 'PUBLISHED' | 'PLATFORM';
export interface DisclosureElement { value: string; source: DisclosureSource; docType?: string; recordId?: string }
export interface DisclosureBlock {
  complete: boolean;
  /** The required elements with no lawful source — named, so the vendor and the reviewer know what to fix. */
  missing: string[];
  /** [R3 · security review 10 Nov 2026] Elements Swift can source but a PERSON has yet to confirm (today: the store's
   *  name as the seller's business or company name). Shown as nothing until then; never counted as missing, so no
   *  store that was complete becomes incomplete (a live store is never taken down for one). */
  pendingPersonCheck: string[];
  legalName: DisclosureElement | null;
  address: DisclosureElement | null;
  contact: DisclosureElement | null;
  licences: DisclosureElement[];
  operator: { legalName: string; registeredAddress: string; supportEmail: string };
  compiledAt: string;
}

/** The fields the compiler reads, by element — declared in the registry when extraction lands; absent until then. */
const NAME_FIELDS = ['business_name', 'company_name', 'legal_name'];
const ADDRESS_FIELDS = ['principal_place', 'premises_address', 'registered_address'];
// The document types this compiler reads are REGISTRY text (DOC-INV-2): IDENTITY_DOC_TYPES, LICENCE_DISCLOSURE_TYPES.

/** [R3 · owner 15 Oct 2026 · ruling #63] Who operates the platform: the ONE OPERATOR constant (legal/operator.ts),
 *  never configuration — a missing or stale environment variable can neither blank it nor name someone else. */
export function platformOperator(): DisclosureBlock['operator'] {
  return { legalName: OPERATOR.name, registeredAddress: OPERATOR_ADDRESS, supportEmail: OPERATOR.supportEmail };
}

/**
 * [R3 · CAA s.70(1) · owner ruling 10 Nov 2026 · security review] How the seller is named when no record names the
 * business. The seller is the BUSINESS: an owner's personal name is never shown for a registered business or company,
 * and never as "<person> trading as <store>".
 *  - OWN_NAME: a trader under their OWN name — this store's flag, its own-name declaration VALID (a person compared the
 *    store's name with the owner's ID), the owner's ID on file and no business registration: named by their full name,
 *    because that name IS their trading name;
 *  - PERSON_CHECKED: a person at Swift confirmed this store's EXACT current name as the seller's business or company
 *    name (sellerNameCheckedName): named by it. A rename (only ever by a person) needs a new confirmation;
 *  - AWAITING_PERSON: the store's documents are on file but no person has confirmed its name: it names nobody yet;
 *  - NONE: nothing on file to name it by.
 * The store's self-typed name is never presented as a checked legal name, and no account-level record lends it
 * provenance. A person confirms it in the console: approving the store, or its seller-name check (admin routes).
 */
export type SellerNameBasis = 'OWN_NAME' | 'PERSON_CHECKED' | 'AWAITING_PERSON' | 'NONE';
export function sellerNameBasis(
  store: { name: string; tradesUnderOwnName: boolean; sellerNameCheckedName: string | null },
  onFile: { identity: boolean; registration: boolean; ownNameDeclaration: boolean },
  ownerFullName: string,
): SellerNameBasis {
  if (store.tradesUnderOwnName && onFile.ownNameDeclaration && onFile.identity && !onFile.registration && ownerFullName.trim()) return 'OWN_NAME';
  const name = store.name.trim();
  if (name && store.sellerNameCheckedName != null && store.sellerNameCheckedName === name) return 'PERSON_CHECKED';
  return onFile.identity || onFile.registration ? 'AWAITING_PERSON' : 'NONE';
}

type DisclosurePurpose = 'PUBLIC_STOREFRONT' | 'VENDOR_ACTIVATION';
type RecordSource = { id: string; tenantId: string; accountId: string; subjectId: string | null; docType: string; submissionId: string };

/** Only declared non-PII BUSINESS fields enter this reader. Neither purpose
 * needs PERSONAL values: a valid licence's on-file fact is sufficient. */
async function readFields(db: Db, record: RecordSource, codes: readonly string[], purpose: DisclosurePurpose): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!codes.length) return out;
  const runs = await db.extractionRun.findMany({
    where: { tenantId: record.tenantId, submissionId: record.submissionId,
      submission: { userId: record.accountId, docType: record.docType, subjectId: record.subjectId, purgedAt: null } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, wrappedDek: true, fields: {
      where: { tenantId: record.tenantId, submissionId: record.submissionId, fieldCode: { in: [...codes] } },
      select: { runId: true, fieldCode: true, valueCt: true },
    } },
  });
  const kp = getKeyProvider();
  for (const run of runs) {
    const fields = run.fields.filter(f => f.runId === run.id && f.valueCt && !out.has(f.fieldCode));
    if (!fields.length || !run.wrappedDek || !kp) continue;
    const dek = await kp.unwrapDek(Buffer.from(run.wrappedDek));
    const opened: string[] = [];
    for (const f of fields) {
      if (f.valueCt && !out.has(f.fieldCode)) { out.set(f.fieldCode, unpackAndDecrypt(Buffer.from(f.valueCt), dek).toString('utf8')); opened.push(f.fieldCode); }
    }
    // [row 107] Every decrypt of document evidence leaves one audit row on the
    // document's own trail (the custody narrative reads it): which fields, for
    // which purpose — never the values.
    if (opened.length) {
      await db.auditLog.create({ data: {
        userId: null, action: 'DISCLOSURE_FIELDS_DECRYPTED', entity: 'VerificationDocument', entityId: record.submissionId,
        changes: { purpose, docType: record.docType, recordId: record.id, fields: opened },
      } });
    }
  }
  return out;
}

/** The registry law: the block gates go-live only once the country's BUSINESS-bucket types are active. */
export async function disclosureGateEngaged(db: Db, countryCode: string): Promise<boolean> {
  const active = await db.docType.count({ where: { countryCode, isActive: true, bucket: 'BUSINESS' } });
  return active > 0;
}

const DISCLOSURE_VENDOR_SELECT = {
  id: true, tenantId: true, name: true, addressLine1: true, addressLine2: true, publicPhone: true, tradesUnderOwnName: true, sellerNameCheckedName: true,
  owner: { select: { userId: true, user: { select: {
    tenantId: true, countryCode: true, firstName: true, lastName: true, phone: true, isPhoneVerified: true,
  } } } },
} satisfies Prisma.VendorSelect;
type DisclosureVendor = Prisma.VendorGetPayload<{ select: typeof DISCLOSURE_VENDOR_SELECT }>;

/** The direct-link shell may be closed, pending or suspended. Private supplier
 * details have their own current eligibility read before owner/evidence access. */
export async function compilePublicStorefrontDisclosure(db: Db, vendorId: string, now = new Date()): Promise<DisclosureBlock | null> {
  const vendor = await db.vendor.findFirst({
    where: { id: vendorId, ...vendorTenantForCaller(), status: { in: ['ACTIVE', 'CLOSED'] },
      isVerified: true, subscription: { isNot: inoperableSubscriptionWhere(await readFeePause(db), now) },
      owner: { user: { status: 'ACTIVE' } } },
    select: DISCLOSURE_VENDOR_SELECT,
  });
  if (!vendor || vendor.owner.user.tenantId !== vendor.tenantId) return null;
  return compileDisclosure(db, vendor, 'PUBLIC_STOREFRONT', now);
}

/** Internal activation computes completeness before a store is approved. It
 * must name the exact payer and tenant already resolved by the decision path;
 * public lifecycle conditions would strand this transition. */
export async function compileActivationDisclosure(
  db: Db, vendorId: string, authority: { accountId: string; tenantId: string }, now = new Date(),
): Promise<DisclosureBlock> {
  const callerTenant = getTenantId();
  const vendor = authority.accountId && authority.tenantId && (!callerTenant || callerTenant === authority.tenantId)
    ? await db.vendor.findFirst({
      where: { id: vendorId, tenantId: authority.tenantId,
        owner: { userId: authority.accountId, user: { tenantId: authority.tenantId } } },
      select: DISCLOSURE_VENDOR_SELECT,
    }) : null;
  if (!vendor) return { complete: false, missing: ['vendor'], pendingPersonCheck: [], legalName: null, address: null, contact: null, licences: [], operator: platformOperator(), compiledAt: now.toISOString() };
  return compileDisclosure(db, vendor, 'VENDOR_ACTIVATION', now);
}

/** [row 107] The PUBLIC block holds only published values, so it is cached per
 *  store: a decrypt (and its one audit row) happens on a cache miss, never on
 *  every page view. The key is a digest of everything the block is compiled
 *  from — the store's disclosure fields, its owner's, the VALID records (with
 *  their last change), the field registry and the platform operator — so any
 *  change to them is a miss at once; the TTL bounds anything not in the key
 *  (a re-extraction of an unchanged record). Eligibility is NOT cached: the
 *  caller's visibility read runs on every request before this. */
export const PUBLIC_DISCLOSURE_TTL_MS = 10 * 60_000;
const publicDisclosureCache = new Map<string, { at: number; key: string; block: DisclosureBlock }>();
export function resetPublicDisclosureCacheForTests(): void { publicDisclosureCache.clear(); }

async function compileDisclosure(db: Db, vendor: DisclosureVendor, purpose: DisclosurePurpose, now: Date): Promise<DisclosureBlock> {
  const missing: string[] = [];
  const accountId = vendor.owner.userId;
  const records = (await db.documentRecord.findMany({
    // [COMPANY-DOCS Part 3] A paper waiting for its account change names nobody and lends nothing (liveSubmissionWhere):
    // the seller block switches with the change, never a paper at a time.
    where: { tenantId: vendor.tenantId, accountId, status: 'VALID', OR: validExpiryOr('expiresOn', now),
      submission: { userId: accountId, purgedAt: null, ...liveSubmissionWhere() } },
    select: { id: true, tenantId: true, accountId: true, subjectId: true, docType: true, submissionId: true, updatedAt: true,
      submission: { select: { docType: true, subjectId: true } } },
  })).filter(r => r.docType === r.submission.docType && r.subjectId === r.submission.subjectId);
  // The historical map cannot declassify a runtime PERSONAL type. Unknown
  // types/fields, and either PERSONAL classification, never reach unwrap.
  const candidates = records.filter((r) => BUCKET_OF[r.docType] === 'BUSINESS');
  const registry = candidates.length ? await db.docType.findMany({
    where: { countryCode: vendor.owner.user.countryCode, legacyCode: { in: candidates.map(r => r.docType) }, bucket: 'BUSINESS' },
    select: { legacyCode: true, fields: { where: { isPii: false }, select: { fieldCode: true } } },
  }) : [];
  const publicFields = new Map(registry.map(r => [r.legacyCode, new Set(r.fields.map(f => f.fieldCode))]));
  const cacheKey = purpose === 'PUBLIC_STOREFRONT'
    ? createHash('sha256').update(JSON.stringify([vendor, records.map(r => [r.id, r.docType, r.submissionId, r.subjectId, r.updatedAt]), registry, platformOperator()])).digest('hex')
    : null;
  if (cacheKey) {
    const hit = publicDisclosureCache.get(vendor.id);
    if (hit && hit.key === cacheKey && now.getTime() - hit.at < PUBLIC_DISCLOSURE_TTL_MS) return structuredClone(hit.block);
  }
  const business = candidates.filter(r => publicFields.has(r.docType));
  const fieldsFor = (r: RecordSource, codes: readonly string[]) => readFields(db, r, codes.filter(c => publicFields.get(r.docType)?.has(c)), purpose);
  const provenance = (r: RecordSource) => ({ docType: r.docType, ...(purpose === 'VENDOR_ACTIVATION' ? { recordId: r.id } : {}) });
  const identity = records.find((r) => IDENTITY_DOC_TYPES.includes(r.docType));

  // Legal / registered name [R3 · CAA s.70(1) · owner ruling 10 Nov 2026 · security review]: a VALID business record's
  // read name; else sellerNameBasis — the own-name trader's full name (provenance: the declaration signed for THIS
  // store's name), or the store's name only while a person's confirmation is exactly it (no record lends it provenance).
  // Otherwise it names nobody: PENDING a person's check while the owner's ID or the store's registration is on file
  // (the ID alone sufficed before this rule, so a store that was complete is never made incomplete), else missing.
  let legalName: DisclosureElement | null = null;
  for (const r of business) {
    const f = await fieldsFor(r, NAME_FIELDS);
    const v = NAME_FIELDS.map((c) => f.get(c)).find((x) => x && x.trim());
    if (v) { legalName = { value: v.trim(), source: 'RECORD', ...provenance(r) }; break; }
  }
  const pendingPersonCheck: string[] = [];
  if (!legalName) {
    const registration = records.find((r) => REGISTRATION_DOC_TYPES.includes(r.docType));
    const ownNameDeclaration = records.find((r) => r.docType === OWN_NAME_DOC_TYPE);
    const proprietor = `${vendor.owner.user.firstName ?? ''} ${vendor.owner.user.lastName ?? ''}`.trim();
    const basis = sellerNameBasis(vendor, { identity: !!identity, registration: !!registration, ownNameDeclaration: !!ownNameDeclaration }, proprietor);
    if (basis === 'OWN_NAME' && ownNameDeclaration) legalName = { value: proprietor, source: 'PROPRIETOR', ...provenance(ownNameDeclaration) };
    else if (basis === 'PERSON_CHECKED') legalName = { value: vendor.name.trim(), source: 'STORE_NAME' };
    else if (basis === 'AWAITING_PERSON') pendingPersonCheck.push('legalName');
  }
  if (!legalName && !pendingPersonCheck.includes('legalName')) missing.push('legalName');

  // Principal geographic address: a business record's read address; else the self-declared address, labelled.
  let address: DisclosureElement | null = null;
  for (const r of business) {
    const f = await fieldsFor(r, ADDRESS_FIELDS);
    const v = ADDRESS_FIELDS.map((c) => f.get(c)).find((x) => x && x.trim());
    if (v) { address = { value: v.trim(), source: 'RECORD', ...provenance(r) }; break; }
  }
  if (!address) {
    const declared = [vendor.addressLine1, vendor.addressLine2].filter((x) => x && x.trim()).join(', ');
    if (declared) address = { value: declared, source: 'SELF_DECLARED' };
  }
  if (!address) missing.push('address');

  // Electronic contact. The requirement is met by the owner's VERIFIED account
  // contact, but that number is private: [row 107] the public block shows only
  // the contact the store itself PUBLISHED (none → withheld; the platform
  // operator block below is always reachable). Activation sees the account
  // contact, for completeness only.
  const accountContact = vendor.owner.user.isPhoneVerified && vendor.owner.user.phone ? vendor.owner.user.phone : null;
  if (!accountContact) missing.push('contact');
  const published = safePublicPhone(vendor.publicPhone);
  const contact: DisclosureElement | null = purpose === 'PUBLIC_STOREFRONT'
    ? (published ? { value: published, source: 'PUBLISHED' } : null)
    : (accountContact ? { value: accountContact, source: 'ACCOUNT' } : null);

  // PERSONAL licences truthfully disclose only their on-file fact. Their
  // numbers are not required for completeness in either caller, so neither
  // caller needs a PERSONAL read or an associated privileged audit capability.
  // [R3 · legal research D10] The PUBLIC storefront never shows a licence
  // NUMBER, business or personal — only that one is on file — so the public
  // read never opens a licence's fields at all.
  const licences: DisclosureElement[] = [];
  for (const r of records.filter((x) => LICENCE_DISCLOSURE_TYPES.includes(x.docType))) {
    const number = purpose === 'VENDOR_ACTIVATION'
      ? [...(await fieldsFor(r, ['licence_number', 'certificate_number', 'permit_number'])).values()].find((x) => x && x.trim())
      : undefined;
    licences.push({ value: number ? number.trim() : 'on file', source: 'RECORD', ...provenance(r) });
  }

  const operator = platformOperator();

  const block: DisclosureBlock = { complete: missing.length === 0, missing, pendingPersonCheck, legalName, address, contact, licences, operator, compiledAt: now.toISOString() };
  if (cacheKey) {
    publicDisclosureCache.set(vendor.id, { at: now.getTime(), key: cacheKey, block: structuredClone(block) });
    if (publicDisclosureCache.size > 5000) publicDisclosureCache.delete(publicDisclosureCache.keys().next().value!);
  }
  return block;
}
