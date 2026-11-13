/**
 * Container healthcheck for the dedicated worker process (docker-compose.yml
 * worker service) [STG-D].
 *
 * The worker (dist/worker.js) serves no HTTP, so the API image's HEALTHCHECK —
 * a GET /ready — could never succeed and the worker container was permanently
 * "unhealthy" while /health reported worker: ok. This probe reads the SAME
 * signal /health and /ready use to decide the worker fleet is alive — the
 * `scheduler:heartbeat` Redis key the recurring scheduler-heartbeat job writes
 * every 60s (apps/api/src/jobs/queue.ts) — and exits 0 only for a fresh beat.
 *
 * In the compose topology the worker is the ONLY RUN_WORKERS=1 process, so a
 * fresh key IS this worker alive and consuming. The stall window comes from
 * the same total-parsed setting the API uses (SCHEDULER_STALL_ALERT_MINUTES),
 * so a probe verdict can never contradict the API's word about the workers.
 * Docker's start_period (120s) covers boot before the first beat lands.
 */
import Redis from 'ioredis';
import { readFileSync, writeFileSync } from 'node:fs';
import { schedulerStallMs } from '../utils/scheduler-health';
import { applySecretFiles } from '../utils/secret-files';

/** The pure verdict, unit-tested: a beat is healthy when present, numeric and
 *  no older than the stall window. Missing or unparseable means unhealthy. */
export function workerProbeOk(beat: string | null, nowMs: number, stallMs: number): boolean {
  if (beat === null) return false;
  const beatMs = Number(beat);
  if (!Number.isFinite(beatMs)) return false;
  return nowMs - beatMs <= stallMs;
}

// ---------------------------------------------------------------------------
// [FABLE-05 3.2] Docker marks a stalled worker unhealthy and then does nothing:
// an unhealthy container is never restarted, and nothing else on the host does
// it either. So the probe restarts it. After PROBE_RESTART_AFTER failed probes
// in a row (the three Docker counts), once the worker has been up longer than
// its boot grace (the stall window plus a minute: a fresh worker writes its
// first beat within that), the probe asks the worker to stop (SIGTERM: its own
// graceful shutdown, 15 s at most). If it is still there 30 seconds later, it
// is killed. Its restart policy (unless-stopped) starts it again, and the
// API's own scheduler watch pages ops meanwhile. The compose worker runs under
// an init, so it is not PID 1 and a SIGKILL reaches it.
//
// A Redis the probe cannot reach is not the worker's fault, and a restart
// cannot fix it: it reads unhealthy and never counts toward a restart.
//
// The worker says which process it is and when it started (recordWorkerBoot,
// a file in its own /tmp). Without that record the probe never acts.
// ---------------------------------------------------------------------------
export const PROBE_RESTART_AFTER = 3;
export const PROBE_KILL_AFTER_MS = 30_000;
/** [REVIEW-2503-A S3-1] Restarts in any hour before the probe stops restarting and leaves the worker up. */
export const PROBE_MAX_RESTARTS_PER_HOUR = 2;
export const WORKER_BOOT_FILE = '/tmp/swift-worker-boot';
const PROBE_STATE_FILE = '/tmp/swift-worker-probe.json';
const HOUR_MS = 60 * 60_000;

export type ProbeVerdict = 'ok' | 'stale' | 'redis-unreachable';
/**
 * What the probe remembers between runs (a file in the container's /tmp, which a restart keeps).
 * `bootAtMs` is the worker incarnation the counts belong to: a new boot record starts them again, so
 * a restarted worker is never killed on its predecessor's stop request. `restarts` are the stop
 * requests of the last hour, across incarnations: the cap.
 */
export interface ProbeState { failures: number; termSentAt: number | null; bootAtMs: number | null; restarts: number[] }
export interface WorkerBoot { pid: number; bootAtMs: number }
export const freshProbeState = (): ProbeState => ({ failures: 0, termSentAt: null, bootAtMs: null, restarts: [] });

/**
 * The pure decision, unit-tested: what this probe does about the worker.
 *  - none     nothing (healthy, booting, unknown, Redis unreachable, or waiting out a SIGTERM);
 *  - term     ask THIS worker to stop (its graceful shutdown); always first for an incarnation;
 *  - kill     it is still there 30 s after its own SIGTERM;
 *  - capped   it should be restarted, but PROBE_MAX_RESTARTS_PER_HOUR were spent this hour: a restart
 *             is not fixing this stall, so the worker is left up and the API's "Job scheduler
 *             stalled" page (which never depended on this probe) carries it to a person.
 */
export function probeRestartDecision(input: {
  state: ProbeState;
  verdict: ProbeVerdict;
  nowMs: number;
  worker: WorkerBoot | null;
  stallMs: number;
}): { state: ProbeState; action: 'none' | 'term' | 'kill' | 'capped' } {
  const { verdict, nowMs, worker, stallMs } = input;
  const restarts = (input.state.restarts ?? []).filter((t) => nowMs - t < HOUR_MS);
  let state: ProbeState = { ...input.state, restarts };
  if (worker && state.bootAtMs !== worker.bootAtMs) {
    state = { failures: 0, termSentAt: null, bootAtMs: worker.bootAtMs, restarts };
  }
  if (verdict === 'ok') return { state: { ...state, failures: 0, termSentAt: null }, action: 'none' };
  if (verdict === 'redis-unreachable') return { state, action: 'none' };
  const next: ProbeState = { ...state, failures: state.failures + 1 };
  if (!worker || nowMs - worker.bootAtMs <= stallMs + 60_000) return { state: next, action: 'none' };
  if (next.termSentAt !== null) {
    return { state: next, action: nowMs - next.termSentAt >= PROBE_KILL_AFTER_MS ? 'kill' : 'none' };
  }
  if (next.failures < PROBE_RESTART_AFTER) return { state: next, action: 'none' };
  if (restarts.length >= PROBE_MAX_RESTARTS_PER_HOUR) return { state: next, action: 'capped' };
  return { state: { ...next, termSentAt: nowMs, restarts: [...restarts, nowMs] }, action: 'term' };
}

/** Called once by dist/worker.js at boot: which process the probe may restart, and since when. */
export function recordWorkerBoot(file = WORKER_BOOT_FILE): void {
  try {
    writeFileSync(file, `${process.pid} ${Date.now()}\n`, { mode: 0o600 });
  } catch {
    // the probe then never restarts this worker; its health verdict is unchanged
  }
}

function readWorkerBoot(): WorkerBoot | null {
  try {
    const [pid, bootAtMs] = readFileSync(WORKER_BOOT_FILE, 'utf8').trim().split(' ').map(Number);
    return Number.isInteger(pid) && pid! > 1 && Number.isFinite(bootAtMs) ? { pid: pid!, bootAtMs: bootAtMs! } : null;
  } catch {
    return null;
  }
}

function readProbeState(): ProbeState {
  try {
    const s = JSON.parse(readFileSync(PROBE_STATE_FILE, 'utf8')) as Partial<ProbeState>;
    return {
      failures: Number.isInteger(s.failures) ? (s.failures as number) : 0,
      termSentAt: typeof s.termSentAt === 'number' ? s.termSentAt : null,
      bootAtMs: typeof s.bootAtMs === 'number' ? s.bootAtMs : null,
      restarts: Array.isArray(s.restarts) ? s.restarts.filter((t): t is number => typeof t === 'number') : [],
    };
  } catch {
    return freshProbeState();
  }
}

/** Runs the probe and exits 0 (healthy) or 1 (unhealthy). Exported (rather
 *  than auto-run) so the compose healthcheck invokes it explicitly and unit
 *  tests can import the module without a Redis connection or a process exit. */
export async function main(): Promise<void> {
  // The probe is its own process: the worker's Redis URL may be a secret file (it carries the password).
  // Only that name is read; an unreadable file leaves it unset and the verdict says so.
  const env: Record<string, string | undefined> = { REDIS_URL: process.env['REDIS_URL'], REDIS_URL_FILE: process.env['REDIS_URL_FILE'] };
  try {
    applySecretFiles(env);
  } catch {
    env['REDIS_URL'] = undefined;
  }
  const redis = new Redis(env['REDIS_URL'] ?? 'redis://localhost:6379', {
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  let verdict: ProbeVerdict = 'redis-unreachable';
  try {
    await redis.connect();
    const beat = await redis.get('scheduler:heartbeat');
    verdict = workerProbeOk(beat, Date.now(), schedulerStallMs()) ? 'ok' : 'stale';
  } catch {
    verdict = 'redis-unreachable';
  } finally {
    redis.disconnect();
  }
  const worker = readWorkerBoot();
  const decision = probeRestartDecision({ state: readProbeState(), verdict, nowMs: Date.now(), worker, stallMs: schedulerStallMs() });
  try {
    writeFileSync(PROBE_STATE_FILE, JSON.stringify(decision.state), { mode: 0o600 });
  } catch {
    // a probe that cannot remember never escalates; its verdict still stands
  }
  if (decision.action === 'capped') {
    // eslint-disable-next-line no-console -- the probe's stdout is Docker's health log, the only place this reason is kept
    console.log(`worker-probe: scheduler heartbeat stale, but ${PROBE_MAX_RESTARTS_PER_HOUR} restarts this hour did not fix it; leaving the worker up (the API pages "Job scheduler stalled")`);
  } else if (worker && decision.action !== 'none') {
    // Docker keeps the probe's last lines with the health status (docker inspect): the reason is there.
    const signal = decision.action === 'term' ? 'SIGTERM' : 'SIGKILL';
    try {
      process.kill(worker.pid, signal);
      // eslint-disable-next-line no-console -- the probe's stdout is Docker's health log, the only place this reason is kept
      console.log(`worker-probe: scheduler heartbeat stale for ${decision.state.failures} probes; sent ${signal} to the worker (pid ${worker.pid}) so its restart policy starts it again`);
    } catch {
      // eslint-disable-next-line no-console -- as above
      console.log(`worker-probe: scheduler heartbeat stale; the worker (pid ${worker.pid}) could not be signalled`);
    }
  }
  process.exit(verdict === 'ok' ? 0 : 1);
}
