import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, ForbiddenError } from '../../utils/errors';
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
// [AUDIT-20261113 FABLE-03 #2] THE ADMIN SESSION POSTURE.
//
// Four rules for a request to the admin API (/api/v1/admin/*):
//   1. A FIXED LIFETIME. An admin session reaches the admin API for 12 hours
//      from its sign-in, however often it refreshes (refresh keeps createdAt);
//      then the admin signs in again. Always on.
//   2. A SECOND FACTOR, when ADMIN_TOTP_REQUIRED=1: the session must have
//      proved an authenticator code (POST /auth/admin-mfa/verify). An admin
//      who has not enrolled is told to enrol (POST /auth/admin-mfa/enrol,
//      which needs a fresh sign-in or step-up code). Off by default, so the
//      owner enrols first and then switches it on.
//   3. THE CONSOLE ONLY, when ADMIN_API_CONSOLE_ONLY=1: the request must be
//      the admin web console's own cookie session from the console origin,
//      never a bearer token from any other client. Off by default: Mission
//      Control (desktop) signs in with a bearer token today.
//   4. A SIGN-IN NOTICE: every sign-in of an account holding an admin role
//      emails the address on the account (best effort; never blocks sign-in).
// ---------------------------------------------------------------------------

export const ADMIN_SESSION_MAX_HOURS = 12;
export const ADMIN_MFA_PENDING_MINUTES = 10;
/** Wrong authenticator codes allowed per account in the window before the door rests. */
export const ADMIN_MFA_MAX_FAILURES = 5;
export const ADMIN_MFA_FAILURE_WINDOW_S = 15 * 60;

export function adminApiConsoleOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env['ADMIN_API_CONSOLE_ONLY'] === '1';
}

type PostureRequest = Pick<FastifyRequest, 'headers'> & { authSessionId: string | null; authCredentialSource: 'bearer' | 'cookie' | null; user: { userId: string } };

/** The admin API's session rules (see the header). Throws the refusal; returns nothing when the request may go on. */
export async function assertAdminSessionPosture(app: FastifyInstance, request: PostureRequest, now = new Date()): Promise<void> {
  const sessionId = request.authSessionId;
  if (!sessionId) throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  const session = await runWithoutTenant(() => app.prisma.session.findUnique({ where: { id: sessionId }, select: { createdAt: true, mfaVerifiedAt: true } }), 'admin-session-posture');
  if (!session) throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  if (now.getTime() - session.createdAt.getTime() > ADMIN_SESSION_MAX_HOURS * 3_600_000) {
    throw new AppError(401, 'ADMIN_SESSION_EXPIRED', `An admin session lasts ${ADMIN_SESSION_MAX_HOURS} hours. Sign in again.`);
  }
  if (adminApiConsoleOnly() && !(request.authCredentialSource === 'cookie' && browserClientOf(request) === ADMIN_BROWSER_CLIENT)) {
    throw new ForbiddenError('The admin API answers only the Mission Control web console.');
  }
  if (!adminTotpRequired()) return;
  if (session.mfaVerifiedAt) return;
  const admin = await runWithoutTenant(() => app.prisma.admin.findUnique({ where: { userId: request.user.userId }, select: { totpEnabledAt: true } }), 'admin-session-posture');
  if (!admin?.totpEnabledAt) {
    throw new AppError(403, 'ADMIN_MFA_ENROLMENT_REQUIRED', 'Set up your authenticator app first (Security). The admin console needs it.', { mfa: { status: 'GET /auth/admin-mfa', enrol: 'POST /auth/admin-mfa/enrol' } });
  }
  throw new AppError(403, 'ADMIN_MFA_REQUIRED', 'Enter the code from your authenticator app to open the admin console.', { mfa: { verify: 'POST /auth/admin-mfa/verify' } });
}

// ── the routes' work ─────────────────────────────────────────────────────────

type MfaRequest = Pick<FastifyRequest, 'ip' | 'headers'> & { authSessionId: string | null; heldRoles?: readonly string[] | null; user: { userId: string } };

function requireAdminAccount(request: MfaRequest): string {
  if (!consoleRoleOf(request.heldRoles)) throw new ForbiddenError('Admin access required');
  if (!request.authSessionId) throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
  return request.authSessionId;
}

async function adminRow(app: FastifyInstance, userId: string) {
  const row = await runWithoutTenant(() => app.prisma.admin.findUnique({
    where: { userId },
    select: { id: true, totpSecretEnc: true, totpPendingSecretEnc: true, totpPendingAt: true, totpEnabledAt: true, totpLastStep: true, totpRecoveryHashes: true },
  }), 'admin-mfa');
  if (!row) throw new ForbiddenError('Admin access required');
  return row;
}

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
 * cannot enrol again here: replacing a factor needs the current one (recovery is a separate, audited path).
 */
export async function startAdminMfaEnrolment(app: FastifyInstance, request: MfaRequest, assertFreshProof: () => Promise<void>, now = new Date()) {
  requireAdminAccount(request);
  const admin = await adminRow(app, request.user.userId);
  if (admin.totpEnabledAt) throw new AppError(409, 'ADMIN_MFA_ALREADY_ENROLLED', 'An authenticator app is already set up on this account.');
  await assertFreshProof();
  const secret = newTotpSecret();
  const sealed = await sealTotpSecret(secret);
  await runWithoutTenant(() => app.prisma.admin.update({ where: { id: admin.id }, data: { totpPendingSecretEnc: sealed, totpPendingAt: now } }), 'admin-mfa');
  await audit(app, request, 'ADMIN_MFA_ENROLMENT_STARTED');
  const secretB32 = base32Encode(secret);
  return { secret: secretB32, otpauthUrl: otpauthUrl(secretB32), expiresInSeconds: ADMIN_MFA_PENDING_MINUTES * 60 };
}

/** Confirm enrolment with a code from the new secret: the factor is on, this session is verified, and the
 *  recovery codes are returned ONCE. */
export async function confirmAdminMfaEnrolment(app: FastifyInstance, request: MfaRequest, code: string, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await refuseWhileResting(app, request.user.userId);
  const admin = await adminRow(app, request.user.userId);
  if (admin.totpEnabledAt) throw new AppError(409, 'ADMIN_MFA_ALREADY_ENROLLED', 'An authenticator app is already set up on this account.');
  if (!admin.totpPendingSecretEnc || !admin.totpPendingAt || now.getTime() - admin.totpPendingAt.getTime() > ADMIN_MFA_PENDING_MINUTES * 60_000) {
    throw new AppError(409, 'ADMIN_MFA_ENROLMENT_EXPIRED', 'Start the authenticator set-up again: it waits 10 minutes for a code.');
  }
  const secret = await openTotpSecret(admin.totpPendingSecretEnc);
  const step = matchTotp(secret, code.trim(), now.getTime(), null);
  if (step === null) {
    await countFailure(app, request.user.userId);
    throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That code does not match. Check the time on your phone and try the newest code.');
  }
  const recoveryCodes = newRecoveryCodes();
  const done = await runWithoutTenant(() => app.prisma.admin.updateMany({
    where: { id: admin.id, totpEnabledAt: null, totpPendingSecretEnc: admin.totpPendingSecretEnc },
    data: {
      totpSecretEnc: admin.totpPendingSecretEnc, totpPendingSecretEnc: null, totpPendingAt: null, totpEnabledAt: now,
      totpLastStep: step, totpRecoveryHashes: recoveryCodes.map(recoveryDigest),
    },
  }), 'admin-mfa');
  if (done.count !== 1) throw new AppError(409, 'ADMIN_MFA_ENROLMENT_RACED', 'The set-up changed meanwhile. Reload and start again.');
  await markSessionVerified(app, sessionId, now);
  await audit(app, request, 'ADMIN_MFA_ENROLLED');
  await notifyAdmin(app, request.user.userId, 'Swift: an authenticator app was set up on your admin account',
    'An authenticator app was just set up as the second step for signing in to your Swift admin account.');
  return { enrolled: true, recoveryCodes };
}

/** Prove an authenticator code (or one recovery code) for THIS session. */
export async function verifyAdminMfa(app: FastifyInstance, request: MfaRequest, input: { code?: string; recoveryCode?: string }, now = new Date()) {
  const sessionId = requireAdminAccount(request);
  await refuseWhileResting(app, request.user.userId);
  const admin = await adminRow(app, request.user.userId);
  if (!admin.totpEnabledAt || !admin.totpSecretEnc) throw new AppError(409, 'ADMIN_MFA_NOT_ENROLLED', 'Set up your authenticator app first.');
  if (input.recoveryCode) {
    const digest = recoveryDigest(input.recoveryCode);
    if (normaliseRecoveryCode(input.recoveryCode).length !== 10 || !admin.totpRecoveryHashes.includes(digest)) {
      await countFailure(app, request.user.userId);
      throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That recovery code is not valid, or was already used.');
    }
    const spent = await runWithoutTenant(() => app.prisma.admin.updateMany({
      where: { id: admin.id, totpRecoveryHashes: { has: digest } },
      data: { totpRecoveryHashes: admin.totpRecoveryHashes.filter((h) => h !== digest) },
    }), 'admin-mfa');
    if (spent.count !== 1) throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That recovery code is not valid, or was already used.');
    await markSessionVerified(app, sessionId, now);
    await audit(app, request, 'ADMIN_MFA_RECOVERY_CODE_USED', { left: admin.totpRecoveryHashes.length - 1 });
    await notifyAdmin(app, request.user.userId, 'Swift: a recovery code was used on your admin account',
      `A recovery code was just used instead of your authenticator app to sign in to your Swift admin account. ${admin.totpRecoveryHashes.length - 1} recovery codes are left.`);
    return { verified: true, recoveryCodesLeft: admin.totpRecoveryHashes.length - 1 };
  }
  const secret = await openTotpSecret(admin.totpSecretEnc);
  const step = matchTotp(secret, (input.code ?? '').trim(), now.getTime(), admin.totpLastStep);
  if (step === null) {
    await countFailure(app, request.user.userId);
    throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That code does not match, or was already used. Try the newest code.');
  }
  // A code is accepted once: the step only moves forward (compare-and-set).
  const moved = await runWithoutTenant(() => app.prisma.admin.updateMany({
    where: { id: admin.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  }), 'admin-mfa');
  if (moved.count !== 1) throw new AppError(400, 'ADMIN_MFA_CODE_INVALID', 'That code was already used. Wait for the next one.');
  await markSessionVerified(app, sessionId, now);
  await audit(app, request, 'ADMIN_MFA_VERIFIED');
  return { verified: true };
}

async function markSessionVerified(app: FastifyInstance, sessionId: string, now: Date) {
  await runWithoutTenant(() => app.prisma.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } }), 'admin-mfa');
}

const failureKey = (userId: string) => `admin_mfa_fail:${userId}`;
async function refuseWhileResting(app: FastifyInstance, userId: string) {
  const failures = Number((await app.redis.get(failureKey(userId))) ?? 0);
  if (failures >= ADMIN_MFA_MAX_FAILURES) {
    throw new AppError(429, 'ADMIN_MFA_RESTING', 'Too many wrong codes. Wait 15 minutes, then try again.');
  }
}
async function countFailure(app: FastifyInstance, userId: string) {
  const n = await app.redis.incr(failureKey(userId));
  if (n === 1) await app.redis.expire(failureKey(userId), ADMIN_MFA_FAILURE_WINDOW_S);
}

// ── the sign-in notice ───────────────────────────────────────────────────────

async function notifyAdmin(app: FastifyInstance, userId: string, subject: string, lead: string) {
  try {
    const user = await runWithoutTenant(() => app.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }), 'admin-mfa-notice');
    if (!user?.email) return;
    const when = `${new Date().toLocaleString('en-GB', { timeZone: 'America/Guyana', dateStyle: 'medium', timeStyle: 'short' })} (Guyana time)`;
    const body = [lead, '', `  When: ${when}`, '', 'If this was not you: call your carrier to lock your SIM, sign out of every device, and contact the Swift owner at once.'].join('\n');
    await getChannels().email.sendEmail(user.email, subject, body);
  } catch (err) {
    log().warn({ err }, '[admin-mfa] notice email could not be sent');
  }
}

/** [FABLE-03 #2 (4)] Every sign-in of an account holding an admin role is emailed to the account's address. */
export async function notifyAdminSignIn(app: FastifyInstance, user: { id: string; roles?: readonly string[] | null }, device: { deviceType?: string | null }): Promise<void> {
  if (!consoleRoleOf(user.roles ?? null)) return;
  const kind = device.deviceType && device.deviceType !== 'unknown' ? ` on ${String(device.deviceType).slice(0, 40)}` : '';
  await notifyAdmin(app, user.id, 'Swift: new sign-in to your admin account', `Your Swift admin account was just signed in to${kind}.`);
}
