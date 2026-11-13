import type { Prisma, PrismaClient } from '@prisma/client';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { consoleRoleOf } from '../auth/console-role';
import { capabilitiesOf, holdsCapability } from '../admin/admin-authority';

// ---------------------------------------------------------------------------
// [REVIEW-2499-A S3-1 · coordinator ruling 13 Nov 2026] THE ONLY ELIGIBLE RESPONDER.
//
// The party rule says nobody decides a matter that names them, and a matter
// naming a staff account goes to a SUPER_ADMIN who is not part of it. Production
// has ONE admin identity (the owner): an SOS or a stuck ride that names the
// owner could then never be resolved by anyone, which holds the ride open, its
// END_STUCK_RIDE, and any erasure behind it, for ever.
//
// So: when the actor is a SUPER_ADMIN and NO OTHER active admin in their market
// holds the capability the act needs, the actor may act, with a typed reason,
// and the act is audited and flagged for a second person's review once a second
// admin exists. While another eligible admin exists the party rule holds as
// before.
// ---------------------------------------------------------------------------

export const SELF_RESOLVED_FLAG = 'self-resolved — second-person review when a second admin exists';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Is `actorId` a SUPER_ADMIN with no other ACTIVE admin who could do this act on THIS resource? Decided from the
 * resource, never the actor: every active SUPER_ADMIN on the platform (a platform responder acts in any market)
 * and every active ADMIN in the resource's own market (`resourceTenantId`; null = a platform resource, which
 * only SUPER_ADMINs work), each counted only if their live grant holds `capability`.
 */
export async function isSoleEligibleResponder(db: Db, actorId: string, capability: string, resourceTenantId: string | null): Promise<boolean> {
  return runWithoutTenant(async () => {
    const actor = await db.user.findUnique({ where: { id: actorId }, select: { roles: true, status: true } });
    if (!actor || actor.status !== 'ACTIVE' || consoleRoleOf(actor.roles) !== 'SUPER_ADMIN') return false;
    const others = await db.user.findMany({
      where: {
        id: { not: actorId }, status: 'ACTIVE',
        OR: [
          { roles: { has: 'SUPER_ADMIN' } }, { activeRole: 'SUPER_ADMIN' },
          ...(resourceTenantId ? [{ tenantId: resourceTenantId, OR: [{ roles: { has: 'ADMIN' as const } }, { activeRole: 'ADMIN' as const }] }] : []),
        ],
      },
      select: { roles: true, activeRole: true, admin: { select: { permissions: true } } },
    });
    return !others.some((u) => holdsCapability(
      capabilitiesOf({ role: consoleRoleOf(u.roles) ?? u.activeRole, permissions: u.admin?.permissions ?? null }), capability,
    ));
  }, 'sole-eligible-responder');
}
