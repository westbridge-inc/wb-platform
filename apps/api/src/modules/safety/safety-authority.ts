import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { ForbiddenError } from '../../utils/errors';
import { consoleRoleOf } from '../auth/console-role';
import { capabilitiesOf, capabilityMode, holdsCapability, routeTemplateOf } from '../admin/admin-authority';
import { log } from '../../utils/logger';
import { staffRefusalOf } from '../auth/admin-mfa';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 F5 · FABLE-03 S3-3] THE ADMIN GRANT REACHES THE SAFETY CONSOLE.
//
// admin-authority.ts lets a SUPER_ADMIN narrow an admin to a preset (SUPPORT,
// DOC_REVIEWER ...) and the /api/v1/admin plugin honours it on every route. The
// safety console lives outside that plugin and asked only "does the account
// hold an admin role", so a narrowed operator could still open any SOS with its
// live location, suspend a mover through ops case intake, lift a suspension,
// and read or export evidence. Every ops route here now names a capability and
// the same grant decides it, read live from the admin row on every request.
//
// Every admin today holds the role default (`*`), so nothing they can do
// changes. ADMIN_CAPABILITY_MODE=shadow logs and allows, exactly as on /admin.
// The census test keeps this table one-to-one with the ops routes.
// ---------------------------------------------------------------------------

/** `"<METHOD> <route template without the mount prefix>"` → the capability it needs. */
export const SAFETY_OPS_CAPABILITY: Readonly<Record<string, string>> = {
  // SOS: reading where a person is, and answering for ops
  'GET /sos': 'safety.sos.read',
  'GET /sos/:id': 'safety.sos.read',
  'POST /sos/:id/ack': 'safety.sos.respond',
  'POST /sos/:id/resolve': 'safety.sos.respond',
  // the durable ops page
  'GET /ops-alerts': 'safety.alert.read',
  'GET /ops-alerts/failed-drills': 'safety.alert.read',
  'POST /ops-alerts/:id/ack': 'safety.alert.respond',
  'POST /ops-alerts/drill': 'safety.alert.drill',
  // incident cases: intake (an S0/S1 suspends), the queue, working and deciding
  'POST /incidents/ops': 'safety.case.intake',
  'GET /incidents': 'safety.case.read',
  'POST /incidents/:id/ack': 'safety.case.work',
  'POST /incidents/:id/investigate': 'safety.case.work',
  'POST /incidents/:id/merge': 'safety.case.decide',
  'POST /incidents/:id/close': 'safety.case.decide',
  'POST /incidents/:id/escalate-police': 'safety.case.decide',
  'POST /incidents/:id/lift-interim': 'safety.case.decide',
  'POST /incidents/:id/shadow-restrict': 'safety.case.decide',
  'POST /incidents/:id/decide': 'safety.case.decide',
  // the evidence vault
  'GET /evidence': 'safety.evidence.read',
  'POST /evidence/:id/view': 'safety.evidence.read',
  'POST /evidence/:id/seal': 'safety.evidence.manage',
  'POST /evidence/:id/legal-hold': 'safety.evidence.manage',
  'POST /evidence/:id/export': 'safety.evidence.export',
  // live trip monitoring
  'GET /guardian': 'safety.guardian.read',
};

/** The search index re-sync (POST /api/v1/search/sync): same grant, its own capability. */
export const SEARCH_SYNC_CAPABILITY = 'search.sync';

type OpsRequest = Pick<FastifyRequest, 'method' | 'url'> & {
  routeOptions?: { url?: string };
  heldRoles?: readonly string[] | null;
  user: { userId: string };
};

export interface OpsDecision {
  /** The admin role the account holds ('' when none). */
  role: string;
  allowed: boolean;
  capability: string | null;
}

/**
 * Options for one decision. `allowUnpostured`: the two ops-page doors a texted-code session may use (the page list and
 * its acknowledgement, REVIEW-2501-A S2-1 coordinator ruling) decide the role and the grant without the staff posture.
 */
type DecideOptions = { prefix?: string; capability?: string; allowUnpostured?: boolean };

/**
 * Decide one request: the role the account HOLDS, then its live grant over the route's capability.
 * [REVIEW-2501-A S2-1 · merged with #2499] An account holding an admin role whose session lacks the staff posture
 * (authenticator code, 12-hour session, console-only) is refused with that posture's own refusal, exactly where the
 * ops role is decided (as opsRoleOf), unless the door is one of the two `allowUnpostured` ones.
 */
export async function decideOpsCapability(
  prisma: Pick<PrismaClient, 'admin'>,
  request: OpsRequest,
  options: DecideOptions = {},
): Promise<OpsDecision> {
  const role = consoleRoleOf(request.heldRoles) ?? '';
  if (!role) return { role, allowed: false, capability: null };
  const refusal = options.allowUnpostured ? null : staffRefusalOf(request);
  if (refusal) throw refusal;
  const key = `${request.method.toUpperCase()} ${routeTemplateOf(request, options.prefix ?? '')}`;
  const capability = options.capability ?? SAFETY_OPS_CAPABILITY[key] ?? null;
  // An unclassified ops route is refused, never allowed (the census test keeps this unreachable).
  if (!capability) return { role, allowed: false, capability: null };
  const grant = await prisma.admin.findUnique({ where: { userId: request.user.userId }, select: { permissions: true } });
  const allowed = holdsCapability(capabilitiesOf({ role, permissions: grant?.permissions ?? null }), capability);
  if (!allowed && capabilityMode() === 'shadow') {
    log().warn({ userId: request.user.userId, route: key, capability }, '[AUDIT-20261113 F5] safety capability decision would DENY (shadow mode)');
    return { role, allowed: true, capability };
  }
  return { role, allowed, capability };
}

/**
 * The gate for an ops-only route: refuses an account holding no admin role with the route's own words, and an
 * admin whose grant leaves this route out with the capability it needs. Returns the admin role held.
 */
export async function requireOpsCapability(
  prisma: Pick<PrismaClient, 'admin'>,
  request: OpsRequest,
  notOps: string,
  options: DecideOptions = {},
): Promise<string> {
  const decision = await decideOpsCapability(prisma, request, options);
  if (!decision.role) throw new ForbiddenError(notOps);
  if (!decision.allowed) {
    throw new ForbiddenError(decision.capability
      ? `This safety action requires the ${decision.capability} capability`
      : 'This safety action is not classified and cannot be performed');
  }
  return decision.role;
}
