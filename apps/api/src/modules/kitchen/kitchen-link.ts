import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { log } from '../../utils/logger';

/**
 * [DT-OUTAGE · owner 14 Nov 2026] THE KITCHEN-LINK BREAKER, per branch.
 *
 * A send that CERTAINLY did not reach the kitchen system (no connection, a login refused) falls back to the tablet at
 * once, with no page per order. When a branch's link fails N times IN A ROW — no success with it in between, however
 * far apart [round 3 · review B S3-1: a quiet branch trips it too] (3 by default) — the link is marked OFFLINE (vendor_integrations.linkOfflineAt, in
 * the database so every API and worker instance agrees): new orders are not claimed for the kitchen at all and go
 * straight to the tablet (pickups and deliveries), queued ones fall back without a call, and operations get ONE alert
 * for the outage. While offline the kitchen tick probes the link (a fresh login and an order-API read; the spec has
 * no health call) every cool-down, doubled after each failed trial.
 *
 * [round 3 · review B S3-1] A quiet branch is not left silent: the FIRST certain failure of a streak, at a link with no
 * success for DRAGONTAIL_LINK_QUIET_SECONDS (10 min by default; sends and polls count as successes), sends one
 * "Kitchen link failing" note.
 *
 * [round 3 · review B S2-1] The probe is a login AND a read through the order API (GetOrderUpdatesForPos), so a
 * backend that is down behind a working login keeps the link offline and costs no order. If the probe passes but the
 * first real send still fails (inserts down while reads work), the trial ends at once and the NEXT probe waits twice as
 * long (60 s, 2, 4, 8 min … at most 15 min): a bounded number of orders per outage meets a failing insert.
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
    /** While offline, a probe at most this often (doubled after each failed trial of the same outage). */
    probeMs: int(env['DRAGONTAIL_BREAKER_PROBE_SECONDS'], 60, 10, 3_600) * 1000,
    /** The longest wait between probes after failed trials. */
    probeMaxMs: 15 * 60_000,
    /** No success with the link for this long: the first certain failure tells operations at once. */
    quietMs: int(env['DRAGONTAIL_LINK_QUIET_SECONDS'], 600, 60, 86_400) * 1000,
  };
}

/** [round 3] How long after its last probe an offline link is probed again: the cool-down, doubled per failed trial. */
export function probeWaitMs(settings: { probeMs: number; probeMaxMs: number }, failedTrials: number): number {
  return Math.min(settings.probeMaxMs, settings.probeMs * 2 ** Math.min(Math.max(0, failedTrials), 10));
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
 * A certain failure of the branch's link: count it (in a row: only a success restarts the count) and, at the
 * threshold, mark the link OFFLINE once (compare-and-set) with ONE alert per outage. Returns
 * 'opened' only for the call that opened it. Never throws.
 */
export async function recordLinkFailure(deps: LinkDeps, integrationId: string, problem: string, env: Env = process.env): Promise<'counted' | 'opened' | 'offline'> {
  try {
    const { failures, quietMs } = kitchenBreakerSettings(env);
    const now = nowOf(deps);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await deps.prisma.vendorIntegration.findUnique({
        where: { id: integrationId },
        select: {
          tenantId: true, vendorId: true, linkFailures: true, linkFirstFailureAt: true, linkOfflineAt: true, linkOutageSince: true,
          linkTrialFailures: true, lastHealthyAt: true, linkProbeAt: true,
        },
      });
      if (!row) return 'counted';
      if (row.linkOfflineAt) return 'offline';
      // [round 3 · review B S3-1] In a row: only a success restarts the count, never the clock.
      const fresh = !row.linkFirstFailureAt || row.linkFailures === 0;
      const count = fresh ? 1 : row.linkFailures + 1;
      // On trial (a probe re-opened it; no send has gone through since): one failure takes it offline again. A
      // "failing" outage started by the quiet note below has no probe time, so it still counts to the threshold.
      const onTrial = row.linkOutageSince != null && row.linkProbeAt != null;
      const opening = onTrial || count >= failures;
      // [round 3 · review B S3-1] A quiet link that has not worked for a while: say so at the streak's first failure.
      // [COORD ruling 14 Nov · PDF "one alert per outage"] That note STARTS the outage (linkOutageSince), so the
      // "offline" alert that may follow is the same alert (same key: deduped) and the "back online" note closes it.
      const quiet = !opening && count === 1 && (!row.lastHealthyAt || now.getTime() - row.lastHealthyAt.getTime() >= quietMs);
      // Compare-and-set on what was read: concurrent failures each count once.
      const moved = await deps.prisma.vendorIntegration.updateMany({
        where: { id: integrationId, linkFailures: row.linkFailures, linkFirstFailureAt: row.linkFirstFailureAt, linkOfflineAt: null },
        data: {
          linkFailures: count,
          linkFirstFailureAt: fresh ? now : row.linkFirstFailureAt,
          ...(quiet ? { linkOutageSince: row.linkOutageSince ?? now } : {}),
          ...(opening ? {
            linkOfflineAt: now, linkProbeAt: now, linkOutageSince: row.linkOutageSince ?? now,
            // A failed trial: the next probe waits twice as long.
            ...(onTrial ? { linkTrialFailures: row.linkTrialFailures + 1 } : {}),
          } : {}),
        },
      });
      if (moved.count === 0) continue;
      const name = await branchName(deps.prisma, row.vendorId);
      if (!opening) {
        if (quiet) {
          await tellOperations(deps, row.tenantId, integrationId, `link-offline:${integrationId}:${(row.linkOutageSince ?? now).getTime()}`,
            `Kitchen link failing: ${name}`,
            `${name}: an order could not be sent to the kitchen system (Dragontail) (${problem.slice(0, 160)}), and Swift has had no answer from it for ${Math.round(quietMs / 60_000)} minutes or more. The order rang the Swift tablet. Swift marks the link offline after ${failures} failures in a row; check Dragontail at the store.`);
        }
        return 'counted';
      }
      log().warn({ integrationId, problem, count, onTrial }, '[KITCHEN-LINK] link OFFLINE: new orders go to the tablet');
      // [round 3 · review B S4-1] Keyed on the OUTAGE: a trial re-opening dedupes into the one alert (no second alert),
      // and a first alert that failed to send is sent now.
      const outage = row.linkOutageSince ?? now;
      await tellOperations(deps, row.tenantId, integrationId, `link-offline:${integrationId}:${outage.getTime()}`,
        `${LINK_OFFLINE_WORDS}: ${name}`,
        `${name}: the kitchen system (Dragontail) failed ${count} times in a row (last: ${problem.slice(0, 160)}). New orders now ring the Swift tablet instead; nothing is sent to Dragontail. Swift keeps checking the link (less often while it keeps failing) and says when it is back. Call the store so it watches the tablet.`);
      return 'opened';
    }
    return 'counted';
  } catch (err) {
    log().error({ err, integrationId }, '[KITCHEN-LINK] could not count a failure');
    return 'counted';
  }
}

/**
 * A probe (a login and an order-API read) worked while the link is offline: the link goes back ON TRIAL (new orders go to the kitchen again),
 * with no note; the outage stays open until a real send goes through. Never throws.
 */
export async function recordLinkProbeSuccess(deps: LinkDeps, integrationId: string, how: 'order-api' | 'login-only' = 'order-api'): Promise<'trial' | 'ok'> {
  try {
    const row = await deps.prisma.vendorIntegration.findUnique({ where: { id: integrationId }, select: { linkOfflineAt: true, linkOutageSince: true } });
    if (!row?.linkOfflineAt) return 'ok';
    const moved = await deps.prisma.vendorIntegration.updateMany({
      where: { id: integrationId, linkOfflineAt: row.linkOfflineAt },
      data: { linkOfflineAt: null, linkFailures: 0, linkFirstFailureAt: null, linkOutageSince: row.linkOutageSince ?? row.linkOfflineAt },
    });
    if (moved.count === 1) log().info({ integrationId, how }, '[KITCHEN-LINK] probe passed: link ON TRIAL until a send goes through');
    return moved.count === 1 ? 'trial' : 'ok';
  } catch (err) {
    log().error({ err, integrationId }, '[KITCHEN-LINK] could not record a probe');
    return 'ok';
  }
}

/** A REAL send went through: the count restarts, and an outage (offline, or on trial) ends once with a note. Never throws.
 *  `quietTrial`: no send, but the trial has gone QUIET_TRIAL_MS without a failure (closeQuietTrials). */
export async function recordLinkSuccess(deps: LinkDeps, integrationId: string, how: 'send' | 'quietTrial' = 'send'): Promise<'ok' | 'closed'> {
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
        data: { linkOfflineAt: null, linkOutageSince: null, linkFailures: 0, linkFirstFailureAt: null, linkProbeAt: null, linkTrialFailures: 0 },
      });
      if (closed.count === 1) {
        log().info({ integrationId }, '[KITCHEN-LINK] link back ONLINE');
        const name = await branchName(deps.prisma, row.vendorId);
        await tellOperations(deps, row.tenantId, integrationId, `link-back:${integrationId}:${outage.getTime()}`,
          `Kitchen link back online: ${name}`,
          how === 'send'
            ? `${name}: Dragontail answers again. New orders go to the kitchen system again; orders already on the Swift tablet stay there.`
            : `${name}: Dragontail has answered Swift's checks for ${Math.round(QUIET_TRIAL_MS / 60_000)} minutes with no failure (no order has been sent to it yet). New orders go to the kitchen system again; orders already on the Swift tablet stay there.`);
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

/** [follow-up · review B S4-2] A trial this long with no failure (and no send to prove it) ends the outage. */
export const QUIET_TRIAL_MS = 30 * 60_000;

/**
 * [follow-up · review B S4-2] Links on trial (a probe passed, no send since) with no failure for QUIET_TRIAL_MS: the
 * outage ends with its "back online" note, so "on trial" never stands for good. A later failure starts a new outage
 * (a new alert). Never throws.
 */
export async function closeQuietTrials(deps: LinkDeps, now: Date = nowOf(deps)): Promise<number> {
  try {
    const quiet = await deps.prisma.vendorIntegration.findMany({
      where: { enabled: true, linkOfflineAt: null, linkOutageSince: { not: null }, linkFailures: 0, linkProbeAt: { lte: new Date(now.getTime() - QUIET_TRIAL_MS) } },
      select: { id: true },
      take: 50,
    });
    let closed = 0;
    for (const row of quiet) if ((await recordLinkSuccess(deps, row.id, 'quietTrial')) === 'closed') closed += 1;
    return closed;
  } catch (err) {
    log().error({ err }, '[KITCHEN-LINK] could not close quiet trials');
    return 0;
  }
}

/** [COORD ruling 14 Nov · PDF v1.1 §3.2] The low-priority notice kind for one order that rang the tablet. */
export const ORDER_ON_TABLET_KIND = 'kitchen_order_rang';

/** Notifications need a socket server for their live update; a caller without one (a test, a bare claim) uses this. */
const NO_SOCKET = { to: () => ({ emit: () => false }) } as unknown as Server;

/**
 * [COORD ruling 14 Nov · PDF v1.1 §3.2 row 1 "rings on the Swift tablet straight away, and Swift operations are
 * alerted"] One order that CERTAINLY did not reach Dragontail (no connection, or the branch's link marked offline) and
 * rang the tablet: a low-priority notice for operations (quiet class: the console's list and a silent push, never a
 * page or an SMS), once per order. The once-per-outage alert is separate (recordLinkFailure). Never throws.
 */
export async function noteOrderOnTablet(deps: { prisma: PrismaClient; io?: Server | undefined }, orderId: string, why: string): Promise<void> {
  try {
    const order = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { tenantId: true, orderNumber: true, vendorId: true } });
    if (!order) return;
    const name = order.vendorId ? await branchName(deps.prisma, order.vendorId) : 'A branch';
    const { notifyAdmins, NotificationService } = await import('../notification/notification.service');
    await notifyAdmins(deps.prisma, new NotificationService(deps.prisma, deps.io ?? NO_SOCKET), {
      tenantId: order.tenantId,
      title: `Order on the tablet: ${name}`,
      body: `Order ${order.orderNumber} rang the Swift tablet at ${name}: Dragontail did not get it (${why.slice(0, 160)}). The store makes it from the tablet.`,
      data: { kind: 'kitchen_order_rang', orderId },
      dedupeKey: `kitchen:rang:${orderId}`,
    });
  } catch (err) {
    log().error({ err, orderId }, '[KITCHEN-LINK] order-on-tablet notice failed');
  }
}

