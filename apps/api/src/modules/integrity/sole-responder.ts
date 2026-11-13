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

/** Is `actorId` a SUPER_ADMIN with no other ACTIVE admin in their market holding `capability`? */
export async function isSoleEligibleResponder(db: Db, actorId: string, capability: string): Promise<boolean> {
  return runWithoutTenant(async () => {
    const actor = await db.user.findUnique({ where: { id: actorId }, select: { tenantId: true, roles: true, status: true } });
    if (!actor || actor.status !== 'ACTIVE' || consoleRoleOf(actor.roles) !== 'SUPER_ADMIN') return false;
    const others = await db.user.findMany({
      where: {
        id: { not: actorId }, tenantId: actor.tenantId, status: 'ACTIVE',
        OR: [{ roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } }, { activeRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }],
      },
      select: { roles: true, activeRole: true, admin: { select: { permissions: true } } },
    });
    return !others.some((u) => holdsCapability(
      capabilitiesOf({ role: consoleRoleOf(u.roles) ?? u.activeRole, permissions: u.admin?.permissions ?? null }), capability,
    ));
  }, 'sole-eligible-responder');
}
