import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { log } from '../../utils/logger';

/**
 * [DT-OUTAGE · owner 14 Nov 2026] THE KITCHEN-LINK BREAKER, per branch.
 *
 * A send that CERTAINLY did not reach the kitchen system (no connection, a 5xx/4xx error answer, a login refused)
 * falls back to the tablet at once, with no page per order. When a branch's link fails like that N times in a row
 * within a window (3 within 2 minutes by default), the link is marked OFFLINE (vendor_integrations.linkOfflineAt, in
 * the database so every API and worker instance agrees): new orders are not claimed for the kitchen at all and go
 * straight to the tablet (pickups and deliveries), queued ones fall back without a call, and operations get ONE alert
 * for the outage. While offline the kitchen tick probes the link (a fresh login: the spec has no health call) every
 * cool-down.
 *
 * [round 2 · review A S3-2] A login proves the login, not the order API. So a probe that logs in re-opens the link
 * only ON TRIAL: new orders go to the kitchen again, but the outage (linkOutageSince) stays open, and the FIRST certain
 * failure on trial takes the link offline again at once, with no new alert. Only a REAL send that goes through ends the
 * outage, with its one "back online" note. One alert pair per outage, however often logins work while inserts fail.
 *
 * A send that MAY have arrived (a timeout, a reset after the request left) never counts here: it keeps the careful
 * path (wait for evidence, cancel at the kitchen, then ring). Inert while DRAGONTAIL_INTEGRATION is off: nothing here
 * is reached.
 */

type Env = Record<string, string | undefined>;
type LinkDeps = { prisma: PrismaClient; io: Server; now?: () => Date };

const int = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const v = Number((raw ?? '').trim());
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
};

export function kitchenBreakerSettings(env: Env = process.env) {
  return {
    /** Certain failures in a row that mark the link offline. */
    failures: int(env['DRAGONTAIL_BREAKER_FAILURES'], 3, 1, 50),
    /** ...counted within this window from the first of them. */
    windowMs: int(env['DRAGONTAIL_BREAKER_WINDOW_SECONDS'], 120, 10, 3_600) * 1000,
    /** While offline, a probe at most this often. */
    probeMs: int(env['DRAGONTAIL_BREAKER_PROBE_SECONDS'], 60, 10, 3_600) * 1000,
  };
}

const nowOf = (deps: LinkDeps) => (deps.now ? deps.now() : new Date());

export const LINK_OFFLINE_WORDS = 'Kitchen link offline, orders on tablet';

/** One note to operations (the tenant's admins), deduped by key. Never throws. */
async function tellOperations(deps: LinkDeps, tenantId: string, integrationId: string, key: string, title: string, body: string) {
  try {
    const { notifyAdmins, NotificationService } = await import('../notification/notification.service');
    await notifyAdmins(deps.prisma, new NotificationService(deps.prisma, deps.io), {
      tenantId, title, body, data: { kind: 'kitchen_link', vendorIntegrationId: integrationId }, dedupeKey: `kitchen:${key}`,
    });
  } catch (err) {
    log().error({ err, integrationId }, '[KITCHEN-LINK] operations note failed');
  }
}

async function branchName(prisma: PrismaClient, vendorId: string) {
  return (await prisma.vendor.findUnique({ where: { id: vendorId }, select: { name: true } }).catch(() => null))?.name ?? 'A branch';
}

/**
 * A certain failure of the branch's link: count it (restarting the count when the first counted failure is older
 * than the window) and, at the threshold, mark the link OFFLINE once (compare-and-set) with ONE alert. Returns
 * 'opened' only for the call that opened it. Never throws.
 */
export async function recordLinkFailure(deps: LinkDeps, integrationId: string, problem: string, env: Env = process.env): Promise<'counted' | 'opened' | 'offline'> {
  try {
    const { failures, windowMs } = kitchenBreakerSettings(env);
    const now = nowOf(deps);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await deps.prisma.vendorIntegration.findUnique({
        where: { id: integrationId },
        select: { tenantId: true, vendorId: true, linkFailures: true, linkFirstFailureAt: true, linkOfflineAt: true, linkOutageSince: true },
      });
      if (!row) return 'counted';
      if (row.linkOfflineAt) return 'offline';
      const fresh = !row.linkFirstFailureAt || now.getTime() - row.linkFirstFailureAt.getTime() > windowMs;
      const count = fresh ? 1 : row.linkFailures + 1;
      // On trial (a probe's login re-opened it; no send has gone through since): one failure takes it offline again.
      const onTrial = row.linkOutageSince != null;
      const opening = onTrial || count >= failures;
      // Compare-and-set on what was read: concurrent failures each count once.
      const moved = await deps.prisma.vendorIntegration.updateMany({
        where: { id: integrationId, linkFailures: row.linkFailures, linkFirstFailureAt: row.linkFirstFailureAt, linkOfflineAt: null },
        data: {
          linkFailures: count,
          linkFirstFailureAt: fresh ? now : row.linkFirstFailureAt,
          ...(opening ? { linkOfflineAt: now, linkProbeAt: now, linkOutageSince: row.linkOutageSince ?? now } : {}),
        },
      });
      if (moved.count === 0) continue;
      if (!opening) return 'counted';
      log().warn({ integrationId, problem, count, onTrial }, '[KITCHEN-LINK] link OFFLINE: new orders go to the tablet');
      // The same outage, back offline after a probe's login: no second alert (the first one still stands).
      if (onTrial) return 'opened';
      const name = await branchName(deps.prisma, row.vendorId);
      await tellOperations(deps, row.tenantId, integrationId, `link-offline:${integrationId}:${now.getTime()}`,
        `${LINK_OFFLINE_WORDS}: ${name}`,
        `${name}: the kitchen system (Dragontail) failed ${count} times in a row (last: ${problem.slice(0, 160)}). New orders now ring the Swift tablet instead; nothing is sent to Dragontail. Swift checks the link every minute and says when it is back. Call the store so it watches the tablet.`);
      return 'opened';
    }
    return 'counted';
  } catch (err) {
    log().error({ err, integrationId }, '[KITCHEN-LINK] could not count a failure');
    return 'counted';
  }
}

/**
 * A probe's login worked while the link is offline: the link goes back ON TRIAL (new orders go to the kitchen again),
 * with no note; the outage stays open until a real send goes through. Never throws.
 */
export async function recordLinkProbeSuccess(deps: LinkDeps, integrationId: string): Promise<'trial' | 'ok'> {
  try {
    const row = await deps.prisma.vendorIntegration.findUnique({ where: { id: integrationId }, select: { linkOfflineAt: true, linkOutageSince: true } });
    if (!row?.linkOfflineAt) return 'ok';
    const moved = await deps.prisma.vendorIntegration.updateMany({
      where: { id: integrationId, linkOfflineAt: row.linkOfflineAt },
      data: { linkOfflineAt: null, linkFailures: 0, linkFirstFailureAt: null, linkOutageSince: row.linkOutageSince ?? row.linkOfflineAt },
    });
    if (moved.count === 1) log().info({ integrationId }, '[KITCHEN-LINK] probe login worked: link ON TRIAL until a send goes through');
    return moved.count === 1 ? 'trial' : 'ok';
  } catch (err) {
    log().error({ err, integrationId }, '[KITCHEN-LINK] could not record a probe');
    return 'ok';
  }
}

/** A REAL send went through: the count restarts, and an outage (offline, or on trial) ends once with a note. Never throws. */
export async function recordLinkSuccess(deps: LinkDeps, integrationId: string): Promise<'ok' | 'closed'> {
  try {
    const row = await deps.prisma.vendorIntegration.findUnique({
      where: { id: integrationId },
      select: { tenantId: true, vendorId: true, linkFailures: true, linkOfflineAt: true, linkOutageSince: true },
    });
    if (!row) return 'ok';
    const outage = row.linkOutageSince ?? row.linkOfflineAt;
    if (outage) {
      const closed = await deps.prisma.vendorIntegration.updateMany({
        where: { id: integrationId, linkOfflineAt: row.linkOfflineAt, linkOutageSince: row.linkOutageSince },
        data: { linkOfflineAt: null, linkOutageSince: null, linkFailures: 0, linkFirstFailureAt: null, linkProbeAt: null },
      });
      if (closed.count === 1) {
        log().info({ integrationId }, '[KITCHEN-LINK] link back ONLINE');
        const name = await branchName(deps.prisma, row.vendorId);
        await tellOperations(deps, row.tenantId, integrationId, `link-back:${integrationId}:${outage.getTime()}`,
          `Kitchen link back online: ${name}`,
          `${name}: Dragontail answers again. New orders go to the kitchen system again; orders already on the Swift tablet stay there.`);
        return 'closed';
      }
      return 'ok';
    }
    if (row.linkFailures > 0) {
      await deps.prisma.vendorIntegration.updateMany({ where: { id: integrationId, linkOfflineAt: null }, data: { linkFailures: 0, linkFirstFailureAt: null } });
    }
    return 'ok';
  } catch (err) {
    log().error({ err, integrationId }, '[KITCHEN-LINK] could not record a success');
    return 'ok';
  }
}
