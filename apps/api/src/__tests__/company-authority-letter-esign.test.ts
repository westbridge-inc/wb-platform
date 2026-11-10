/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority, signed on the director's (or the
 * owner's) OWN phone: the person signing up a company's store account (or a registered business's manager) fills a short
 * form; Swift writes a clean one-page letter; texts the director a single-use link (only its SHA-256 kept, 72 hours);
 * the director confirms a code texted to THAT number and signs with a finger; the signed page is stored exactly like an
 * ID (scanned, encrypted, owned by the account holder, served only through the reviewer's render link) and filed as the
 * account's letter of authority, which a person at Swift still checks. Every step is audited, with no name or number in
 * the audit row. The paper letter upload stays the fallback (Part 1).
 */
import net from 'node:net';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { PNG } from 'pngjs';
import { PDFParse } from 'pdf-parse';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { decryptBuffer, getKeyProvider, resetKeyProviderForTests } from '../providers/storage/envelope';
import { getStorageProvider } from '../providers/storage/storage-provider';
import { devChannelLog } from '../providers/notifications/channels';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { seedDocRegistry, PERSON_ONLY_DOC_TYPES } from '../modules/verification/doc-registry';
import { resolveVerificationObject } from '../modules/verification/object-authority';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { authorityLetterPublicRoutes, authorityLetterVendorRoutes } from '../modules/vendor/authority-letter/authority-letter.routes';
import { LETTER_AUDIT, secretDigest, sweepAuthorityLetters } from '../modules/vendor/authority-letter/authority-letter.service';
import {
  CODE_MAX_ATTEMPTS, ENDED_RETENTION_DAYS, LINK_TTL_MS, MAX_RESENDS, authorityLetterWords, cleanField, letterLinkSms, signingLink,
} from '../modules/vendor/authority-letter/letter';
import { renderSignedLetterPdf } from '../modules/vendor/authority-letter/letter-pdf';
import { cleanSignature } from '../modules/vendor/authority-letter/letter-signature';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { ManualReviewKycProvider } from '../providers/kyc/kyc-provider';
import { reviewerTypedFields } from '../modules/verification/identity-signal-policy';

// ---------------------------------------------------------------------------------------------------------------------
// Pictures: a drawn signature, a blank pad, and a PNG carrying a text chunk of its own.
// ---------------------------------------------------------------------------------------------------------------------
function drawnSignature(width = 320, height = 120): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0); // transparent, like the page's canvas
  for (let x = 20; x < width - 20; x++) {
    const y = Math.round(height / 2 + Math.sin(x / 15) * (height / 4));
    for (let d = -2; d <= 2; d++) {
      const i = ((y + d) * width + x) * 4;
      png.data[i] = 10; png.data[i + 1] = 10; png.data[i + 2] = 40; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
const blankPad = () => { const png = new PNG({ width: 320, height: 120 }); png.data.fill(0); return PNG.sync.write(png); };
/** A PNG with a tEXt chunk after IHDR (what a sender could smuggle along). */
function withTextChunk(png: Buffer, text: string): Buffer {
  const body = Buffer.concat([Buffer.from('tEXt'), Buffer.from(`Comment\0${text}`, 'latin1')]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
const pdfText = async (pdf: Buffer) => {
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try { const t = await parser.getText(); return { pages: t.total, text: t.text.replace(/\s+/g, ' ') }; } finally { await parser.destroy(); }
};

const FORM = {
  businessName: 'Kariba Fried Chicken Ltd.', registrationNumber: 'C-12345', requesterName: 'Asha Ramdin', requesterRole: 'Operations Manager',
  signerName: 'Devon Persaud',
};

describe('[COMPANY-DOCS PART 2] the letter Swift writes', () => {
  const at = new Date('2026-11-10T15:00:00Z');

  it('a company’s letter: who authorises whom, for which company and registration number, to do what, and the date', () => {
    const w = authorityLetterWords('COMPANY', FORM, at);
    const all = w.lines.join(' ');
    expect(w.title).toBe('Letter of authority: Swift store account (company)');
    expect(all).toContain('Date: 10 November 2026');
    expect(all).toContain('Company: Kariba Fried Chicken Ltd.');
    expect(all).toContain('Company registration number: C-12345');
    expect(all).toContain('I, Devon Persaud, a director of Kariba Fried Chicken Ltd., confirm that the company authorises Asha Ramdin (Operations Manager)');
    // what the account holder may do: orders, menus and items, staff, the weekly fee, the account
    for (const power of ['take and manage orders', 'menus, items and prices', 'add and remove staff', 'weekly Swift fee', 'deal with Swift about the account']) expect(all).toContain(power);
    expect(all).toContain('Asha Ramdin is the only person who manages the company’s Swift account');
    expect(all).toContain('until the company tells Swift in writing');
    expect(all).toContain('on my own phone, after confirming a code Swift texted to my number');
    expect(all).toMatch(/^To: Westbridge Inc\. \(Swift\), /);
    // short: one page of plain words
    expect(w.text.length).toBeLessThan(1400);
  });

  it('a manager’s letter is signed by the business’s owner, as on its Business Registration', () => {
    const w = authorityLetterWords('MANAGER', { ...FORM, businessName: 'Ramdin General Store' }, at);
    const all = w.lines.join(' ');
    expect(w.title).toBe('Letter of authority: Swift store account (business owner)');
    expect(all).toContain('Business registration number: C-12345');
    expect(all).toContain('I, Devon Persaud, the owner of Ramdin General Store as shown on its Business Registration, authorise Asha Ramdin (Operations Manager)');
    expect(all).toContain('until I tell Swift in writing');
  });

  it('the SHA-256 is of exactly the words shown (title and lines), and a typed newline cannot add a line', () => {
    const w = authorityLetterWords('COMPANY', { ...FORM, signerName: 'Devon\nPersaud\u0000' }, at);
    expect(w.sha256).toBe(createHash('sha256').update([w.title, ...w.lines].join('\n'), 'utf8').digest('hex'));
    expect(w.text).toBe([w.title, ...w.lines].join('\n'));
    expect(w.lines).toHaveLength(authorityLetterWords('COMPANY', FORM, at).lines.length);
    expect(cleanField('  Devon \n\t Persaud ')).toBe('Devon Persaud');
    expect(authorityLetterWords('COMPANY', FORM, at).sha256).not.toBe(authorityLetterWords('COMPANY', { ...FORM, registrationNumber: 'C-12346' }, at).sha256);
  });

  it('the text names who asks and for which business, the secret sits after #, and nothing about the signer is in it', () => {
    const link = signingLink('A'.repeat(43), 'https://swiftgy.com/');
    expect(link).toBe(`https://swiftgy.com/sign-letter#${'A'.repeat(43)}`);
    const sms = letterLinkSms({ requesterName: 'Asha Ramdin', businessName: 'Kariba’s Chicken', basis: 'COMPANY', link });
    expect(sms).toContain('Asha asked you to sign a letter of authority for Kariba\'s Chicken');
    expect(sms).toContain(link);
    expect(sms).not.toMatch(/Devon|Persaud|\+592/);
    expect(sms).toMatch(/^[\x20-\x7e]+$/); // GSM-plain: one cheap encoding
  });
});

describe('[COMPANY-DOCS PART 2] the signature and the signed page', () => {
  it('a drawn PNG is re-encoded (nothing the sender added rides along); a blank pad, a non-PNG or a huge file is refused', async () => {
    const sent = withTextChunk(drawnSignature(), 'SMUGGLED-META');
    const clean = await cleanSignature(dataUrl(sent));
    expect(clean.png.subarray(1, 4).toString()).toBe('PNG');
    expect(clean.png.includes(Buffer.from('SMUGGLED-META'))).toBe(false);
    expect(clean.sha256).toBe(createHash('sha256').update(sent).digest('hex'));
    await expect(cleanSignature(dataUrl(blankPad()))).rejects.toMatchObject({ code: 'SIGNATURE_NOT_VALID' });
    await expect(cleanSignature(`data:image/png;base64,${Buffer.from('%PDF-1.4 not a picture').toString('base64')}`)).rejects.toMatchObject({ code: 'SIGNATURE_NOT_VALID' });
    await expect(cleanSignature(Buffer.alloc(500_000, 1).toString('base64'))).rejects.toMatchObject({ code: 'SIGNATURE_NOT_VALID' });
    await expect(cleanSignature('not base64 at all!')).rejects.toMatchObject({ code: 'SIGNATURE_NOT_VALID' });
  });

  it('ONE page: the exact words, the signature, the name, and the signing record (code check, number, address digest, browser, SHA-256)', async () => {
    const w = authorityLetterWords('COMPANY', FORM, new Date('2026-11-10T15:00:00Z'));
    const sig = await cleanSignature(dataUrl(drawnSignature()));
    const pdf = await renderSignedLetterPdf({
      title: w.title, lines: w.lines, signaturePng: sig.png, signerName: 'Devon Persaud', signerKind: 'director', signerPhone: '+5920600001', requesterName: 'Asha Ramdin',
      codeVerifiedAt: new Date('2026-11-11T13:00:00Z'), signedAt: new Date('2026-11-11T13:02:00Z'), letterSha256: w.sha256, requestId: 'req_test_1',
      ipDigest: 'ab'.repeat(32), userAgent: 'Mozilla/5.0 (iPhone) TestBrowser',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { pages, text } = await pdfText(pdf);
    expect(pages).toBe(1);
    expect(text).toContain(w.title);
    for (const line of w.lines) expect(text).toContain(line.replace(/\s+/g, ' '));
    expect(text).toContain('Signature of the director:');
    expect(text).toContain('Name: Devon Persaud');
    expect(text).toContain('Signed electronically on Swift by Devon Persaud (director)');
    expect(text).toContain('A code Swift texted to +5920600001 was confirmed');
    expect(text).toContain(`Network address (keyed digest): ${'ab'.repeat(32)}`);
    expect(text).toContain('TestBrowser');
    expect(text).toContain(`SHA-256 of the letter's words: ${w.sha256}`);
    expect(text).toContain('req_test_1');
    // [review F2] the page says plainly that Swift never checked the number: the account holder typed it
    expect(text).toContain('NOT CHECKED BY SWIFT: the number +5920600001 was typed by Asha Ramdin, the person who asked for this letter.');
    expect(text).toContain('This signature alone does not prove that the signer is a director of the company');
    expect(pdf.includes(Buffer.from('/Subtype /Image'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Against the database: the account holder's form, the link, the code, the signature, the stored letter, the audit.
// ---------------------------------------------------------------------------------------------------------------------
const RUN = wordFreeTag(8);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'authority-letter-esign-test');
let app: FastifyInstance;
const users: string[] = [];
const servers: net.Server[] = [];
let seq = 0;

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 9).toString('base64'));
  vi.stubEnv('CONSENT_IP_PEPPER', 'p'.repeat(40));
  vi.stubEnv('AUTHORITY_LETTER_ESIGN', '1');
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(authorityLetterVendorRoutes, { prefix: '/api/v1/vendor/authority-letters' });
  await app.register(authorityLetterPublicRoutes, { prefix: '/api/v1/public/authority-letter' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
});

afterEach(async () => {
  for (const name of ['MALWARE_SCAN', 'CLAMD_HOST', 'CLAMD_PORT']) delete process.env[name];
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    const requests = (await app.prisma.authorityLetterRequest.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((r) => r.id);
    await app.prisma.authorityLetterRequest.deleteMany({ where: { userId: { in: users } } });
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
    await app.prisma.uploadScanDebt.deleteMany({ where: { fileKey: { contains: '/verification/' } , surface: 'verification', sealed: true, createdAt: { gt: new Date(Date.now() - DAY) } } }).catch(() => undefined);
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendors } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendors } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
    void requests;
  });
  await app.close();
});

type Person = { userId: string; token: string; vendorId: string; phone: string };
async function person(firstName = 'Asha', lastName = 'Ramdin'): Promise<Person> {
  seq += 1;
  const phone = testPhone();
  const user = await system(() => app.prisma.user.create({ data: {
    phone, firstName, lastName, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `al-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token, vendorId: '', phone };
}
/** A reviewer at Swift (every grant). */
async function reviewer(): Promise<string> {
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Letter', lastName: 'Reviewer', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  users.push(admin.id);
  return admin.id;
}
const call = (method: 'GET' | 'POST', url: string, o: { token: string; vendorId?: string } | null, payload?: Record<string, unknown>, headers: Record<string, string> = {}) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { ...(o ? { authorization: `Bearer ${o.token}` } : {}), ...(o?.vendorId ? { 'x-vendor-id': o.vendorId } : {}), ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
});
async function storeAccount(accountBasis?: 'COMPANY' | 'MANAGER', vendorType = 'RESTAURANT'): Promise<Person> {
  const o = await person();
  const quote = await signupQuote(app.prisma, o.userId, { role: 'VENDOR', vendorType });
  const res = await call('POST', '/api/v1/partner/become', o, {
    role: 'VENDOR', acceptAgreement: true, weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode },
    business: { name: `Letter Co ${RUN} ${seq}`, vendorType, phone: '+5926000000', addressLine1: '1 Letter Road', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, ...(accountBasis ? { accountBasis } : {}) },
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  o.vendorId = (await system(() => app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: o.userId } }, select: { id: true } }))).id;
  o.token = app.jwt.sign({ userId: o.userId, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: o.userId, token: o.token, refreshToken: nanoid(24), deviceId: `al-owner-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return o;
}
const textsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);
const linkTokenIn = (body: string) => /\/sign-letter#([A-Za-z0-9_-]{43})/.exec(body)?.[1] ?? null;
const codeIn = (body: string) => /\b(\d{6})\b/.exec(body)?.[1] ?? null;
const audits = (requestId: string) => system(() => app.prisma.auditLog.findMany({ where: { entity: 'AuthorityLetterRequest', entityId: requestId }, orderBy: { createdAt: 'asc' } }));
const rowOf = (id: string) => system(() => app.prisma.authorityLetterRequest.findUniqueOrThrow({ where: { id } }));
const ask = async (o: Person, over: Record<string, unknown> = {}) => call('POST', '/api/v1/vendor/authority-letters', o, { ...FORM, signerPhone: over['signerPhone'] ?? await freshNumber(), ...over });
const pub = (path: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) => call('POST', `/api/v1/public/authority-letter/${path}`, null, payload, headers);

/** A signer's number with no SMS counters left over from an earlier local run (the numbers are reused across runs). */
async function freshNumber(): Promise<string> {
  const phone = testPhone();
  const keys = await app.redis.keys(`*${phone}`);
  if (keys.length > 0) await app.redis.del(...keys);
  return phone;
}

/** Ask, then read the link's secret from the text Swift sent the signer. */
async function sentLetter(o: Person, over: Record<string, unknown> = {}) {
  const signerPhone = String(over['signerPhone'] ?? await freshNumber());
  const res = await ask(o, { ...over, signerPhone });
  expect(res.statusCode, res.body).toBe(201);
  const texts = textsTo(signerPhone);
  const token = linkTokenIn(texts.at(-1)!.body)!;
  return { id: res.json().data.request.id as string, token, signerPhone, view: res.json().data.request };
}
async function verified(token: string, signerPhone: string) {
  expect((await pub('code', { token })).statusCode).toBe(200);
  const code = codeIn(textsTo(signerPhone).at(-1)!.body)!;
  const res = await pub('verify', { token, code });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.signingKey as string;
}

describe('[COMPANY-DOCS PART 2] the account holder asks: the form, the phone rule, the link', () => {
  it('while the switch is off (until the owner approves the privacy wording) nobody can start or resend a letter: paper only', async () => {
    const o = await storeAccount('COMPANY');
    vi.stubEnv('AUTHORITY_LETTER_ESIGN', '');
    try {
      const signerPhone = await freshNumber();
      const res = await ask(o, { signerPhone });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('AUTHORITY_LETTER_ESIGN_OFF');
      expect(textsTo(signerPhone)).toHaveLength(0);
      expect((await call('GET', '/api/v1/vendor/authority-letters', o)).json().data).toMatchObject({ enabled: false, request: null });
      expect(await system(() => app.prisma.authorityLetterRequest.count({ where: { userId: o.userId } }))).toBe(0);
    } finally {
      vi.stubEnv('AUTHORITY_LETTER_ESIGN', '1');
    }
    expect((await call('GET', '/api/v1/vendor/authority-letters', o)).json().data.enabled).toBe(true);
  });

  it('a company’s account holder asks the director: the letter is written, the director is texted a single-use link, the page says who it waits for', async () => {
    const o = await storeAccount('COMPANY');
    const signerPhone = await freshNumber();
    const res = await ask(o, { signerPhone: signerPhone.replace(/^(\+592)(\d{3})/, '$1 $2-') }); // typed with a space and a dash
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json().data.request;
    expect(view).toMatchObject({ status: 'SENT', docType: 'company_authority_letter', signerKind: 'director', signerFirstName: 'Devon', signerPhoneEnding: signerPhone.slice(-3), resendsLeft: MAX_RESENDS });
    expect(view).not.toHaveProperty('signerPhone');
    // the text went to the director's number, with the secret after '#'
    const texts = textsTo(signerPhone);
    expect(texts).toHaveLength(1);
    const token = linkTokenIn(texts[0]!.body);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await rowOf(view.id);
    // only the SHA-256 of the secret is kept, the link lives 72 hours
    expect(row.tokenHash).toBe(secretDigest(token!));
    expect(JSON.stringify(row)).not.toContain(token!);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(LINK_TTL_MS - 5_000);
    expect(row.signerPhone).toBe(signerPhone);
    expect(row.letterSha256).toBe(createHash('sha256').update(row.letterText, 'utf8').digest('hex'));
    expect(row.letterText).toContain(`authorises Asha Ramdin (Operations Manager)`);
    // GET shows the same request
    const got = await call('GET', '/api/v1/vendor/authority-letters', o);
    expect(got.json().data).toMatchObject({ accountBasis: 'COMPANY', request: { id: view.id, status: 'SENT', signerFirstName: 'Devon' } });
    // audited: created, sent; never a name, a number or the secret in the audit row
    const trail = await audits(view.id);
    expect(trail.map((a) => a.action)).toEqual([LETTER_AUDIT.created, LETTER_AUDIT.sent]);
    expect(trail[0]!.userId).toBe(o.userId);
    const said = JSON.stringify(trail);
    for (const secretish of [signerPhone, 'Devon', 'Persaud', token!, row.signerPhone.slice(1)]) expect(said).not.toContain(secretish);
  });

  it('a manager asks the business’s owner for owner_authority_letter', async () => {
    const o = await storeAccount('MANAGER', 'STORE');
    const res = await ask(o);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.request).toMatchObject({ docType: 'owner_authority_letter', signerKind: 'owner' });
    expect((await rowOf(res.json().data.request.id)).letterText).toContain('the owner of Kariba Fried Chicken Ltd. as shown on its Business Registration');
  });

  it('the director’s number must differ from the account holder’s own and from every number on the store’s team', async () => {
    const o = await storeAccount('COMPANY');
    const own = await ask(o, { signerPhone: o.phone });
    expect(own.statusCode).toBe(400);
    expect(own.json().error.code).toBe('SIGNER_PHONE_IS_YOURS');
    const member = await person('Team', 'Member');
    await system(() => app.prisma.vendorStaff.create({ data: { vendorId: o.vendorId, userId: member.userId, role: 'STAFF', invitedBy: o.userId } }));
    const team = await ask(o, { signerPhone: member.phone });
    expect(team.statusCode).toBe(400);
    expect(team.json().error.code).toBe('SIGNER_PHONE_ON_TEAM');
    const foreign = await ask(o, { signerPhone: '+14155550100' });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('SIGNER_PHONE_NOT_VALID');
    // and the director is someone else than the person asking
    const self = await ask(o, { signerName: 'asha  RAMDIN' });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('SIGNER_IS_YOU');
    // nothing was texted or stored for a refused number
    expect(textsTo(o.phone)).toHaveLength(0);
    expect(textsTo(member.phone)).toHaveLength(0);
    expect(await system(() => app.prisma.authorityLetterRequest.count({ where: { userId: o.userId } }))).toBe(0);
  });

  it('only the account holder of a company or manager account: an owner’s account, a staff member and a customer are refused', async () => {
    const owner = await storeAccount();
    const notNeeded = await ask(owner);
    expect(notNeeded.statusCode).toBe(409);
    const co = await storeAccount('COMPANY');
    const staff = await person('Staff', 'Person');
    await system(() => app.prisma.vendorStaff.create({ data: { vendorId: co.vendorId, userId: staff.userId, role: 'MANAGER', invitedBy: co.userId } }));
    staff.token = app.jwt.sign({ userId: staff.userId, role: 'VENDOR_STAFF', jti: nanoid(8) });
    await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: staff.userId, token: staff.token, refreshToken: nanoid(24), deviceId: `al-staff-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
    expect((await ask({ ...staff, vendorId: co.vendorId })).statusCode).toBe(403);
    const customer = await person('Just', 'Customer');
    expect((await ask(customer)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/vendor/authority-letters', null)).statusCode).toBe(401);
  });
});

describe('[COMPANY-DOCS PART 2] the director signs on their own phone', () => {
  it('open → code → sign: the signed page is filed as the account’s letter of authority, stored and protected like an ID', async () => {
    const o = await storeAccount('COMPANY');
    const { id, token, signerPhone } = await sentLetter(o);
    // the page shows exactly the stored words
    const opened = await pub('open', { token });
    expect(opened.statusCode, opened.body).toBe(200);
    const page = opened.json().data;
    const row = await rowOf(id);
    expect([page.title, ...page.lines].join('\n')).toBe(row.letterText);
    expect(page).toMatchObject({ status: 'SENT', signerName: 'Devon Persaud', phoneEnding: signerPhone.slice(-3), signerKind: 'director' });
    expect(JSON.stringify(page)).not.toContain(signerPhone);
    await pub('open', { token }); // a second open is not a second audit row
    // a sign without the code is refused
    const early = await pub('sign', { token, signingKey: 'x'.repeat(43), signature: dataUrl(drawnSignature()), agree: true });
    expect(early.statusCode).toBe(403);
    // the code goes to THAT number only
    const before = devChannelLog.length;
    const signingKey = await verified(token, signerPhone);
    const sent = devChannelLog.slice(before).filter((e) => e.channel === 'sms');
    expect(sent.map((e) => e.to)).toEqual([signerPhone]);
    expect((await rowOf(id)).codeHash).toBeNull(); // used once
    // the tick is required
    expect((await pub('sign', { token, signingKey, signature: dataUrl(drawnSignature()) })).statusCode).toBe(400);
    const signed = await pub('sign', { token, signingKey, signature: dataUrl(drawnSignature()), agree: true }, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) DirectorPhone', 'x-forwarded-for': '203.0.113.9' });
    expect(signed.statusCode, signed.body).toBe(201);
    const done = await rowOf(id);
    expect(done.status).toBe('SIGNED');
    expect(done.signerUserAgent).toContain('DirectorPhone');
    expect(done.signerIpHmac).toMatch(/^[0-9a-f]{64}$/); // a keyed digest, never the address
    expect(JSON.stringify(done)).not.toContain('127.0.0.1');
    expect(done.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(done.signingKeyHash).toBeNull();
    // filed as the account holder's letter of authority, waiting for a PERSON
    const doc = await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: done.documentId! } }));
    expect(doc).toMatchObject({ userId: o.userId, docType: 'company_authority_letter', status: 'PENDING', fileUrl: done.pdfFileKey });
    expect(PERSON_ONLY_DOC_TYPES.has(doc.docType)).toBe(true);
    // stored like an ID: in the account holder's verification folder, encrypted (the bucket holds ciphertext), owned by them,
    // and the reviewer's render path accepts it for exactly this document
    expect(doc.fileUrl).toContain(`verification/${o.userId}/`);
    const object = await system(() => resolveVerificationObject(app.prisma, { fileKey: doc.fileUrl, userId: o.userId, documentId: doc.id }));
    expect(object).toMatchObject({ createdBy: o.userId, mimeType: 'application/pdf' });
    const ciphertext = await getStorageProvider().getObject(doc.fileUrl);
    expect(ciphertext.subarray(0, 5).toString()).not.toBe('%PDF-');
    const pdf = decryptBuffer(ciphertext, await getKeyProvider()!.unwrapDek(Buffer.from(object.wrappedDek!)), Buffer.from(object.iv), Buffer.from(object.authTag));
    expect(createHash('sha256').update(pdf).digest('hex')).toBe(object.sha256);
    const { pages, text } = await pdfText(pdf);
    expect(pages).toBe(1);
    expect(text).toContain('Signed electronically on Swift by Devon Persaud (director)');
    expect(text).toContain(signerPhone);
    expect(text).toContain(done.letterSha256);
    expect(text).toContain(done.signerIpHmac!);
    for (const line of row.letterText.split('\n')) expect(text).toContain(line.replace(/\s+/g, ' '));
    // audited, step by step, with no name or number
    const trail = await audits(id);
    expect(trail.map((a) => a.action)).toEqual([LETTER_AUDIT.created, LETTER_AUDIT.sent, LETTER_AUDIT.opened, LETTER_AUDIT.codeSent, LETTER_AUDIT.codeVerified, LETTER_AUDIT.signed]);
    expect(JSON.stringify(trail)).not.toMatch(new RegExp(`${signerPhone.slice(1)}|Devon|Persaud`));
    // the account holder sees it signed
    expect((await call('GET', '/api/v1/vendor/authority-letters', o)).json().data.request).toMatchObject({ status: 'SIGNED', documentId: doc.id });
    // the link is single-use: it signs nothing again, and no code is sent for it
    expect((await pub('open', { token })).json().data.status).toBe('SIGNED');
    expect((await pub('code', { token })).statusCode).toBe(409);
    expect((await pub('sign', { token, signingKey, signature: dataUrl(drawnSignature()), agree: true })).statusCode).toBe(409);
    expect(await system(() => app.prisma.verificationDocument.count({ where: { userId: o.userId, docType: 'company_authority_letter' } }))).toBe(1);
    // and a new request is refused while the letter waits for review
    expect((await ask(o)).statusCode).toBe(409);
    // [review F2] the signed letter is NOT proof on its own: a person must confirm the signer is a director, say how and
    // what they checked, or it cannot be approved
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualReviewKycProvider());
    const admin = await reviewer();
    await expect(service.approveDocument(doc.id, admin, undefined, undefined, { required: true })).rejects.toMatchObject({ code: 'AUTHORITY_CONFIRMATION_REQUIRED' });
    await expect(service.approveDocument(doc.id, admin, undefined, undefined, { authorityConfirmed: { method: 'REGISTER_LISTING', reason: 'ok' } })).rejects.toMatchObject({ code: 'AUTHORITY_CONFIRMATION_REQUIRED' });
    await expect(service.approveDocument(doc.id, admin, undefined, undefined, { authorityConfirmed: { method: 'FORM_PHONE' as never, reason: 'The form said so, it is fine' } })).rejects.toMatchObject({ code: 'AUTHORITY_CONFIRMATION_REQUIRED' });
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('PENDING');
    const approved = await service.approveDocument(doc.id, admin, undefined, undefined, { required: true, authorityConfirmed: { method: 'CALLED_ON_FOUND_NUMBER', reason: 'Called the company on its listed number; it confirmed the director' } });
    expect(approved.status).toBe('APPROVED');
    const decision = await system(() => app.prisma.reviewDecision.findFirstOrThrow({ where: { case: { submissionId: doc.id }, outcome: 'APPROVE' } }));
    expect(decision.internalNote).toBe('Signer confirmed by a person: called the company or business on a number Swift found itself (not the letter’s or the form’s). Checked: Called the company on its listed number; it confirmed the director');
  });

  it('[review F2] the console must ask how the signer of ANY letter of authority was confirmed (paper or in Swift)', () => {
    expect(reviewerTypedFields('company_authority_letter')).toEqual(['authorityConfirmed']);
    expect(reviewerTypedFields('owner_authority_letter')).toEqual(['authorityConfirmed']);
    expect(reviewerTypedFields('account_holder_id')).not.toContain('authorityConfirmed');
  });

  it('a wrong code is refused and audited; five wrong codes lock it; a used or expired code never signs', async () => {
    const o = await storeAccount('COMPANY');
    const { id, token, signerPhone } = await sentLetter(o);
    expect((await pub('code', { token })).statusCode).toBe(200);
    const code = codeIn(textsTo(signerPhone).at(-1)!.body)!;
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await pub('verify', { token, code: wrong });
    expect(first.statusCode).toBe(400);
    expect((await audits(id)).filter((a) => a.action === LETTER_AUDIT.codeRefused)).toHaveLength(1);
    for (let i = 1; i < CODE_MAX_ATTEMPTS; i++) await pub('verify', { token, code: wrong });
    // locked: even the right code no longer works
    expect((await pub('verify', { token, code })).statusCode).toBe(429);
    // a fresh code (after the per-number cool-down) works, once; an expired one never
    await system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { codeHash: null } }));
    await app.redis.del(`otp_rate:${signerPhone}`);
    expect((await pub('code', { token })).statusCode).toBe(200);
    const fresh = codeIn(textsTo(signerPhone).at(-1)!.body)!;
    await system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { codeExpiresAt: new Date(Date.now() - 1000) } }));
    const stale = await pub('verify', { token, code: fresh });
    expect(stale.statusCode).toBe(400);
    expect(stale.json().error.code).toBe('CODE_EXPIRED');
    expect((await rowOf(id)).codeVerifiedAt).toBeNull();
    // the per-number cool-down of the sign-in codes applies to these codes too
    await system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { codeHash: null } }));
    await app.redis.del(`otp_rate:${signerPhone}`);
    expect((await pub('code', { token })).statusCode).toBe(200);
    expect((await pub('code', { token })).statusCode).toBe(429);
  });

  it('72 hours later the link has expired (audited); a resend texts a new link, the old one dies; resends are limited', async () => {
    const o = await storeAccount('COMPANY');
    const { id, token, signerPhone } = await sentLetter(o);
    await system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000), lastSentAt: new Date(Date.now() - 120_000) } }));
    const late = await pub('open', { token });
    expect(late.statusCode).toBe(410);
    expect((await rowOf(id)).status).toBe('EXPIRED');
    expect((await audits(id)).map((a) => a.action)).toContain(LETTER_AUDIT.expired);
    expect((await call('GET', '/api/v1/vendor/authority-letters', o)).json().data.request.status).toBe('EXPIRED');
    // resend: a new secret, 72 hours again; the old link is no link at all
    const again = await call('POST', `/api/v1/vendor/authority-letters/${id}/resend`, o);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.request).toMatchObject({ status: 'SENT', resendsLeft: MAX_RESENDS - 1 });
    const newToken = linkTokenIn(textsTo(signerPhone).at(-1)!.body)!;
    expect(newToken).not.toBe(token);
    expect((await pub('open', { token })).statusCode).toBe(404);
    expect((await pub('open', { token: newToken })).statusCode).toBe(200);
    expect((await audits(id)).map((a) => a.action)).toContain(LETTER_AUDIT.resent);
    // one a minute
    const tooSoon = await call('POST', `/api/v1/vendor/authority-letters/${id}/resend`, o);
    expect(tooSoon.statusCode).toBe(429);
    // and only MAX_RESENDS in all
    for (let i = 1; i < MAX_RESENDS; i++) {
      await system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { lastSentAt: new Date(Date.now() - 120_000) } }));
      expect((await call('POST', `/api/v1/vendor/authority-letters/${id}/resend`, o)).statusCode).toBe(200);
    }
    await system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { lastSentAt: new Date(Date.now() - 120_000) } }));
    const over = await call('POST', `/api/v1/vendor/authority-letters/${id}/resend`, o);
    expect(over.statusCode).toBe(429);
    // another account can never resend or cancel it
    const other = await storeAccount('COMPANY');
    expect((await call('POST', `/api/v1/vendor/authority-letters/${id}/cancel`, other)).statusCode).toBe(404);
    // the account holder withdraws it: the link stops working
    expect((await call('POST', `/api/v1/vendor/authority-letters/${id}/cancel`, o)).json().data.request.status).toBe('CANCELLED');
    expect((await pub('open', { token: linkTokenIn(textsTo(signerPhone).at(-1)!.body)! })).statusCode).toBe(404);
  });

  it('a new request replaces one still waiting (its link dies); a link nobody made is refused without a lookup oracle', async () => {
    const o = await storeAccount('COMPANY');
    const first = await sentLetter(o);
    const second = await sentLetter(o);
    expect((await rowOf(first.id)).status).toBe('CANCELLED');
    expect((await pub('open', { token: first.token })).statusCode).toBe(404);
    expect((await pub('open', { token: second.token })).statusCode).toBe(200);
    expect((await pub('open', { token: 'B'.repeat(43) })).statusCode).toBe(404);
    expect((await pub('open', { token: 'short' })).statusCode).toBe(404);
  });

  it('the malware scan applies to the signed letter as to any document: a signature found refuses it and nothing is filed', async () => {
    const o = await storeAccount('COMPANY');
    const { id, token, signerPhone } = await sentLetter(o);
    const signingKey = await verified(token, signerPhone);
    const server = net.createServer((socket) => {
      let data = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.toString('utf8').startsWith('zPING\0')) { socket.end('PONG\0'); return; }
        let at = 'zINSTREAM\0'.length;
        for (;;) {
          if (data.length < at + 4) return;
          const length = data.readUInt32BE(at);
          if (length === 0) break;
          if (data.length < at + 4 + length) return;
          at += 4 + length;
        }
        socket.end('stream: Eicar-Test-Signature FOUND\0');
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    Object.assign(process.env, { MALWARE_SCAN: 'clamd', CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String((server.address() as net.AddressInfo).port) });
    const res = await pub('sign', { token, signingKey, signature: dataUrl(drawnSignature()), agree: true });
    expect(res.statusCode).toBe(422);
    expect((await rowOf(id)).status).toBe('SENT');
    expect(await system(() => app.prisma.verificationDocument.count({ where: { userId: o.userId } }))).toBe(0);
    // nothing was filed, so the same key may try again once the scanner is happy
    for (const name of ['MALWARE_SCAN', 'CLAMD_HOST', 'CLAMD_PORT']) delete process.env[name];
    expect((await pub('sign', { token, signingKey, signature: dataUrl(drawnSignature()), agree: true })).statusCode).toBe(201);
  });

  it('the daily belt: a link past 72 hours expires (audited); a request that ended unsigned is deleted after 30 days, a signed one never', async () => {
    const o = await storeAccount('COMPANY');
    const waiting = await sentLetter(o);
    await system(() => app.prisma.authorityLetterRequest.update({ where: { id: waiting.id }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    const now = new Date();
    const first = await system(() => sweepAuthorityLetters(app.prisma, now));
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect((await rowOf(waiting.id)).status).toBe('EXPIRED');
    const later = new Date(now.getTime() + (ENDED_RETENTION_DAYS + 1) * DAY);
    const second = await system(() => sweepAuthorityLetters(app.prisma, later));
    expect(second.deleted).toBeGreaterThanOrEqual(1);
    expect(await system(() => app.prisma.authorityLetterRequest.findUnique({ where: { id: waiting.id } }))).toBeNull();
    expect((await audits(waiting.id)).map((a) => a.action)).toEqual(expect.arrayContaining([LETTER_AUDIT.expired, LETTER_AUDIT.deleted]));
    // signed: kept (it is the evidence of the signature)
    const s = await sentLetter(o);
    const key = await verified(s.token, s.signerPhone);
    // (the cancelled-by-replacement first request does not block this one)
    expect((await pub('sign', { token: s.token, signingKey: key, signature: dataUrl(drawnSignature()), agree: true })).statusCode).toBe(201);
    await system(() => sweepAuthorityLetters(app.prisma, new Date(Date.now() + 400 * DAY)));
    expect((await rowOf(s.id)).status).toBe('SIGNED');
    // ...until the letter it was filed as is purged: then the signer's evidence goes with it
    const filed = (await rowOf(s.id)).documentId!;
    await system(() => app.prisma.verificationDocument.update({ where: { id: filed }, data: { purgedAt: new Date() } }));
    await system(() => sweepAuthorityLetters(app.prisma));
    expect(await system(() => app.prisma.authorityLetterRequest.findUnique({ where: { id: s.id } }))).toBeNull();
    expect((await audits(s.id)).at(-1)!.action).toBe(LETTER_AUDIT.deleted);
  });

  it('the database keeps the words and the people they name as written, and a signed letter final', async () => {
    const o = await storeAccount('COMPANY');
    const { id } = await sentLetter(o);
    await expect(system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { signerPhone: '+5920699999' } }))).rejects.toThrow();
    await expect(system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { letterText: 'changed' } }))).rejects.toThrow();
    await expect(system(() => app.prisma.authorityLetterRequest.update({ where: { id }, data: { status: 'SIGNED', signedAt: new Date() } }))).rejects.toThrow();
  });
});
