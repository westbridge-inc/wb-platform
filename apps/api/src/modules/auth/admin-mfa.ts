import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { getChannels } from '../../providers/notifications/channels';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { consoleRoleOf } from './console-role';
import { browserClientOf, ADMIN_BROWSER_CLIENT } from './browser-session';
import {
  adminTotpRequired, base32Encode, matchTotp, newRecoveryCodes, newTotpSecret, normaliseRecoveryCode, openTotpSecret,
  otpauthUrl, recoveryDigest, sealTotpSecret,
} from './admin-totp';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 FABLE-03 #2 · REVIEW-2501-A] THE STAFF SESSION POSTURE.
//
// One rule set, two kinds of surface:
//
//   THE ADMIN API (/api/v1/admin/*), always:
//     1. A FIXED LIFETIME. 12 hours from sign-in, however often the session
//        refreshes (refresh keeps createdAt). The first request after that
//        REVOKES the session (S4-7): the admin signs in again.
//     2. A SECOND FACTOR, when ADMIN_TOTP_REQUIRED=1: this session proved an
//        authenticator code (or one recovery code).
//     3. THE CONSOLE ONLY, when ADMIN_API_CONSOLE_ONLY=1 (see "console-bound"
//        below).
//
//   EVERY OTHER STAFF SURFACE — the safety console (/safety SOS board, ops
//   alerts, incident cases, evidence, guardian board), POST /search/sync and
//   the socket war room (live SOS coordinates) — the SAME three rules, while
//   ADMIN_TOTP_REQUIRED=1 (rule 3 while ADMIN_API_CONSOLE_ONLY=1). With both
//   switches off these surfaces behave exactly as before.
//
//   The one exception (COORD ruling, 13 Nov 2026): a responder's phone may
//   ACKNOWLEDGE an ops page (POST /safety/ops-alerts/:id/ack) with a texted-
//   code session. It stops the re-pages for that page only, returns no case
//   data, is audited, and emails the owner every time. The phone's page list
//   shows such a session only that a page is waiting (kind and times), never
//   its words (safety.routes.ts).
//
// CONSOLE-BOUND (S3-1). The console-only rule used to read two request headers
// (X-Swift-Client and Origin), which curl sends as easily as a browser: a token
// taken from the desktop or a phone passed once it was re-sent as a cookie. A
// session now records WHERE it was issued: `sessions.consoleBoundAt` is set
// only by the console's own sign-in (POST /auth/verify-otp from the console
// origin, whose answer carries the credentials only as HttpOnly cookies, never
// in a body). The rule needs that server-side mark AND the cookie transport:
// a token issued to any other client is refused however it is wrapped. What
// it cannot do is tell a browser from a script that copies a console
// cookie: a stolen console cookie is the console. That is what the second
// factor and the 12-hour life are for.
//
// THE SIGN-IN NOTICE: every sign-in of an account holding an admin role emails
// the account's address. Its words come from a fixed list, never from a
// request (S4-3).
// ---------------------------------------------------------------------------

export const ADMIN_SESSION_MAX_HOURS = 12;
export const ADMIN_MFA_PENDING_MINUTES = 10;
/** Codes judged per account in one window before the door rests (both kinds of code). */
export const ADMIN_MFA_MAX_FAILURES = 5;
export const ADMIN_MFA_FAILURE_WINDOW_S = 15 * 60;
/** Wrong codes per account per day before the authenticator-code door rests until the day is over. Recovery codes
 *  still work (inside the 15-minute window), so the only admin is never locked out for good. */
export const ADMIN_MFA_DAY_MAX_FAILURES = 20;
export const ADMIN_MFA_DAY_WINDOW_S = 24 * 3600;

export function adminApiConsoleOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env['ADMIN_API_CONSOLE_ONLY'] === '1';
}

// ── the posture ──────────────────────────────────────────────────────────────

export type StaffSurface = 'admin-api' | 'staff';
export type StaffVerdict = 'OK' | 'EXPIRED' | 'NOT_CONSOLE' | 'MFA';
export interface StaffSessionFacts { createdAt: Date; mfaVerifiedAt: Date | null; consoleBoundAt: Date | null }

/** The posture as a pure decision (see the header). `viaConsole`: the console's cookie, on a console-bound session. */
export function staffSessionVerdict(
  facts: StaffSessionFacts,
  input: { surface: StaffSurface; viaConsole: boolean; now?: Date; env?: Record<string, string | undefined> },
): StaffVerdict {
  const env = input.env ?? process.env;
  const totp = adminTotpRequired(env);
  const consoleOnly = adminApiConsoleOnly(env);
  if (input.surface === 'staff' && !totp && !consoleOnly) return 'OK';
  const now = input.now ?? new Date();
  if ((input.surface === 'admin-api' || totp) && now.getTime() - facts.createdAt.getTime() > ADMIN_SESSION_MAX_HOURS * 3_600_000) return 'EXPIRED';
  if (consoleOnly && !input.viaConsole) return 'NOT_CONSOLE';
  if (totp && !facts.mfaVerifiedAt) return 'MFA';
  return 'OK';
}

type PostureRequest = Pick<FastifyRequest, 'headers'> & {
  authSessionId: string | null; authCredentialSource: 'bearer' | 'cookie' | null; user: { userId: string };
};

const sessionFacts = new WeakMap<object, Promise<StaffSessionFacts | null>>();
/** The session's posture facts, read once per request. */
function factsOf(app: FastifyInstance, request: PostureRequest, sessionId: string): Promise<StaffSessionFacts | null> {
  let facts = sessionFacts.get(request);
  if (!facts) {
    facts = runWithoutTenant(() => app.prisma.session.findUnique({
      where: { id: sessionId }, select: { createdAt: true, mfaVerifiedAt: true, consoleBoundAt: true },
    }), 'staff-session-posture');
    sessionFacts.set(request, facts);
  }
  return facts;
}

/** The request comes from the console: its own cookie, from its own origin, on a session its sign-in issued. */
function viaConsole(request: PostureRequest, facts: StaffSessionFacts): boolean {
  return request.authCredentialSource === 'cookie' && browserClientOf(request) === ADMIN_BROWSER_CLIENT && facts.consoleBoundAt !== null;
}

const REVOKE = Symbol('revoke-staff-session');
type RevokingError = AppError & { [REVOKE]?: { sessionId: string; userId: string } };
/** The session an ADMIN_SESSION_EXPIRED refusal revokes (the auth plugin's onError hook does it). */
export function sessionToRevokeOf(error: unknown): { sessionId: string; userId: string } | null {
  return (error as RevokingError | null)?.[REVOKE] ?? null;
}

function expiredSession(sessionId: string, userId: string): AppError {
  const err: RevokingError = new AppError(401, 'ADMIN_SESSION_EXPIRED', `An admin session lasts ${ADMIN_SESSION_MAX_HOURS} hours. Sign in again.`);
  err[REVOKE] = { sessionId, userId };
  return err;
}

/** The refusal this request earns on a surface, or null. Never throws a refusal itself. */
export async function staffPostureRefusal(app: FastifyInstance, request: PostureRequest, surface: StaffSurface, now = new Date()): Promise<AppError | null> {
  const sessionId = request.authSessionId;
  if (!sessionId) return new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  if (surface === 'staff' && !adminTotpRequired() && !adminApiConsoleOnly()) return null;
  const facts = await factsOf(app, request, sessionId);
  if (!facts) return new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  const verdict = staffSessionVerdict(facts, { surface, viaConsole: viaConsole(request, facts), now });
  if (verdict === 'OK') return null;
  if (verdict === 'EXPIRED') return expiredSession(sessionId, request.user.userId);
  if (verdict === 'NOT_CONSOLE') return new AppError(403, 'ADMIN_CONSOLE_ONLY', 'The admin API answers only the Mission Control web console.');
  const admin = await runWithoutTenant(() => app.prisma.admin.findUnique({ where: { userId: request.user.userId }, select: { totpEnabledAt: true } }), 'staff-session-posture');
  if (!admin?.totpEnabledAt) {
    return new AppError(403, 'ADMIN_MFA_ENROLMENT_REQUIRED', 'Set up your authenticator app first (Security). The admin console needs it.', { mfa: { status: 'GET /auth/admin-mfa', enrol: 'POST /auth/admin-mfa/enrol' } });
  }
  return new AppError(403, 'ADMIN_MFA_REQUIRED', 'Enter the code from your authenticator app to open the admin console.', { mfa: { verify: 'POST /auth/admin-mfa/verify' } });
}

/** The admin API's rules (see the header). Throws the refusal; returns nothing when the request may go on. */
export async function assertAdminSessionPosture(app: FastifyInstance, request: PostureRequest, now = new Date()): Promise<void> {
  const refusal = await staffPostureRefusal(app, request, 'admin-api', now);
  if (refusal) throw refusal;
}

/** A staff surface outside the admin API, for a caller holding an admin role (see the header). */
export async function assertStaffSurfacePosture(app: FastifyInstance, request: PostureRequest, now = new Date()): Promise<void> {
  const refusal = await staffPostureRefusal(app, request, 'staff', now);
  if (refusal) throw refusal;
}

// The refusal a staff surface reads synchronously (safety.routes' ops-role decision), set by the preHandler below.
const staffRefusals = new WeakMap<object, AppError>();
/** preHandler (after app.authenticate): decides the staff posture once for an account holding an admin role. */
export function staffPostureCheck(app: FastifyInstance) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.user || !consoleRoleOf(request.heldRoles)) return;
    const refusal = await staffPostureRefusal(app, request, 'staff');
    if (refusal) staffRefusals.set(request, refusal);
  };
}
/** The staff refusal staffPostureCheck decided for this request, if any. */
export const staffRefusalOf = (request: object): AppError | null => staffRefusals.get(request) ?? null;

/**
 * The 12-hour door on the authenticator routes themselves (S3-2): one texted-code sign-in must not buy a week
 * of guessing. Revokes, as the admin API does.
 */
async function assertSessionYoungEnough(app: FastifyInstance, request: MfaRequest, sessionId: string, now: Date): Promise<void> {
  const session = await runWithoutTenant(() => app.prisma.session.findUnique({ where: { id: sessionId }, select: { createdAt: true } }), 'admin-mfa');
  if (!session) throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
  if (now.getTime() - session.createdAt.getTime() > ADMIN_SESSION_MAX_HOURS * 3_600_000) throw expiredSession(sessionId, request.user.userId);
}

// ── the routes' work ─────────────────────────────────────────────────────────

type MfaRequest = Pick<FastifyRequest, 'ip' | 'headers'> & { authSessionId: string | null; heldRoles?: readonly string[] | null; user: { userId: string } };

function requireAdminAccount(request: MfaRequest): string {
  if (!consoleRoleOf(request.heldRoles)) throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  if (!request.authSessionId) throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
  return request.authSessionId;
}

const ADMIN_FACTOR_FIELDS = { id: true, totpSecretEnc: true, totpPendingSecretEnc: true, totpPendingAt: true, totpEnabledAt: true, totpLastStep: true, totpRecoveryHashes: true } as const;
async function adminRow(app: FastifyInstance, userId: string) {
  const row = await runWithoutTenant(() => app.prisma.admin.findUnique({ where: { userId }, select: ADMIN_FACTOR_FIELDS }), 'admin-mfa');
  if (!row) throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  return row;
}
type AdminFactorRow = Awaited<ReturnType<typeof adminRow>>;

async function audit(app: FastifyInstance, request: MfaRequest, action: string, changes: Record<string, unknown> = {}) {
  await runWithoutTenant(() => app.prisma.auditLog.create({
    data: {
      userId: request.user.userId, action, entity: 'Admin', entityId: request.user.userId, changes: changes as never,
      ipAddress: request.ip, userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'].slice(0, 300) : null,
    },
  }), 'admin-mfa-audit');
}

export async function adminMfaStatus(app: FastifyInstance, request: MfaRequest) {
  const sessionId = requireAdminAccount(request);
  const admin = await adminRow(app, request.user.userId);
  const session = await runWithoutTenant(() => app.prisma.session.findUnique({ where: { id: sessionId }, select: { mfaVerifiedAt: true } }), 'admin-mfa');
  return {
    required: adminTotpRequired(),
    enrolled: !!admin.totpEnabledAt,
    enrolledAt: admin.totpEnabledAt,
    sessionVerified: !!session?.mfaVerifiedAt,
    recoveryCodesLeft: admin.totpRecoveryHashes.length,
  };
}

/**
 * Start enrolment: a fresh secret, held encrypted for 10 minutes until a code from it is confirmed. Needs a fresh
 * proof the caller holds the account (`assertFreshProof`, the sign-in code or a step-up). An enrolled account
 * cannot enrol again here: replacing the app needs the current factor (startAdminMfaReplacement).
 */
export async function startAdminMfaEnrolment(app: FastifyInstance, request: MfaRequest, assertFreshProof: () => Promise<void>, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await assertSessionYoungEnough(app, request, sessionId, now);
  const admin = await adminRow(app, request.user.userId);
  if (admin.totpEnabledAt) throw new AppError(409, 'ADMIN_MFA_ALREADY_ENROLLED', 'An authenticator app is already set up on this account.');
  await assertFreshProof();
  const started = await writePendingSecret(app, admin.id, now);
  await audit(app, request, 'ADMIN_MFA_ENROLMENT_STARTED');
  return started;
}

async function writePendingSecret(app: FastifyInstance, adminId: string, now: Date) {
  const secret = newTotpSecret();
  const sealed = await sealTotpSecret(secret);
  await runWithoutTenant(() => app.prisma.admin.update({ where: { id: adminId }, data: { totpPendingSecretEnc: sealed, totpPendingAt: now } }), 'admin-mfa');
  const secretB32 = base32Encode(secret);
  return { secret: secretB32, otpauthUrl: otpauthUrl(secretB32), expiresInSeconds: ADMIN_MFA_PENDING_MINUTES * 60 };
}

/** The pending secret, opened, if it is still inside its 10 minutes. */
async function openPending(admin: AdminFactorRow, now: Date): Promise<Buffer> {
  if (!admin.totpPendingSecretEnc || !admin.totpPendingAt || now.getTime() - admin.totpPendingAt.getTime() > ADMIN_MFA_PENDING_MINUTES * 60_000) {
    throw new AppError(409, 'ADMIN_MFA_ENROLMENT_EXPIRED', 'Start the authenticator set-up again: it waits 10 minutes for a code.');
  }
  return openTotpSecret(admin.totpPendingSecretEnc);
}

/** Confirm enrolment with a code from the new secret: the factor is on, this session is verified, and the
 *  recovery codes are returned ONCE. */
export async function confirmAdminMfaEnrolment(app: FastifyInstance, request: MfaRequest, code: string, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await assertSessionYoungEnough(app, request, sessionId, now);
  const admin = await adminRow(app, request.user.userId);
  if (admin.totpEnabledAt) throw new AppError(409, 'ADMIN_MFA_ALREADY_ENROLLED', 'An authenticator app is already set up on this account.');
  const secret = await openPending(admin, now);
  await reserveAttempt(app, request, 'code');
  const step = matchTotp(secret, code.trim(), now.getTime(), null);
  if (step === null) {
    await recordFailure(app, request);
    throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That code does not match. Check the time on your phone and try the newest code.');
  }
  const recoveryCodes = newRecoveryCodes();
  const done = await runWithoutTenant(() => app.prisma.admin.updateMany({
    where: { id: admin.id, totpEnabledAt: null, totpPendingSecretEnc: admin.totpPendingSecretEnc },
    data: {
      totpSecretEnc: admin.totpPendingSecretEnc, totpPendingSecretEnc: null, totpPendingAt: null, totpEnabledAt: now,
      totpLastStep: step, totpRecoveryHashes: recoveryCodes.map((c) => recoveryDigest(secret, c)),
    },
  }), 'admin-mfa');
  if (done.count !== 1) throw new AppError(409, 'ADMIN_MFA_ENROLMENT_RACED', 'The set-up changed meanwhile. Reload and start again.');
  await clearAttempts(app, request.user.userId);
  await markSessionVerified(app, sessionId, now);
  await audit(app, request, 'ADMIN_MFA_ENROLLED');
  await notifyAdmin(app, request.user.userId, 'Swift: an authenticator app was set up on your admin account',
    'An authenticator app was just set up as the second step for signing in to your Swift admin account.');
  return { enrolled: true, recoveryCodes };
}

type FactorInput = { code?: string | undefined; recoveryCode?: string | undefined };

/**
 * Prove the CURRENT factor: an authenticator code (accepted once: the step only moves forward, compare-and-set) or
 * one recovery code (spent, compare-and-set). Each attempt is reserved before it is judged (S3-2).
 */
async function proveCurrentFactor(app: FastifyInstance, request: MfaRequest, admin: AdminFactorRow, input: FactorInput, now: Date): Promise<{ via: 'code' | 'recovery'; left: number }> {
  if (!admin.totpEnabledAt || !admin.totpSecretEnc) throw new AppError(409, 'ADMIN_MFA_NOT_ENROLLED', 'Set up your authenticator app first.');
  const secret = await openTotpSecret(admin.totpSecretEnc);
  if (input.recoveryCode) {
    await reserveAttempt(app, request, 'recovery');
    const digest = recoveryDigest(secret, input.recoveryCode);
    if (normaliseRecoveryCode(input.recoveryCode).length !== 10 || !admin.totpRecoveryHashes.includes(digest)) {
      await recordFailure(app, request);
      throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That recovery code is not valid, or was already used.');
    }
    const spent = await runWithoutTenant(() => app.prisma.admin.updateMany({
      where: { id: admin.id, totpRecoveryHashes: { has: digest } },
      data: { totpRecoveryHashes: admin.totpRecoveryHashes.filter((h) => h !== digest) },
    }), 'admin-mfa');
    if (spent.count !== 1) throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That recovery code is not valid, or was already used.');
    await clearAttempts(app, request.user.userId);
    const left = admin.totpRecoveryHashes.length - 1;
    await audit(app, request, 'ADMIN_MFA_RECOVERY_CODE_USED', { left });
    await notifyAdmin(app, request.user.userId, 'Swift: a recovery code was used on your admin account',
      `A recovery code was just used instead of your authenticator app on your Swift admin account. ${left} recovery codes are left.`);
    return { via: 'recovery', left };
  }
  await reserveAttempt(app, request, 'code');
  const step = matchTotp(secret, (input.code ?? '').trim(), now.getTime(), admin.totpLastStep);
  if (step === null) {
    await recordFailure(app, request);
    throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That code does not match, or was already used. Try the newest code.');
  }
  // A code is accepted once: the step only moves forward (compare-and-set).
  const moved = await runWithoutTenant(() => app.prisma.admin.updateMany({
    where: { id: admin.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  }), 'admin-mfa');
  if (moved.count !== 1) throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That code was already used. Wait for the next one.');
  await clearAttempts(app, request.user.userId);
  return { via: 'code', left: admin.totpRecoveryHashes.length };
}

/** Prove an authenticator code (or one recovery code) for THIS session. */
export async function verifyAdminMfa(app: FastifyInstance, request: MfaRequest, input: FactorInput, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await assertSessionYoungEnough(app, request, sessionId, now);
  const admin = await adminRow(app, request.user.userId);
  const proved = await proveCurrentFactor(app, request, admin, input, now);
  await markSessionVerified(app, sessionId, now);
  if (proved.via === 'recovery') return { verified: true, recoveryCodesLeft: proved.left };
  await audit(app, request, 'ADMIN_MFA_VERIFIED');
  return { verified: true };
}

/** [S4-6] New recovery codes (all old ones stop working), proved by the current authenticator code or a recovery code. */
export async function regenerateAdminRecoveryCodes(app: FastifyInstance, request: MfaRequest, input: FactorInput, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await assertSessionYoungEnough(app, request, sessionId, now);
  const admin = await adminRow(app, request.user.userId);
  await proveCurrentFactor(app, request, admin, input, now);
  const secret = await openTotpSecret(admin.totpSecretEnc!);
  const recoveryCodes = newRecoveryCodes();
  await runWithoutTenant(() => app.prisma.admin.update({ where: { id: admin.id }, data: { totpRecoveryHashes: recoveryCodes.map((c) => recoveryDigest(secret, c)) } }), 'admin-mfa');
  await markSessionVerified(app, sessionId, now);
  await audit(app, request, 'ADMIN_MFA_RECOVERY_CODES_REPLACED', { count: recoveryCodes.length });
  await notifyAdmin(app, request.user.userId, 'Swift: new recovery codes were made for your admin account',
    'New recovery codes were just made for your Swift admin account. The old ones no longer work.');
  return { recoveryCodes };
}

/** [S4-6] Move to a new authenticator app: proved by the current factor, then confirmed with a code from the new one. */
export async function startAdminMfaReplacement(app: FastifyInstance, request: MfaRequest, input: FactorInput, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await assertSessionYoungEnough(app, request, sessionId, now);
  const admin = await adminRow(app, request.user.userId);
  await proveCurrentFactor(app, request, admin, input, now);
  await markSessionVerified(app, sessionId, now);
  const started = await writePendingSecret(app, admin.id, now);
  await audit(app, request, 'ADMIN_MFA_REPLACEMENT_STARTED');
  return started;
}

export async function confirmAdminMfaReplacement(app: FastifyInstance, request: MfaRequest, code: string, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await assertSessionYoungEnough(app, request, sessionId, now);
  const admin = await adminRow(app, request.user.userId);
  if (!admin.totpEnabledAt) throw new AppError(409, 'ADMIN_MFA_NOT_ENROLLED', 'Set up your authenticator app first.');
  const secret = await openPending(admin, now);
  await reserveAttempt(app, request, 'code');
  const step = matchTotp(secret, code.trim(), now.getTime(), null);
  if (step === null) {
    await recordFailure(app, request);
    throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That code does not match. Check the time on your phone and try the newest code.');
  }
  const recoveryCodes = newRecoveryCodes();
  const done = await runWithoutTenant(() => app.prisma.admin.updateMany({
    where: { id: admin.id, totpPendingSecretEnc: admin.totpPendingSecretEnc },
    data: {
      totpSecretEnc: admin.totpPendingSecretEnc, totpPendingSecretEnc: null, totpPendingAt: null, totpEnabledAt: now,
      totpLastStep: step, totpRecoveryHashes: recoveryCodes.map((c) => recoveryDigest(secret, c)),
    },
  }), 'admin-mfa');
  if (done.count !== 1) throw new AppError(409, 'ADMIN_MFA_ENROLMENT_RACED', 'The set-up changed meanwhile. Reload and start again.');
  await clearAttempts(app, request.user.userId);
  await markSessionVerified(app, sessionId, now);
  await audit(app, request, 'ADMIN_MFA_REPLACED');
  await notifyAdmin(app, request.user.userId, 'Swift: your admin account moved to a new authenticator app',
    'Your Swift admin account now uses a new authenticator app. The old app and the old recovery codes no longer work.');
  return { replaced: true, recoveryCodes };
}

async function markSessionVerified(app: FastifyInstance, sessionId: string, now: Date) {
  await runWithoutTenant(() => app.prisma.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } }), 'admin-mfa');
}

// ── step-up for an enrolled admin (S3-3) ─────────────────────────────────────

/** Whether this account confirms a step-up with its authenticator app (an admin who set one up) instead of a text. */
export async function stepUpUsesAuthenticator(app: FastifyInstance, userId: string): Promise<boolean> {
  const row = await runWithoutTenant(() => app.prisma.admin.findUnique({ where: { userId }, select: { totpEnabledAt: true } }), 'admin-mfa-step-up');
  return !!row?.totpEnabledAt;
}

export function authenticatorStepUpAnswer(): AppError {
  return new AppError(409, 'STEP_UP_USE_AUTHENTICATOR', 'Your admin account confirms it is you with your authenticator app: enter its 6-digit code. No text is sent.', { stepUp: { method: 'authenticator', verify: 'POST /auth/step-up/verify' } });
}

/** A step-up proved by the authenticator code: the same matcher, the same once-only step, the same attempt budget. */
export async function verifyStepUpWithAuthenticator(app: FastifyInstance, request: MfaRequest, code: string, now = new Date()): Promise<void> {
  const admin = await adminRow(app, request.user.userId);
  await proveCurrentFactor(app, request, admin, { code }, now);
  await audit(app, request, 'ADMIN_STEP_UP_AUTHENTICATOR');
}

// ── attempts (S3-2, S4-2) ────────────────────────────────────────────────────

const failureKey = (userId: string) => `admin_mfa_fail:${userId}`;
const dayKey = (userId: string) => `admin_mfa_fail_day:${userId}`;
/** INCR and the window's expiry in ONE step: a key never lives without its expiry (S4-2), and a key found without
 *  one is given it. Returns the count after the increment. */
const INCR_WITH_WINDOW = "local n = redis.call('INCR', KEYS[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return n";

async function incrWithin(app: FastifyInstance, key: string, windowS: number): Promise<number> {
  return Number(await app.redis.eval(INCR_WITH_WINDOW, 1, key, String(windowS)));
}

/**
 * Reserve one judged attempt BEFORE the code is compared: concurrent guesses each take a place, so no more than
 * ADMIN_MFA_MAX_FAILURES are ever judged in one window. An authenticator code also needs the day under its limit.
 */
async function reserveAttempt(app: FastifyInstance, request: MfaRequest, factor: 'code' | 'recovery'): Promise<void> {
  const userId = request.user.userId;
  if (factor === 'code' && Number((await app.redis.get(dayKey(userId))) ?? 0) >= ADMIN_MFA_DAY_MAX_FAILURES) {
    throw new AppError(429, 'ADMIN_MFA_RESTING', 'Too many wrong codes today. Use one of your recovery codes, or try again tomorrow.');
  }
  const n = await incrWithin(app, failureKey(userId), ADMIN_MFA_FAILURE_WINDOW_S);
  if (n > ADMIN_MFA_MAX_FAILURES) {
    throw new AppError(429, 'ADMIN_MFA_RESTING', 'Too many wrong codes. Wait 15 minutes, then try again.');
  }
}

/** A wrong code: count it for the day, and tell the owner when a limit is reached. */
async function recordFailure(app: FastifyInstance, request: MfaRequest): Promise<void> {
  const userId = request.user.userId;
  const day = await incrWithin(app, dayKey(userId), ADMIN_MFA_DAY_WINDOW_S);
  const window = Number((await app.redis.get(failureKey(userId))) ?? 0);
  if (window === ADMIN_MFA_MAX_FAILURES || day === ADMIN_MFA_DAY_MAX_FAILURES) {
    await audit(app, request, 'ADMIN_MFA_RESTING', { today: day });
    await notifyOwners(app, userId, 'Swift: wrong authenticator codes on an admin account',
      `${day} wrong authenticator or recovery codes were entered today on a Swift admin account, after a successful texted sign-in code. Code entry is paused for a while.`);
  }
}

async function clearAttempts(app: FastifyInstance, userId: string): Promise<void> {
  await app.redis.del(failureKey(userId));
}

// ── notices ──────────────────────────────────────────────────────────────────

const whenNow = () => `${new Date().toLocaleString('en-GB', { timeZone: 'America/Guyana', dateStyle: 'medium', timeStyle: 'short' })} (Guyana time)`;
const IF_NOT_YOU = 'If this was not you: call your carrier to lock your SIM, sign out of every device, and contact the Swift owner at once.';

async function sendTo(emails: string[], subject: string, lead: string) {
  const body = [lead, '', `  When: ${whenNow()}`, '', IF_NOT_YOU].join('\n');
  for (const email of emails) await getChannels().email.sendEmail(email, subject, body);
}

/** The account's own address (best effort, never blocks). */
async function notifyAdmin(app: FastifyInstance, userId: string, subject: string, lead: string) {
  try {
    const user = await runWithoutTenant(() => app.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }), 'admin-mfa-notice');
    if (user?.email) await sendTo([user.email], subject, lead);
  } catch (err) {
    log().warn({ err }, '[admin-mfa] notice email could not be sent');
  }
}

/** The owner (every active SUPER_ADMIN with an address) and the account itself (best effort, never blocks). */
export async function notifyOwners(app: FastifyInstance, userId: string, subject: string, lead: string) {
  try {
    const rows = await runWithoutTenant(() => app.prisma.user.findMany({
      where: { OR: [{ id: userId }, { status: 'ACTIVE', roles: { has: 'SUPER_ADMIN' } }], email: { not: null } },
      select: { email: true }, take: 20,
    }), 'admin-mfa-notice');
    const emails = [...new Set(rows.map((r) => r.email!.trim().toLowerCase()).filter(Boolean))];
    await sendTo(emails, subject, lead);
  } catch (err) {
    log().warn({ err }, '[admin-mfa] owner notice could not be sent');
  }
}

/** [S4-3] Where a sign-in came from, in Swift's words only: never text a request supplied. */
export function signInPlaceWords(input: { browserClient: string | null; deviceType: string | null | undefined }): string {
  if (input.browserClient === ADMIN_BROWSER_CLIENT) return 'Mission Control (web)';
  if (input.browserClient === 'web') return 'the Swift website';
  switch ((input.deviceType ?? '').trim().toLowerCase()) {
    case 'ios': return 'the iPhone app';
    case 'android': return 'the Android app';
    case 'desktop': return 'Mission Control (desktop)';
    default: return 'a device Swift could not name';
  }
}

/** [FABLE-03 #2 (4)] Every sign-in of an account holding an admin role is emailed to the account's address. */
export async function notifyAdminSignIn(app: FastifyInstance, user: { id: string; roles?: readonly string[] | null }, place: { browserClient: string | null; deviceType?: string | null }): Promise<void> {
  if (!consoleRoleOf(user.roles ?? null)) return;
  await notifyAdmin(app, user.id, 'Swift: new sign-in to your admin account', `Your Swift admin account was just signed in to on ${signInPlaceWords({ browserClient: place.browserClient, deviceType: place.deviceType })}.`);
}

/**
 * [COORD ruling 13 Nov 2026] An ops page acknowledged by a session without the console posture (the responder's
 * phone): audited, and the owner is emailed every time. The page's words are never in the email.
 */
export async function recordAckWithoutConsolePosture(app: FastifyInstance, request: MfaRequest, opsAlertId: string, refusal: AppError): Promise<void> {
  await audit(app, request, 'OPS_ALERT_ACK_WITHOUT_MFA', { opsAlertId, posture: refusal.code });
  await notifyOwners(app, request.user.userId, 'Swift: an ops page was acknowledged from a phone',
    'An ops page was just acknowledged from a phone signed in with a texted code (no authenticator code). Acknowledging stops the re-pages for that page only; it shows no case details. Check Mission Control that someone is handling it.');
}
