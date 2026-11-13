import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { consoleRoleOf } from '../auth/console-role';
import { log } from '../../utils/logger';
import { capabilitiesOf, holdsCapability } from '../admin/admin-authority';
import { identityAuthority } from '../integrity/identity-review';
import { runWithoutTenant } from '../../plugins/tenant-context';
/**
 * [F-027-16 / F-027-18] The ops war room — who is in it, and whose alerts
 * reach them.
 *
 * Until this module existed, `ops:war-room` had SEVEN emit producers across
 * SOS, incidents, liveness and mover revocation, and **no join anywhere in the
 * codebase**. Every live ops event went into a black hole, and the SOS
 * delivery receipt recorded `socket: true` because emitting into an empty room
 * does not throw. The real-time ops surface did not exist and the evidence
 * said it did.
 *
 * Two rooms, because there are two kinds of operator:
 *
 *   ops:war-room            — the PLATFORM room. SUPER_ADMIN only. Sees every
 *                             tenant's events, because that is the job.
 *   ops:war-room:<tenantId> — one per tenant. A tenant's ADMIN joins only
 *                             their own.
 *
 * A tenant admin must never be handed another tenant's emergency: it carries
 * the actor's role, the order id and the coordinates. That is exactly the leak
 * closed on the PUSH channel by F-026-15, and a shared socket room would have
 * reopened it on the socket channel the moment anyone actually subscribed.
 */

/** The platform-wide room. SUPER_ADMIN only — never a tenant's admin. */
export const OPS_WAR_ROOM = 'ops:war-room';

/** One tenant's room. */
export const tenantWarRoom = (tenantId: string) => `${OPS_WAR_ROOM}:${tenantId}`;

/**
 * Where a tenant-owned ops event must be published: that tenant's room, plus
 * the platform room so SUPER_ADMINs see it too.
 */
export function warRoomsFor(tenantId: string | null | undefined): string[] {
  return tenantId ? [tenantWarRoom(tenantId), OPS_WAR_ROOM] : [OPS_WAR_ROOM];
}

/**
 * Which rooms a connecting socket may join, by role. Everyone else gets none —
 * the war room carries live emergencies and is not a general ops feed.
 */
export function warRoomsForSocket(role: string | undefined, tenantId: string | null | undefined): string[] {
  if (role === 'SUPER_ADMIN') return tenantId ? [OPS_WAR_ROOM, tenantWarRoom(tenantId)] : [OPS_WAR_ROOM];
  if (role === 'ADMIN') return tenantId ? [tenantWarRoom(tenantId)] : [];
  return [];
}

// ---------------------------------------------------------------------------
// [REVIEW-2499-A S3-3 · AUDIT-20261113 F5/F7] The same two rules as the HTTP safety console.
//   - JOIN: an admin joins the war room only while their live grant holds `safety.sos.read` (a narrowed operator,
//     e.g. the SUPPORT preset, hears no live location).
//   - PER ALERT: an SOS event is never sent to the people it names (who raised it, the person it was raised
//     against) or an account linked to them: their `user:<id>` rooms are excepted from the emission.
// ---------------------------------------------------------------------------

export const WAR_ROOM_CAPABILITY = 'safety.sos.read';

/** Does this admin's live grant let them hear the war room? */
export async function holdsWarRoomGrant(prisma: Pick<PrismaClient, 'admin'>, userId: string, role: string | undefined): Promise<boolean> {
  if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') return false;
  const grant = await prisma.admin.findUnique({ where: { userId }, select: { permissions: true } });
  return holdsCapability(capabilitiesOf({ role, permissions: grant?.permissions ?? null }), WAR_ROOM_CAPABILITY);
}

/**
 * [REVIEW-2499-A S3-3 · automated review] Who must NOT hear an SOS event in the war room, decided per socket AT
 * EMISSION. A socket is heard only when its account is ACTIVE, holds an admin role, its live grant holds
 * safety.sos.read NOW (a grant narrowed, a role removed or an account suspended since it joined is not heard), and it
 * is neither a person the SOS names nor linked to one, read from BOTH sides (its own cluster and each named person's).
 * Every other socket in the rooms is returned, to be excepted from the emission (which stays addressed to the war
 * rooms). Fail closed: a socket whose identity cannot be read is excepted; when the sockets or a named person's
 * identity cannot be read at all, null — the caller sends nothing (the ops page, pushes and on-call texts still go,
 * and the board's HTTP reload applies the same rule).
 */
export async function sosWarRoomExclusions(
  io: Pick<Server, 'in'>,
  prisma: PrismaClient,
  rooms: string[],
  people: ReadonlyArray<string | null | undefined>,
): Promise<{ excluded: string[]; listeners: number } | null> {
  const named = new Set(people.filter((p): p is string => !!p));
  try {
    const sockets = await io.in(rooms).fetchSockets();
    const userOf = (socket: { data?: unknown }) => (socket.data as { userId?: unknown } | undefined)?.userId;
    const userIds = [...new Set(sockets.map(userOf).filter((id): id is string => typeof id === 'string'))];
    const users = userIds.length === 0 ? [] : await runWithoutTenant(() => prisma.user.findMany({
      where: { id: { in: userIds } }, select: { id: true, roles: true, status: true, admin: { select: { permissions: true } } },
    }), 'war-room-audience');
    const clear = new Set<string>();
    for (const user of users) {
      if (user.status !== 'ACTIVE' || named.has(user.id)) continue;
      const role = consoleRoleOf(user.roles);
      if (!role || !holdsCapability(capabilitiesOf({ role, permissions: user.admin?.permissions ?? null }), WAR_ROOM_CAPABILITY)) continue;
      try {
        const identity = await runWithoutTenant(() => identityAuthority(prisma, user.id), 'war-room-audience');
        if (identity.memberIds.some((member) => named.has(member))) continue;
      } catch { continue; }
      clear.add(user.id);
    }
    for (const person of named) {
      const identity = await runWithoutTenant(() => identityAuthority(prisma, person), 'war-room-audience');
      for (const member of identity.memberIds) clear.delete(member);
    }
    const excluded = sockets.filter((socket) => !clear.has(String(userOf(socket) ?? ''))).map((socket) => socket.id);
    return { excluded, listeners: sockets.length - excluded.length };
  } catch (err) {
    log().error({ err }, '[REVIEW-2499-A S3-3] war-room audience could not be decided: SOS event not sent over the socket (pages and pushes still go)');
    return null;
  }
}

