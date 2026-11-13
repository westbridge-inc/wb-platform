import type { FastifyInstance } from 'fastify';
import { AuthService } from './auth.service';
import { consoleRoleOf } from './console-role';
import { maskPhone } from './step-up';
import { resolveIdentityById, resolveIdentityByPhone } from './preauth-identity';
import { runWithTenant, runWithoutTenant } from '../../plugins/tenant-context';
import { getChannels } from '../../providers/notifications/channels';
import { adminMfaAccountCeilingKey } from './admin-mfa';

// ---------------------------------------------------------------------------
// [REVIEW-2501-B B-S4-7] BREAK-GLASS for the admin authenticator (TOTP).
//
// Production has ONE admin. If that admin loses the authenticator app AND the
// recovery codes, if MASTER_KEK is lost or changed (both kinds of code then fail,
// REVIEW-2501-A D-S4-1), or if someone else enrolled first (trust on first use,
// probe B2), no code path in the API can clear `admins.totp*`. This is the one
// audited way back, for someone who already holds the server and its database:
//
//   docker compose -f deploy/docker-compose.yml exec api node dist/scripts/admin-mfa-reset.js
//
// It asks for the admin (phone in +592 form, or the account id), shows a masked
// summary, and then needs the operator's name, a reason, and a typed
// confirmation naming the account. Then, in ONE database transaction under the
// account's lock: the authenticator secret, any pending set-up, the last step and
// every recovery code are cleared, EVERY session of the account is revoked
// (sockets are dropped), and an audit row is written; the account's daily
// ceiling on authenticator guesses starts again. Then the admin is emailed
// and texted. Nothing secret is read or printed: the script never decrypts.
//
// The admin then signs in again with a texted code and sets up a new
// authenticator at once (deploy/INCIDENT-RUNBOOK.md, deploy/PILOT-RUNBOOK.md).
// ---------------------------------------------------------------------------

export const ADMIN_MFA_RESET_AUDIT_ACTION = 'ADMIN_MFA_BREAK_GLASS_RESET';

export interface AdminForReset {
  userId: string;
  tenantId: string;
  maskedPhone: string;
  lastFour: string;
  enrolledAt: Date | null;
  pending: boolean;
  recoveryCodesLeft: number;
  activeSessions: number;
}

/** The admin the operator named, or a refusal in words (never the full number). */
export async function findAdminForReset(app: FastifyInstance, who: string): Promise<AdminForReset> {
  const lookup = who.trim();
  if (!lookup) throw new Error('Name the admin: their phone number in +592 form, or their account id.');
  const identity = lookup.startsWith('+') ? await resolveIdentityByPhone(app.prisma, lookup) : await resolveIdentityById(app.prisma, lookup);
  if (!identity) throw new Error('No account matches that.');
  const row = await runWithoutTenant(() => app.prisma.user.findUnique({
    where: { id: identity.id },
    select: { phone: true, roles: true, admin: { select: { totpEnabledAt: true, totpPendingSecretEnc: true, totpRecoveryHashes: true } } },
  }), 'admin-mfa-break-glass');
  if (!row?.admin || !consoleRoleOf(row.roles)) throw new Error('That account is not an admin. Nothing to reset.');
  const activeSessions = await runWithoutTenant(() => app.prisma.session.count({ where: { userId: identity.id, expiresAt: { gt: new Date() } } }), 'admin-mfa-break-glass');
  return {
    userId: identity.id,
    tenantId: identity.tenantId,
    maskedPhone: maskPhone(row.phone),
    lastFour: row.phone.replace(/\D/g, '').slice(-4),
    enrolledAt: row.admin.totpEnabledAt,
    pending: row.admin.totpPendingSecretEnc !== null,
    recoveryCodesLeft: row.admin.totpRecoveryHashes.length,
    activeSessions,
  };
}

/** The words the operator must type: they name the account, so a reset of the wrong admin cannot be typed by habit. */
export const resetConfirmationFor = (target: Pick<AdminForReset, 'lastFour'>) => `RESET ADMIN ${target.lastFour}`;

export interface ResetInput { operator: string; reason: string; now?: Date }

/**
 * Clear the account's authenticator and recovery codes, revoke every session, and write the audit row, all in one
 * transaction under the account's lock; then email and text the admin (best effort, reported).
 */
export async function resetAdminAuthenticator(app: FastifyInstance, target: AdminForReset, input: ResetInput) {
  const operator = input.operator.trim().slice(0, 120);
  const reason = input.reason.trim().slice(0, 500);
  if (operator.length < 2) throw new Error('Type your name: it goes in the audit record.');
  if (reason.length < 5) throw new Error('Type the reason: it goes in the audit record.');
  const now = input.now ?? new Date();
  const sessionsBefore = target.activeSessions;
  await runWithTenant(target.tenantId, () => new AuthService(app).logoutAll(target.userId, async (tx) => {
    const cleared = await tx.admin.updateMany({
      where: { userId: target.userId },
      data: { totpSecretEnc: null, totpPendingSecretEnc: null, totpPendingAt: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [] },
    });
    if (cleared.count !== 1) throw new Error('The admin row changed meanwhile. Nothing was reset.');
    await tx.auditLog.create({ data: {
      userId: target.userId, action: ADMIN_MFA_RESET_AUDIT_ACTION, entity: 'Admin', entityId: target.userId,
      changes: { operator, reason, wasEnrolledAt: target.enrolledAt?.toISOString() ?? null, recoveryCodesCleared: target.recoveryCodesLeft, sessionsRevoked: sessionsBefore, at: now.toISOString() },
      ipAddress: null, userAgent: 'ops-script:admin-mfa-reset',
    } });
  }));
  // The account ceiling on authenticator guesses starts again with the new enrolment.
  await app.redis.del(adminMfaAccountCeilingKey(target.userId));
  const notified = await notifyReset(app, target.userId);
  return { cleared: true as const, sessionsRevoked: sessionsBefore, ...notified };
}

const RESET_SUBJECT = 'Swift: your admin authenticator was reset by an operator';
const RESET_TEXT = 'A Swift operator just cleared the authenticator app and recovery codes on your Swift admin account and signed out every device. Sign in again with a texted code and set up your authenticator app at once. If you did not ask for this, contact the Swift owner now.';

async function notifyReset(app: FastifyInstance, userId: string): Promise<{ emailed: boolean; texted: boolean }> {
  const user = await runWithoutTenant(() => app.prisma.user.findUnique({ where: { id: userId }, select: { email: true, phone: true } }), 'admin-mfa-break-glass');
  let emailed = false; let texted = false;
  if (user?.email) {
    try { await getChannels().email.sendEmail(user.email, RESET_SUBJECT, RESET_TEXT); emailed = true; } catch { /* reported below */ }
  }
  if (user?.phone) {
    try { await getChannels().sms.sendSms(user.phone, `Swift: ${RESET_TEXT}`); texted = true; } catch { /* reported below */ }
  }
  return { emailed, texted };
}

export interface ResetConsole { ask: (question: string) => Promise<string>; print: (line: string) => void }

/** The interactive break-glass (the script's whole flow; dist/scripts/admin-mfa-reset.js wires it to the terminal). Exit code. */
export async function adminMfaResetMain(app: FastifyInstance, io: ResetConsole): Promise<number> {
  io.print('BREAK-GLASS: clear one admin\'s authenticator app and recovery codes, and sign out all of their devices.');
  let target: AdminForReset;
  try {
    target = await findAdminForReset(app, await io.ask('Admin phone (+592...) or account id: '));
  } catch (error) {
    io.print(`REFUSED: ${error instanceof Error ? error.message : 'the account could not be read'}`);
    return 2;
  }
  io.print(`Account ${target.userId}, phone ${target.maskedPhone}`);
  io.print(`Authenticator: ${target.enrolledAt ? `set up ${target.enrolledAt.toISOString()}` : 'not set up'}${target.pending ? ' (a set-up is pending)' : ''}; recovery codes left: ${target.recoveryCodesLeft}; active sessions: ${target.activeSessions}`);
  const operator = await io.ask('Your name (for the audit record): ');
  const reason = await io.ask('Reason (for the audit record): ');
  const expected = resetConfirmationFor(target);
  const typed = await io.ask(`Type ${expected} to continue: `);
  if (typed.trim() !== expected) {
    io.print('NOT CONFIRMED: nothing changed.');
    return 3;
  }
  try {
    const done = await resetAdminAuthenticator(app, target, { operator, reason });
    io.print(`DONE: authenticator and recovery codes cleared; ${done.sessionsRevoked} session(s) revoked; audit ${ADMIN_MFA_RESET_AUDIT_ACTION} written.`);
    io.print(`Notice to the admin: email ${done.emailed ? 'sent' : 'NOT sent'}, text ${done.texted ? 'sent' : 'NOT sent'}.`);
    io.print('Next: the admin signs in with a texted code and sets up the authenticator app again at once (System > Security).');
    return 0;
  } catch (error) {
    io.print(`FAILED: ${error instanceof Error ? error.message : 'unexpected error'}. Nothing was changed.`);
    return 1;
  }
}
