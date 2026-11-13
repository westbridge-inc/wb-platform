import { statfs } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { NotificationService } from '../notification/notification.service';
import { clearProviderFailures, providerFailuresRecent, recordProviderFailure } from '../../lib/provider-failure';
import { pageOps, resolveOpsPage } from './ops-page';

// ---------------------------------------------------------------------------
// [FABLE-05 3.7 · 3.11] The worker's five-minute watch (the error-rate-watch
// job) also reads what paged nobody before:
//
//  - THE SERVER'S DISK AND MEMORY. A full disk stops Postgres and Redis, and
//    then no page can be stored at all, so this pages early: 85% of the disk
//    used (HOST_DISK_ALERT_PERCENT), or 90% of the memory (less than a tenth
//    available, HOST_MEMORY_ALERT_PERCENT). The container reads the host's own
//    numbers: its root filesystem is Docker's, on the host disk, and
//    /proc/meminfo is the host's.
//  - SIGN-IN TEXTS. Five provider-side failures at Twilio in five to ten
//    minutes (counted where a sign-in code fails to send, and only when Twilio
//    itself failed: no answer, 401/403/429 or 5xx; a number it refuses is the
//    caller's choice and never counts) page: nobody can sign in
//    by text while that lasts, the console included. The page goes by push
//    first; its own text may not arrive.
//  - THE ROUTING ENGINE. Asked here every five minutes (when MAPS_PROVIDER is
//    osrm); two failed asks in a row page: every taxi and courier quote is
//    refused while it is down.
//  - MMG. A payment a partner came back from that is still waiting for MMG's
//    answer after 30 minutes pages: MMG is not answering its lookups (or
//    keeps saying pending). Read only; no payment is touched here.
//
// Each healthy reading closes its page. Every check runs on its own: one that
// cannot read never stops the others, and an unreadable reading neither pages
// nor closes (no false calm).
// ---------------------------------------------------------------------------

export const DISK_PAGE_TITLE = 'Server disk almost full';
export const MEMORY_PAGE_TITLE = 'Server memory almost exhausted';
export const TWILIO_PAGE_TITLE = 'Sign-in texts are failing (Twilio)';
export const ROUTING_PAGE_TITLE = 'Road routing is down (OSRM)';
export const MMG_WAITING_PAGE_TITLE = 'MMG is not answering payment checks';

type Env = Readonly<Record<string, string | undefined>>;
type Deps = { prisma: PrismaClient; redis: Redis; notifications: NotificationService };

const percentSetting = (env: Env, name: string, fallback: number): number => {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : fallback;
};

export async function hostDisk(): Promise<{ total: number; free: number }> {
  const s = await statfs('/');
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}

export async function hostMemory(): Promise<{ total: number; available: number }> {
  const text = await readFile('/proc/meminfo', 'utf8');
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text);
    if (!m) throw new Error(`/proc/meminfo has no ${name}`);
    return Number(m[1]) * 1024;
  };
  return { total: kb('MemTotal'), available: kb('MemAvailable') };
}

export async function watchHostResources(
  deps: Deps,
  options: { disk?: () => Promise<{ total: number; free: number }>; memory?: () => Promise<{ total: number; available: number }>; env?: Env } = {},
): Promise<{ diskUsedPct: number | null; memoryUsedPct: number | null }> {
  const env = options.env ?? process.env;
  let diskUsedPct: number | null = null;
  let memoryUsedPct: number | null = null;
  try {
    const d = await (options.disk ?? hostDisk)();
    if (d.total > 0) diskUsedPct = Math.round((1 - d.free / d.total) * 100);
  } catch {
    diskUsedPct = null;
  }
  try {
    const m = await (options.memory ?? hostMemory)();
    if (m.total > 0) memoryUsedPct = Math.round((1 - m.available / m.total) * 100);
  } catch {
    memoryUsedPct = null;
  }
  if (diskUsedPct !== null) {
    if (diskUsedPct >= percentSetting(env, 'HOST_DISK_ALERT_PERCENT', 85)) {
      await pageOps(deps, {
        key: 'ops_page:host-disk',
        windowSeconds: 3600,
        title: DISK_PAGE_TITLE,
        body: `The server's disk is ${diskUsedPct}% full. When it fills, Postgres and Redis stop and nothing can be saved or paged. On the host: df -h /, then docker builder prune -f and docker image prune -f (never a volume). INCIDENT-RUNBOOK section 3, step 7.`,
        data: { kind: 'ops_host_disk', usedPercent: diskUsedPct },
      });
    } else {
      await resolveOpsPage(deps.prisma, DISK_PAGE_TITLE, 'disk-below-threshold');
    }
  }
  if (memoryUsedPct !== null) {
    if (memoryUsedPct >= percentSetting(env, 'HOST_MEMORY_ALERT_PERCENT', 90)) {
      await pageOps(deps, {
        key: 'ops_page:host-memory',
        windowSeconds: 3600,
        title: MEMORY_PAGE_TITLE,
        body: `The server's memory is ${memoryUsedPct}% used. Past it the kernel starts killing processes. On the host: docker stats --no-stream, then restart the service that grew (docker restart <name>); never the database first.`,
        data: { kind: 'ops_host_memory', usedPercent: memoryUsedPct },
      });
    } else {
      await resolveOpsPage(deps.prisma, MEMORY_PAGE_TITLE, 'memory-below-threshold');
    }
  }
  return { diskUsedPct, memoryUsedPct };
}

/** Asks the routing engine one nearest-road question, bounded at five seconds. */
export async function probeOsrm(env: Env = process.env): Promise<{ ok: true } | { ok: false; status: number | 'timeout' | 'network' }> {
  const base = (env['OSRM_URL'] ?? '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/nearest/v1/driving/-58.16,6.80`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { code?: unknown };
    return body && body.code === 'Ok' ? { ok: true } : { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, status: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

export const TWILIO_FAILURES_TO_PAGE = 5;
export const ROUTING_FAILURES_TO_PAGE = 2;
export const MMG_WAIT_MINUTES = 30;

export async function watchProviderOutages(
  deps: Deps,
  options: { nowMs?: number; env?: Env; probeRouting?: (env: Env) => Promise<{ ok: true } | { ok: false; status: number | 'timeout' | 'network' }> } = {},
): Promise<{ twilio: number | null; routing: 'ok' | 'down' | 'off' | null; mmgWaiting: number | null }> {
  const nowMs = options.nowMs ?? Date.now();
  const env = options.env ?? process.env;
  const out: { twilio: number | null; routing: 'ok' | 'down' | 'off' | null; mmgWaiting: number | null } = { twilio: null, routing: null, mmgWaiting: null };

  try {
    const failures = await providerFailuresRecent(deps.redis, 'twilio', nowMs);
    out.twilio = failures;
    if (failures >= TWILIO_FAILURES_TO_PAGE) {
      await pageOps(deps, {
        key: 'ops_page:twilio-failing',
        windowSeconds: 1800,
        title: TWILIO_PAGE_TITLE,
        body: `${failures} sign-in texts failed at Twilio in the last 5 to 10 minutes: nobody can sign in by text (the console included). Check the Twilio balance and the account's status first, then the API log's providerStatus (401/403: the key; 429: rate; 5xx: Twilio).`,
        data: { kind: 'ops_twilio_failing', failures },
      });
    } else if (failures === 0) {
      await resolveOpsPage(deps.prisma, TWILIO_PAGE_TITLE, 'texts-sending');
    }
  } catch {
    out.twilio = null;
  }

  try {
    if ((env['MAPS_PROVIDER'] ?? '').trim() !== 'osrm' || !env['OSRM_URL']) {
      out.routing = 'off';
    } else {
      const answer = await (options.probeRouting ?? probeOsrm)(env);
      if (answer.ok) {
        out.routing = 'ok';
        await clearProviderFailures(deps.redis, 'routing', nowMs);
        await resolveOpsPage(deps.prisma, ROUTING_PAGE_TITLE, 'routing-answering');
      } else {
        out.routing = 'down';
        await recordProviderFailure(deps.redis, 'routing', nowMs);
        const failures = await providerFailuresRecent(deps.redis, 'routing', nowMs);
        if (failures >= ROUTING_FAILURES_TO_PAGE) {
          await pageOps(deps, {
            key: 'ops_page:routing-down',
            windowSeconds: 1800,
            title: ROUTING_PAGE_TITLE,
            body: `The routing engine did not answer ${failures} checks in a row (last: ${answer.status}): every taxi and courier quote is refused. On the host: docker compose -f deploy/docker-compose.routing.yml ps, then up -d osrm.`,
            data: { kind: 'ops_routing_down', failures, status: answer.status },
          });
        }
      }
    }
  } catch {
    out.routing = null;
  }

  try {
    const waiting = await deps.prisma.mmgCheckoutIntent.count({
      where: { status: 'CONFIRMING', replyAt: { lt: new Date(nowMs - MMG_WAIT_MINUTES * 60_000) } },
    });
    out.mmgWaiting = waiting;
    if (waiting > 0) {
      await pageOps(deps, {
        key: 'ops_page:mmg-waiting',
        windowSeconds: 3600,
        title: MMG_WAITING_PAGE_TITLE,
        body: `${waiting} weekly-fee payment(s) partners came back from have waited more than ${MMG_WAIT_MINUTES} minutes for MMG's answer: MMG is not answering its lookups, or keeps saying pending. Partners see "We are checking your payment". Nothing is credited without MMG's answer; check MMG's status, then Console, MMG payments.`,
        data: { kind: 'ops_mmg_waiting', waiting },
      });
    } else {
      await resolveOpsPage(deps.prisma, MMG_WAITING_PAGE_TITLE, 'mmg-answering');
    }
  } catch {
    out.mmgWaiting = null;
  }
  return out;
}
