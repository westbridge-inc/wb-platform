/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority, end to end.
 *
 *  1. The account holder of a company's store account (or a registered business's manager) fills a short form; Swift
 *     writes the one-page letter (letter.ts) and texts the director (or the owner) a SINGLE-USE link. The link's secret
 *     is 32 random bytes, kept only as its SHA-256, after the '#' of the address (never in a server log), working 72
 *     hours. The signer's number must not be the account holder's own nor one already on the store's team.
 *  2. The link opens a public page (no app, no account): the letter, then a code texted to THAT number (kept as an HMAC,
 *     10 minutes, 5 tries, one use; the letter's OWN per-number counters, never the signer's sign-in ones), then a
 *     finger signature and an "I authorise" tick.
 *  3. The signed page (letter-pdf.ts) is stored exactly like an uploaded ID: malware-scanned, envelope-encrypted, owned
 *     by the account holder, served to reviewers only through the audited, signed render link; and filed as the account
 *     holder's letter of authority document, which a person at Swift still checks (PERSON_ONLY_DOC_TYPES).
 *  4. Every step is an audit row (created, sent, opened, code sent, code verified or refused, signed, expired, resent,
 *     cancelled, deleted), with no name or number in it. A request that ended unsigned is deleted 30 days later.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { Prisma, AuthorityLetterRequest, PrismaClient } from '@prisma/client';
import { AppError } from '../../../utils/errors';
import { normalizePhone } from '../../../utils/phone';
import { generateOtp, scopedOtpDigest } from '../../../utils/otp';
import { getChannels } from '../../../providers/notifications/channels';
import { getStorageProvider } from '../../../providers/storage/storage-provider';
import { encryptBuffer, generateDek, getKeyProvider } from '../../../providers/storage/envelope';
import { scanUpload } from '../../../lib/malware-scan';
import { recordUnscannedUpload } from '../../../lib/upload-scan-debt';
import { runAsSystem, runWithTenant } from '../../../plugins/tenant-context';
import { hashIp } from '../../legal/consent.service';
import { LEGAL_VERSION } from '../../legal/legal.routes';
import { VerificationService } from '../../verification/verification.service';
import { NotificationService } from '../../notification/notification.service';
import { getKycProvider } from '../../../providers/kyc/kyc-provider';
import {
  CODE_MAX_ATTEMPTS, CODE_MAX_SENDS, CODE_TTL_MS, ENDED_RETENTION_DAYS, LETTER_DOC_TYPE, LINK_TTL_MS, MAX_REQUESTS_PER_DAY,
  MAX_RESENDS, RESEND_COOLDOWN_MS, SIGNING_KEY_TTL_MS, authorityLetterWords, cleanField, firstNameOf, letterCodeSms,
  letterLinkSms, phoneEnding, signerKind, signingLink, type LetterBasis, type LetterForm,
} from './letter';
import { renderSignedLetterPdf } from './letter-pdf';
import { cleanSignature } from './letter-signature';
import { claimLetterCodeText, claimLetterLinkText } from './letter-sms-budget';

/** The audit trail's own names for each step. */
export const LETTER_AUDIT = {
  created: 'AUTHORITY_LETTER_CREATED',
  sent: 'AUTHORITY_LETTER_SENT',
  sendFailed: 'AUTHORITY_LETTER_SEND_FAILED',
  resent: 'AUTHORITY_LETTER_RESENT',
  opened: 'AUTHORITY_LETTER_OPENED',
  codeSent: 'AUTHORITY_LETTER_CODE_SENT',
  codeVerified: 'AUTHORITY_LETTER_CODE_VERIFIED',
  codeRefused: 'AUTHORITY_LETTER_CODE_REFUSED',
  signed: 'AUTHORITY_LETTER_SIGNED',
  expired: 'AUTHORITY_LETTER_EXPIRED',
  cancelled: 'AUTHORITY_LETTER_CANCELLED',
  deleted: 'AUTHORITY_LETTER_DELETED',
} as const;
export const LETTER_AUDIT_ENTITY = 'AuthorityLetterRequest';

/** SHA-256 hex of a secret (the link's, the signing key's). */
export const secretDigest = (secret: string) => createHash('sha256').update(secret, 'utf8').digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

type Db = PrismaClient | Prisma.TransactionClient;

/** [review F7] A signature being filed holds its request this long at most (a crash releases it after this). */
export const SIGNING_CLAIM_MS = 5 * 60_000;
/** Not being signed right now, and nothing filed yet: only such a request may be cancelled, resent or expired. */
const notBeingSigned = (now: Date): Prisma.AuthorityLetterRequestWhereInput => ({
  documentId: null,
  OR: [{ signingClaimedAt: null }, { signingClaimedAt: { lt: new Date(now.getTime() - SIGNING_CLAIM_MS) } }],
});
const beingSigned = () => new AppError(409, 'LETTER_BEING_SIGNED', 'This letter is being signed right now. Wait a minute, then look again.');

/** [review F5] Two names are one person's when they match once normalised, or share the first and the last name. */
export function sameName(a: string, b: string): boolean {
  const norm = (v: string) => cleanField(v).normalize('NFKC').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const x = norm(a); const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' '); const ys = y.split(' ');
  return xs.length > 1 && ys.length > 1 && xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

async function audit(db: Db, action: string, requestId: string, actorUserId: string | null, changes: Record<string, unknown> = {}): Promise<void> {
  // Never a name or a number: the request id says whose letter it is.
  await db.auditLog.create({ data: { action, entity: LETTER_AUDIT_ENTITY, entityId: requestId, userId: actorUserId, changes: changes as Prisma.InputJsonValue } });
}

/**
 * [FOLLOWUPS-2475] A business type change ended without switching (refused, or withdrawn): a letter asked for the new
 * business type (the change's own, a company's director or a registered business's owner) is never needed now, so one
 * still waiting is cancelled in the change's own transaction (audited, its link dies): no signer is texted or signs for
 * nothing. A letter being signed right now is left to finish (its filing is refused: not on the account's list).
 */
export async function cancelChangeLetters(tx: Prisma.TransactionClient, input: { userId: string; docType: string; by: string; changeId: string; now?: Date }): Promise<number> {
  const now = input.now ?? new Date();
  const live = await tx.authorityLetterRequest.findMany({
    where: { userId: input.userId, docType: input.docType, status: { in: ['SENT', 'EXPIRED'] }, ...notBeingSigned(now) }, select: { id: true, status: true },
  });
  let cancelled = 0;
  for (const r of live) {
    const moved = await tx.authorityLetterRequest.updateMany({
      where: { id: r.id, status: r.status, ...notBeingSigned(now) }, data: { status: 'CANCELLED', endedAt: now, signingKeyHash: null, codeHash: null },
    });
    if (moved.count !== 1) continue;
    cancelled += 1;
    await audit(tx, LETTER_AUDIT.cancelled, r.id, input.by, { reason: 'change-ended', changeId: input.changeId });
  }
  return cancelled;
}

/** What the account holder sees of their request (their Documents page). */
export interface LetterRequestView {
  id: string;
  docType: string;
  status: AuthorityLetterRequest['status'];
  signerKind: 'director' | 'owner';
  signerFirstName: string;
  signerPhoneEnding: string;
  businessName: string;
  registrationNumber: string;
  requesterName: string;
  requesterRole: string;
  expiresAt: string;
  lastSentAt: string;
  resendsLeft: number;
  /** When the next resend is allowed (ISO), or null when it is allowed now (or never again). */
  resendAt: string | null;
  openedAt: string | null;
  codeVerifiedAt: string | null;
  signedAt: string | null;
  documentId: string | null;
}

export function viewOf(r: AuthorityLetterRequest, now = new Date()): LetterRequestView {
  const resendsLeft = Math.max(0, 1 + MAX_RESENDS - r.sendCount);
  const resendAt = r.lastSentAt.getTime() + RESEND_COOLDOWN_MS;
  return {
    id: r.id, docType: r.docType, status: r.status, signerKind: signerKind(r.accountBasis as LetterBasis),
    signerFirstName: firstNameOf(r.signerName), signerPhoneEnding: phoneEnding(r.signerPhone),
    businessName: r.businessName, registrationNumber: r.registrationNumber, requesterName: r.requesterName, requesterRole: r.requesterRole,
    expiresAt: r.linkExpiresAt.toISOString(), lastSentAt: r.lastSentAt.toISOString(), resendsLeft,
    resendAt: resendsLeft > 0 && resendAt > now.getTime() ? new Date(resendAt).toISOString() : null,
    openedAt: r.openedAt?.toISOString() ?? null, codeVerifiedAt: r.codeVerifiedAt?.toISOString() ?? null,
    signedAt: r.signedAt?.toISOString() ?? null, documentId: r.documentId,
  };
}

/** What the signing page is shown: the letter while it waits; once signed, only that it is signed (review F4). */
export type SigningPageView =
  | { status: 'SENT'; title: string; lines: string[]; signerKind: 'director' | 'owner'; signerName: string; phoneEnding: string; expiresAt: string }
  | { status: 'SIGNED'; signedAt: string | null };

const linkNotValid = () => new AppError(404, 'LETTER_LINK_NOT_VALID', 'This link doesn’t work any more. Ask the person who sent it to send you a new one from Swift.');
const linkExpired = () => new AppError(410, 'LETTER_LINK_EXPIRED', 'This link has expired. Ask the person who sent it to send you a new one from Swift.');

export interface ParsedForm extends LetterForm { signerPhone: string }

export class AuthorityLetterService {
  constructor(private app: FastifyInstance, private channels = getChannels()) {}

  private get prisma() { return this.app.prisma; }

  /** The newest request of this account (expired ones are marked as such first). */
  async current(userId: string, now = new Date()): Promise<LetterRequestView | null> {
    const r = await this.prisma.authorityLetterRequest.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    if (!r) return null;
    return viewOf(await this.expireIfDue(r, now), now);
  }

  /** A SENT request whose 72 hours are over becomes EXPIRED, once (audited). */
  private async expireIfDue(r: AuthorityLetterRequest, now: Date): Promise<AuthorityLetterRequest> {
    if (r.status !== 'SENT' || r.linkExpiresAt.getTime() > now.getTime()) return r;
    const moved = await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, status: 'SENT', linkExpiresAt: { lte: now }, ...notBeingSigned(now) }, data: { status: 'EXPIRED', endedAt: now, signingKeyHash: null, codeHash: null } });
    if (moved.count === 1) await audit(this.prisma, LETTER_AUDIT.expired, r.id, null, { sendCount: r.sendCount });
    return this.prisma.authorityLetterRequest.findUniqueOrThrow({ where: { id: r.id } });
  }

  /**
   * Start a request: the account holder of a COMPANY or MANAGER account asks the director (or owner) to sign.
   * Replaces a request still waiting (cancelled, audited). Texts the link.
   */
  async create(input: { userId: string; vendorId: string; basis: LetterBasis; form: ParsedForm; ip: string; now?: Date;
    /** [FOLLOWUPS-2475] The business type change waiting this letter is for (not the account's own letter). */
    changeId?: string }): Promise<LetterRequestView> {
    const now = input.now ?? new Date();
    const { userId, basis, form } = input;
    const docType = LETTER_DOC_TYPE[basis];
    await this.assertNoLetterOnFile(userId, docType);
    // [review F5] The letter names the account's own name (the one a person at Swift checks against the account
    // holder's ID), never a name typed freely; and the signer is someone else, by the account's name and the typed one.
    const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    const accountName = cleanField(`${account?.firstName ?? ''} ${account?.lastName ?? ''}`);
    if (sameName(form.signerName, form.requesterName) || sameName(form.signerName, accountName)) {
      throw new AppError(400, 'SIGNER_IS_YOU', basis === 'COMPANY'
        ? 'A director is someone else. If you are a director, upload the company’s list of directors instead.'
        : 'The owner is someone else: enter the owner’s name.');
    }
    if (!sameName(form.requesterName, accountName)) {
      // (Never the name itself in the refusal: an error's words can reach a log.)
      throw new AppError(400, 'REQUESTER_NOT_ACCOUNT_NAME', accountName
        ? 'Enter your own full name as it is on your Swift account: the letter authorises the person who holds this account.'
        : 'Add your full name to your Swift account first: the letter authorises the person who holds this account.');
    }
    await this.assertSignerPhoneAllowed(userId, form.signerPhone, basis);
    const today = await this.prisma.authorityLetterRequest.count({ where: { userId, createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) } } });
    if (today >= MAX_REQUESTS_PER_DAY) {
      throw new AppError(429, 'RATE_LIMITED', 'You’ve started too many letters today. Try again tomorrow, or upload a signed paper letter instead.');
    }
    // The letter's own counters (letter-sms-budget.ts): never the signer's sign-in budget.
    const budget = await claimLetterLinkText(this.app.redis, form.signerPhone);
    if (!budget.allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many letters were texted to this number today. Try again tomorrow.');

    const words = authorityLetterWords(basis, form, now);
    const token = newSecret();
    const live = await this.prisma.authorityLetterRequest.findMany({ where: { userId, status: { in: ['SENT', 'EXPIRED'] } }, select: { id: true, status: true } });
    const created = await this.prisma.$transaction(async (tx) => {
      // [FOLLOWUPS-2475] A change's letter: the change is still waiting, held until this commits (the change's end
      // takes the same row first, then cancels its letters: never a letter left for a change that ended).
      if (input.changeId) {
        const [change] = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS status FROM "account_change_requests" WHERE "id" = ${input.changeId} FOR UPDATE /* authority-letter-for-change */`;
        if (change?.status !== 'PENDING') throw new AppError(409, 'ACCOUNT_CHANGE_DECIDED', 'That change has already been decided. Open Account to see where it stands.');
      }
      for (const old of live) {
        const moved = await tx.authorityLetterRequest.updateMany({ where: { id: old.id, status: old.status, ...notBeingSigned(now) }, data: { status: 'CANCELLED', endedAt: now, signingKeyHash: null, codeHash: null } });
        if (moved.count !== 1) throw beingSigned();
        await audit(tx, LETTER_AUDIT.cancelled, old.id, userId, { reason: 'replaced' });
      }
      const row = await tx.authorityLetterRequest.create({ data: {
        userId, vendorId: input.vendorId, docType, accountBasis: basis,
        businessName: cleanField(form.businessName), registrationNumber: cleanField(form.registrationNumber),
        requesterName: cleanField(form.requesterName), requesterRole: cleanField(form.requesterRole),
        signerName: cleanField(form.signerName), signerPhone: form.signerPhone,
        letterText: words.text, letterSha256: words.sha256, tokenHash: secretDigest(token),
        linkExpiresAt: new Date(now.getTime() + LINK_TTL_MS), lastSentAt: now,
      } });
      await audit(tx, LETTER_AUDIT.created, row.id, userId, { docType, letterSha256: words.sha256, replaced: live.length });
      return row;
    }).catch(async (error: unknown) => { await budget.refund().catch(() => undefined); throw error; });
    await this.textLink(created, token, budget.refund, userId, LETTER_AUDIT.sent);
    return viewOf(created, now);
  }

  /** A letter (paper or signed in Swift) already waiting for review or approved: nothing more to sign. */
  private async assertNoLetterOnFile(userId: string, docType: string): Promise<void> {
    const onFile = await this.prisma.verificationDocument.findFirst({ where: { userId, docType, status: { in: ['PENDING', 'APPROVED'] } }, select: { status: true } });
    if (onFile) {
      throw new AppError(409, 'AUTHORITY_LETTER_ON_FILE', onFile.status === 'APPROVED'
        ? 'Your letter of authority is already approved.'
        : 'A letter of authority is already waiting for a person at Swift to check it.');
    }
  }

  /** The text with the link. A provider failure gives the budget back, ends the request and says so (502). */
  private async textLink(r: AuthorityLetterRequest, token: string, refund: () => Promise<void>, actor: string, action: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      // One fixed sentence and Swift's own link: nothing anyone typed is ever texted (letter.ts letterLinkSms).
      await this.channels.sms.sendSms(r.signerPhone, letterLinkSms(signingLink(token)));
    } catch (err) {
      await refund().catch(() => undefined);
      this.app.log.error({ err, requestId: r.id }, '[authority-letter] link text failed');
      const moved = await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, status: 'SENT' }, data: { status: 'CANCELLED', endedAt: new Date(), signingKeyHash: null, codeHash: null } });
      if (moved.count === 1) await audit(this.prisma, LETTER_AUDIT.sendFailed, r.id, actor);
      throw new AppError(502, 'SMS_SEND_FAILED', 'We couldn’t text the link right now. Check the number and try again in a moment.');
    }
    await audit(this.prisma, action, r.id, actor, { sendCount: r.sendCount, ...extra });
  }

  /** The signer's number: a Guyana number, never the account holder's own, never one already on the store's team. */
  async assertSignerPhoneAllowed(userId: string, signerPhone: string, basis: LetterBasis): Promise<void> {
    const who = signerKind(basis);
    const holder = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (holder && normalizePhone(holder.phone) === signerPhone) {
      throw new AppError(400, 'SIGNER_PHONE_IS_YOURS', `The ${who} signs on their own phone. Enter the ${who}’s number, not yours.`);
    }
    const team = await this.prisma.vendorStaff.findMany({
      where: { vendor: { owner: { userId } } },
      select: { user: { select: { phone: true } } },
    });
    if (team.some((m) => normalizePhone(m.user.phone) === signerPhone)) {
      throw new AppError(400, 'SIGNER_PHONE_ON_TEAM', `That number belongs to someone on your store’s team. The ${who} signs on their own phone: enter the ${who}’s own number.`);
    }
  }

  /** Text a new link (the old one stops working): limited to MAX_RESENDS, one a minute. Opens an expired request again. */
  async resend(userId: string, id: string, now = new Date()): Promise<LetterRequestView> {
    let r = await this.prisma.authorityLetterRequest.findFirst({ where: { id, userId } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Letter request not found');
    r = await this.expireIfDue(r, now);
    if (r.status !== 'SENT' && r.status !== 'EXPIRED') {
      throw new AppError(409, 'LETTER_NOT_WAITING', r.status === 'SIGNED' ? 'This letter is already signed.' : 'This letter was cancelled. Start a new one.');
    }
    if (r.sendCount >= 1 + MAX_RESENDS) {
      throw new AppError(429, 'RESEND_LIMIT', 'This link has been sent as many times as it can be. Check the number, or start a new letter.');
    }
    const wait = r.lastSentAt.getTime() + RESEND_COOLDOWN_MS - now.getTime();
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      throw new AppError(429, 'RATE_LIMITED', `You can send it again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`, { retryAfterSeconds });
    }
    await this.assertNoLetterOnFile(userId, r.docType);
    await this.assertSignerPhoneAllowed(userId, r.signerPhone, r.accountBasis as LetterBasis);
    const budget = await claimLetterLinkText(this.app.redis, r.signerPhone);
    if (!budget.allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many letters were texted to this number today. Try again tomorrow.');
    const token = newSecret();
    const moved = await this.prisma.authorityLetterRequest.updateMany({
      where: { id: r.id, status: r.status, sendCount: r.sendCount, ...notBeingSigned(now) },
      data: {
        status: 'SENT', endedAt: null, tokenHash: secretDigest(token), linkExpiresAt: new Date(now.getTime() + LINK_TTL_MS),
        sendCount: { increment: 1 }, lastSentAt: now, codeHash: null, codeExpiresAt: null, codeAttempts: 0, signingKeyHash: null, signingKeyExpiresAt: null,
      },
    });
    if (moved.count !== 1) { await budget.refund().catch(() => undefined); throw beingSigned(); }
    const fresh = await this.prisma.authorityLetterRequest.findUniqueOrThrow({ where: { id: r.id } });
    await this.textLink(fresh, token, budget.refund, userId, LETTER_AUDIT.resent, { reopened: r.status === 'EXPIRED' });
    return viewOf(fresh, now);
  }

  /** The account holder withdraws a request (a wrong number): the link stops working. */
  async cancel(userId: string, id: string, now = new Date()): Promise<LetterRequestView> {
    const r = await this.prisma.authorityLetterRequest.findFirst({ where: { id, userId } });
    if (!r) throw new AppError(404, 'NOT_FOUND', 'Letter request not found');
    if (r.status === 'SIGNED') throw new AppError(409, 'LETTER_NOT_WAITING', 'This letter is already signed.');
    if (r.status !== 'CANCELLED') {
      // [review F7] A signature already being filed wins: the cancel is refused, never half-applied.
      const moved = await this.prisma.authorityLetterRequest.updateMany({ where: { id, status: r.status, ...notBeingSigned(now) }, data: { status: 'CANCELLED', endedAt: now, signingKeyHash: null, codeHash: null } });
      if (moved.count !== 1) {
        const after = await this.prisma.authorityLetterRequest.findUniqueOrThrow({ where: { id } });
        if (after.status === 'SIGNED') throw new AppError(409, 'LETTER_NOT_WAITING', 'This letter is already signed.');
        if (after.status !== 'CANCELLED') throw beingSigned();
      } else {
        await audit(this.prisma, LETTER_AUDIT.cancelled, id, userId, { reason: 'withdrawn' });
      }
    }
    return viewOf(await this.prisma.authorityLetterRequest.findUniqueOrThrow({ where: { id } }), now);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The public signing page (no account): the link's secret is the only credential, and only for its own request.
  // ---------------------------------------------------------------------------------------------------------------

  /** The request a link names, while it can still be signed (else the page's own refusal). */
  private async byToken(token: string, now: Date, opts: { allowSigned?: boolean } = {}): Promise<AuthorityLetterRequest> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw linkNotValid();
    const found = await this.prisma.authorityLetterRequest.findUnique({ where: { tokenHash: secretDigest(token) } });
    if (!found || found.status === 'CANCELLED') throw linkNotValid();
    const r = await this.expireIfDue(found, now);
    if (r.status === 'SIGNED') {
      if (opts.allowSigned) return r;
      throw new AppError(409, 'LETTER_ALREADY_SIGNED', 'This letter is already signed. Thank you.');
    }
    if (r.status !== 'SENT') throw linkExpired();
    return r;
  }

  /** The page opens: the letter's words (exactly what will be signed). The first open is audited. */
  async open(token: string, now = new Date()): Promise<SigningPageView> {
    const r = await this.byToken(token, now, { allowSigned: true });
    if (r.status === 'SENT' && !r.openedAt) {
      const moved = await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, openedAt: null }, data: { openedAt: now } });
      if (moved.count === 1) await audit(this.prisma, LETTER_AUDIT.opened, r.id, null);
    }
    if (r.status === 'SIGNED') return { status: 'SIGNED', signedAt: r.signedAt?.toISOString() ?? null };
    const [title, ...lines] = r.letterText.split('\n');
    return {
      status: 'SENT', title: title ?? '', lines, signerKind: signerKind(r.accountBasis as LetterBasis),
      signerName: r.signerName, phoneEnding: phoneEnding(r.signerPhone), expiresAt: r.linkExpiresAt.toISOString(),
    };
  }

  /** Text a code to the signer's number (the letter's own per-number limits: letter-sms-budget.ts). */
  async sendCode(token: string, now = new Date()): Promise<{ phoneEnding: string; expiresInSeconds: number }> {
    const r = await this.byToken(token, now);
    if (r.codeSends >= CODE_MAX_SENDS) throw new AppError(429, 'CODE_LIMIT', 'Too many codes for this letter. Ask the person who sent it to send you a new link.');
    const phone = r.signerPhone;
    // The letter's own counters (letter-sms-budget.ts): a minute apart, a daily cap per number. Never the signer's
    // sign-in cool-down, hourly cap or daily budget: a code asked here can never lock them out of signing in.
    const budget = await claimLetterCodeText(this.app.redis, phone);
    if (!budget.allowed) {
      if (budget.reason === 'cooldown') {
        const wait = budget.retryAfterSeconds ?? 60;
        throw new AppError(429, 'RATE_LIMITED', `A code was just sent. You can ask for a new one in ${wait} second${wait === 1 ? '' : 's'}.`, { retryAfterSeconds: wait });
      }
      throw new AppError(429, 'RATE_LIMITED', 'Too many codes for this number today. Try again tomorrow.');
    }
    const code = generateOtp();
    const moved = await this.prisma.authorityLetterRequest.updateMany({
      where: { id: r.id, status: 'SENT', tokenHash: r.tokenHash, codeSends: r.codeSends },
      data: { codeHash: scopedOtpDigest(`authority-letter:${r.id}`, code), codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS), codeAttempts: 0, codeSends: { increment: 1 } },
    });
    if (moved.count !== 1) { await budget.refund().catch(() => undefined); throw new AppError(409, 'LETTER_CHANGED', 'This letter just changed. Open the link again.'); }
    try {
      await this.channels.sms.sendSms(phone, letterCodeSms(code));
    } catch (err) {
      await budget.refund().catch(() => undefined);
      await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id }, data: { codeHash: null, codeExpiresAt: null } });
      this.app.log.error({ err, requestId: r.id }, '[authority-letter] code text failed');
      throw new AppError(502, 'SMS_SEND_FAILED', 'We couldn’t text your code right now. Please try again in a moment.');
    }
    await audit(this.prisma, LETTER_AUDIT.codeSent, r.id, null, { codeSends: r.codeSends + 1 });
    return { phoneEnding: phoneEnding(phone), expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  /** Check the code (one use, 5 tries, 10 minutes). Right: a signing key for the next 30 minutes. */
  async verifyCode(token: string, code: string, now = new Date()): Promise<{ signingKey: string; expiresInSeconds: number }> {
    const r = await this.byToken(token, now);
    if (!r.codeHash || !r.codeExpiresAt || r.codeExpiresAt.getTime() <= now.getTime()) {
      throw new AppError(400, 'CODE_EXPIRED', 'That code has expired. Ask for a new one.');
    }
    if (r.codeAttempts >= CODE_MAX_ATTEMPTS) throw new AppError(429, 'CODE_LOCKED', 'Too many wrong codes. Ask for a new one.');
    // Each try is counted before it is compared (two tries at once both count).
    const counted = await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, codeHash: r.codeHash, codeAttempts: { lt: CODE_MAX_ATTEMPTS } }, data: { codeAttempts: { increment: 1 } } });
    if (counted.count !== 1) throw new AppError(429, 'CODE_LOCKED', 'Too many wrong codes. Ask for a new one.');
    if (!/^\d{6}$/.test(code) || !sameHex(scopedOtpDigest(`authority-letter:${r.id}`, code), r.codeHash)) {
      await audit(this.prisma, LETTER_AUDIT.codeRefused, r.id, null, { attempt: r.codeAttempts + 1 });
      const left = CODE_MAX_ATTEMPTS - r.codeAttempts - 1;
      throw new AppError(400, 'INVALID_CODE', left > 0 ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code isn’t right. Ask for a new one.');
    }
    const signingKey = newSecret();
    const used = await this.prisma.authorityLetterRequest.updateMany({
      where: { id: r.id, status: 'SENT', codeHash: r.codeHash },
      data: { codeHash: null, codeExpiresAt: null, codeVerifiedAt: now, signingKeyHash: secretDigest(signingKey), signingKeyExpiresAt: new Date(now.getTime() + SIGNING_KEY_TTL_MS) },
    });
    if (used.count !== 1) throw new AppError(400, 'CODE_EXPIRED', 'That code was already used. Ask for a new one.');
    await audit(this.prisma, LETTER_AUDIT.codeVerified, r.id, null);
    return { signingKey, expiresInSeconds: SIGNING_KEY_TTL_MS / 1000 };
  }

  /**
   * Sign: the signing key (from the code), the drawn signature and the tick. Builds the signed page, stores it as an
   * ID is stored, files it as the account holder's letter of authority (a person at Swift checks it), and ends the link.
   */
  async sign(input: { token: string; signingKey: string; signature: string; ip: string; userAgent: string | null; log?: FastifyBaseLogger; now?: Date }): Promise<{ status: 'SIGNED'; signedAt: string }> {
    const now = input.now ?? new Date();
    const r = await this.byToken(input.token, now);
    const keyHash = secretDigest(input.signingKey);
    if (!r.signingKeyHash || !r.signingKeyExpiresAt || r.signingKeyExpiresAt.getTime() <= now.getTime() || !sameHex(keyHash, r.signingKeyHash)) {
      throw new AppError(403, 'CODE_NEEDED', 'Confirm the code we texted you first.');
    }
    const signature = await cleanSignature(input.signature);
    // [review F7] Claim the signature: one at a time (the key is spent), and while it is claimed a cancel, a resend or
    // the link's expiry waits for it. A letter already filed by an earlier try is never filed again: it is finalised.
    const claimed = r.documentId
      ? await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, status: 'SENT', signingKeyHash: keyHash, documentId: { not: null } }, data: { signingKeyHash: null } })
      : await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, status: 'SENT', signingKeyHash: keyHash, ...notBeingSigned(now) }, data: { signingKeyHash: null, signingClaimedAt: now } });
    if (claimed.count !== 1) throw new AppError(409, 'LETTER_CHANGED', 'This letter is being signed already. Open the link again.');
    try {
      if (!r.documentId) await this.fileSigned(r, signature, { ...input, now });
      return await this.finaliseSigned(r.id);
    } catch (error) {
      // Nothing was finalised: the same key may try again while it lasts. A letter already filed stays filed (and claimed
      // at its signing time), so the next try only finalises it.
      await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, status: 'SENT', signingKeyHash: null, documentId: { not: null } }, data: { signingKeyHash: keyHash } }).catch(() => undefined);
      await this.prisma.authorityLetterRequest.updateMany({ where: { id: r.id, status: 'SENT', signingKeyHash: null, documentId: null }, data: { signingKeyHash: keyHash, signingClaimedAt: null } }).catch(() => undefined);
      throw error;
    }
  }

  /** [review F7] The one step that makes a filed letter SIGNED: atomic with its audit row, and only once. */
  async finaliseSigned(id: string): Promise<{ status: 'SIGNED'; signedAt: string }> {
    return finaliseSignedLetter(this.prisma, id);
  }

  /** Store the signed page as an ID is stored and file it as the account holder's letter of authority, ONCE: the filing is
   *  recorded on the claimed request before anything else, so a later try only finalises it. */
  private async fileSigned(r: AuthorityLetterRequest, signature: { png: Buffer; sha256: string }, input: { ip: string; userAgent: string | null; log?: FastifyBaseLogger; now: Date }): Promise<void> {
    const holder = await runAsSystem('authority-letter-signing', () => this.prisma.user.findUnique({ where: { id: r.userId }, select: { tenantId: true } }));
    if (!holder) throw linkNotValid();
    // The key is acquired before anything is written (as every document store).
    const dek = generateDek();
    let wrappedDek: Buffer;
    try {
      const keys = getKeyProvider();
      if (!keys) throw new Error('Envelope encryption unavailable');
      wrappedDek = await keys.wrapDek(dek);
    } catch {
      throw new AppError(503, 'VERIFICATION_UPLOAD_UNAVAILABLE', 'Signing is unavailable for a moment. Try again shortly.');
    }
    const signedAt = input.now;
    const [title, ...lines] = r.letterText.split('\n');
    const ipDigest = hashIp(input.ip);
    const userAgent = input.userAgent ? input.userAgent.slice(0, 300) : null;
    const pdf = await renderSignedLetterPdf({
      title: title ?? '', lines, signaturePng: signature.png, signerName: r.signerName, signerKind: signerKind(r.accountBasis as LetterBasis),
      signerPhone: r.signerPhone, requesterName: r.requesterName, codeVerifiedAt: r.codeVerifiedAt ?? signedAt, signedAt, letterSha256: r.letterSha256, requestId: r.id, ipDigest, userAgent,
    });
    // [Row 312] Scanned as plaintext before it is sealed, like every document a person sends (the signature is in it).
    const scan = await scanUpload(pdf, { surface: 'verification', log: input.log });
    const storage = getStorageProvider();
    const { ciphertext, iv, authTag } = encryptBuffer(pdf, dek);
    const { url: fileUrl } = await storage.upload({ buffer: ciphertext, filename: 'authority-letter.pdf.enc', mimeType: 'application/octet-stream', folder: `verification/${r.userId}` });
    await this.prisma.encryptedObject.create({ data: {
      fileKey: fileUrl, iv: new Uint8Array(iv), authTag: new Uint8Array(authTag), wrappedDek: new Uint8Array(wrappedDek),
      mimeType: 'application/pdf', sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), createdBy: r.userId,
    } });
    await recordUnscannedUpload(this.prisma, scan, { surface: 'verification', fileKey: fileUrl, buffer: pdf, sealed: true, storage });
    // The store it was asked from (its type names the checklist), else the account's first store if that one is gone.
    const vendor = await runWithTenant(holder.tenantId, async () => (await this.prisma.vendor.findFirst({
      where: { id: r.vendorId, owner: { userId: r.userId } }, select: { id: true, vendorType: true },
    })) ?? this.prisma.vendor.findFirst({ where: { owner: { userId: r.userId } }, orderBy: { createdAt: 'asc' }, select: { id: true, vendorType: true } }));
    if (!vendor) throw linkNotValid();
    const role = vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
    const verification = new VerificationService(this.prisma, new NotificationService(this.prisma, this.app.io), getKycProvider());
    const doc = await runWithTenant(holder.tenantId, () => verification.submitDocument(r.userId, role, r.docType, fileUrl, LEGAL_VERSION));
    const recorded = await this.prisma.authorityLetterRequest.updateMany({
      where: { id: r.id, status: 'SENT', documentId: null, signingClaimedAt: signedAt },
      data: { signerIpHmac: ipDigest, signerUserAgent: userAgent, signatureSha256: signature.sha256, documentId: doc.id, pdfFileKey: fileUrl },
    });
    if (recorded.count !== 1) throw new AppError(409, 'LETTER_CHANGED', 'This letter just changed. Open the link again.');
    if (scan !== 'SKIPPED' && scan !== 'CLEAN') this.app.log.warn({ requestId: r.id, scan }, '[authority-letter] signed letter stored awaiting its malware scan');
  }
}

/** [review F7] Make a filed letter SIGNED (signed at its claim time, the time on its PDF): one transaction with its audit
 *  row, a compare-and-set on the filed state, and a no-op on a letter already signed. */
export async function finaliseSignedLetter(prisma: PrismaClient, id: string): Promise<{ status: 'SIGNED'; signedAt: string }> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.authorityLetterRequest.findUniqueOrThrow({ where: { id } });
    if (row.status === 'SIGNED') return { status: 'SIGNED' as const, signedAt: row.signedAt!.toISOString() };
    if (row.status !== 'SENT' || !row.documentId || !row.signingClaimedAt) throw new AppError(409, 'LETTER_CHANGED', 'This letter just changed. Open the link again.');
    const signedAt = row.signingClaimedAt;
    const moved = await tx.authorityLetterRequest.updateMany({
      where: { id, status: 'SENT', documentId: row.documentId, signingClaimedAt: signedAt },
      data: { status: 'SIGNED', signedAt, endedAt: signedAt, signingKeyExpiresAt: null, signingClaimedAt: null },
    });
    if (moved.count !== 1) throw new AppError(409, 'LETTER_CHANGED', 'This letter just changed. Open the link again.');
    await audit(tx, LETTER_AUDIT.signed, id, null, { documentId: row.documentId, letterSha256: row.letterSha256, signatureSha256: row.signatureSha256 });
    return { status: 'SIGNED' as const, signedAt: signedAt.toISOString() };
  });
}

/**
 * [COMPANY-DOCS PART 2] The daily belt (expiry-sweep job): requests past their 72 hours become EXPIRED (audited); a
 * request that ended unsigned more than 30 days ago is deleted (the signer's name and number go with it; audited by id);
 * a letter filed by a signature that crashed before its last step is finalised; and a signed one is deleted once the
 * letter it was filed as is purged.
 */
export async function sweepAuthorityLetters(prisma: PrismaClient, now = new Date(), batch = 200): Promise<{ expired: number; deleted: number }> {
  let expired = 0;
  const due = await prisma.authorityLetterRequest.findMany({ where: { status: 'SENT', linkExpiresAt: { lte: now }, ...notBeingSigned(now) }, select: { id: true, sendCount: true }, take: batch });
  for (const r of due) {
    const moved = await prisma.authorityLetterRequest.updateMany({ where: { id: r.id, status: 'SENT', linkExpiresAt: { lte: now }, ...notBeingSigned(now) }, data: { status: 'EXPIRED', endedAt: now, signingKeyHash: null, codeHash: null } });
    if (moved.count === 1) { expired += 1; await audit(prisma, LETTER_AUDIT.expired, r.id, null, { sendCount: r.sendCount }); }
  }
  // [review F7] A letter filed by a signature whose last step never ran (a crash): finalised, never filed again.
  const stuck = await prisma.authorityLetterRequest.findMany({ where: { status: 'SENT', documentId: { not: null }, signingClaimedAt: { lt: new Date(now.getTime() - SIGNING_CLAIM_MS) } }, select: { id: true }, take: batch });
  for (const r of stuck) await finaliseSignedLetter(prisma, r.id).catch(() => undefined);
  const cutoff = new Date(now.getTime() - ENDED_RETENTION_DAYS * 24 * 3600_000);
  const ended = await prisma.authorityLetterRequest.findMany({ where: { status: { in: ['EXPIRED', 'CANCELLED'] }, endedAt: { lt: cutoff } }, select: { id: true, status: true }, take: batch });
  let deleted = 0;
  for (const r of ended) {
    const gone = await prisma.authorityLetterRequest.deleteMany({ where: { id: r.id, status: r.status, endedAt: { lt: cutoff } } });
    if (gone.count === 1) { deleted += 1; await audit(prisma, LETTER_AUDIT.deleted, r.id, null, { endedAs: r.status }); }
  }
  // A signed request keeps the signer's evidence only as long as the letter it was filed as: once that document is
  // purged (its retention ran out, or the account was erased) or gone, the request goes too.
  // A read across every account's letters: the daily job's own named system capability.
  const orphaned = await runAsSystem('authority-letter-sweep', () => prisma.$queryRaw<Array<{ id: string }>>`
    SELECT r.id FROM authority_letter_requests r LEFT JOIN verification_documents d ON d.id = r."documentId"
    WHERE r.status = 'SIGNED' AND (d.id IS NULL OR d."purgedAt" IS NOT NULL) LIMIT ${batch}`);
  for (const r of orphaned) {
    const gone = await prisma.authorityLetterRequest.deleteMany({ where: { id: r.id, status: 'SIGNED' } });
    if (gone.count === 1) { deleted += 1; await audit(prisma, LETTER_AUDIT.deleted, r.id, null, { endedAs: 'SIGNED', reason: 'letter purged' }); }
  }
  return { expired, deleted };
}
