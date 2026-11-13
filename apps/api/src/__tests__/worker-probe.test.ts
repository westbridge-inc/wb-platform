import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerProbeOk } from '../boot/worker-probe';
import { DEFAULT_SCHEDULER_STALL_MINUTES, schedulerStallMs } from '../utils/scheduler-health';

// ---------------------------------------------------------------------------
// [STG-D] The dedicated worker container was permanently "unhealthy": the API
// image's HEALTHCHECK fetches GET /ready, and dist/worker.js serves no HTTP.
// The worker's own probe (dist/boot/worker-probe.js) reads the SAME signal
// /health and /ready use — the `scheduler:heartbeat` Redis key — and must
// agree with the API's verdict about the worker fleet.
// ---------------------------------------------------------------------------

const MIN = 60_000;

describe('workerProbeOk — the container probe agrees with /health', () => {
  const stall = schedulerStallMs({});

  it('a fresh heartbeat is healthy', () => {
    const now = Date.now();
    expect(workerProbeOk(String(now - MIN), now, stall)).toBe(true);
  });

  it('a heartbeat exactly at the stall window is still healthy (the API agrees)', () => {
    const now = Date.now();
    expect(workerProbeOk(String(now - stall), now, stall)).toBe(true);
  });

  it('a stale heartbeat is unhealthy', () => {
    const now = Date.now();
    expect(workerProbeOk(String(now - stall - 1), now, stall)).toBe(false);
  });

  it('a missing heartbeat is unhealthy — the probe has no boot grace to hide behind', () => {
    // The probe is a fresh process on every run; "no beat yet" inside a grace
    // window is what Docker's start_period covers, so after it a worker that
    // never beats (crash loop, or RUN_WORKERS misconfigured) must be red.
    expect(workerProbeOk(null, Date.now(), stall)).toBe(false);
  });

  it('an unparseable heartbeat is unhealthy', () => {
    for (const junk of ['', 'not-a-number', 'Infinity', 'NaN']) {
      expect(workerProbeOk(junk, Date.now(), stall)).toBe(false);
    }
  });

  it('reads the same key and the same total-parsed stall window as /health', () => {
    const probe = readFileSync(join(process.cwd(), 'src/boot/worker-probe.ts'), 'utf8');
    expect(probe).toContain("redis.get('scheduler:heartbeat')");
    expect(probe).toContain('schedulerStallMs()');
    expect(DEFAULT_SCHEDULER_STALL_MINUTES).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// [FABLE-05 3.2] Docker marks a stalled worker unhealthy and does nothing
// else: an unhealthy container is never restarted. The probe now restarts it
// itself: after RESTART_AFTER failed probes in a row (the same three Docker
// counts), once the worker has been up past its boot grace, it asks the worker
// to stop (SIGTERM, its own graceful shutdown); if it is still there a probe
// later, it is killed. The worker's restart policy (unless-stopped) starts it
// again. A Redis that cannot be reached is not the worker's fault: a restart
// cannot fix it, so it never counts.
// ---------------------------------------------------------------------------
import { freshProbeState, probeRestartDecision, PROBE_MAX_RESTARTS_PER_HOUR, PROBE_RESTART_AFTER, type ProbeState } from '../boot/worker-probe';

describe('probeRestartDecision — a stalled worker is restarted, never a booting one', () => {
  const stall = schedulerStallMs({});
  const fresh: ProbeState = freshProbeState();
  const now = 10 * 60 * MIN;
  const upLong = { pid: 7, bootAtMs: now - 60 * MIN };
  // a state this incarnation already owns (the probe has seen this boot record before)
  const st = (failures: number, termSentAt: number | null): ProbeState => ({ failures, termSentAt, bootAtMs: upLong.bootAtMs, restarts: termSentAt === null ? [] : [termSentAt] });
  const stale = (state: ProbeState, worker = upLong, at = now) =>
    probeRestartDecision({ state, verdict: 'stale', nowMs: at, worker, stallMs: stall });

  it('a healthy probe clears the count and does nothing', () => {
    expect(probeRestartDecision({ state: st(2, now - MIN), verdict: 'ok', nowMs: now, worker: upLong, stallMs: stall }))
      .toEqual({ state: { ...fresh, bootAtMs: upLong.bootAtMs, restarts: [now - MIN] }, action: 'none' });
  });

  it('counts stale probes and asks the worker to stop at the third, once', () => {
    let s = fresh;
    const actions: string[] = [];
    for (let i = 0; i < PROBE_RESTART_AFTER; i++) {
      const d = stale(s);
      actions.push(d.action);
      s = d.state;
    }
    expect(PROBE_RESTART_AFTER).toBe(3);
    expect(actions).toEqual(['none', 'none', 'term']);
    expect(s).toEqual({ failures: 3, termSentAt: now, bootAtMs: upLong.bootAtMs, restarts: [now] });
    // the next probe inside the shutdown window waits for the graceful stop
    expect(stale(s, upLong, now + 10_000).action).toBe('none');
  });

  it('kills a worker that is still there 30 seconds after it was asked to stop', () => {
    const d = stale(st(3, now - 30_000));
    expect(d.action).toBe('kill');
  });

  it('never touches a worker inside its boot grace (its first beat is not written yet)', () => {
    const booting = { pid: 7, bootAtMs: now - 2 * MIN };
    const d = stale({ ...st(9, null), bootAtMs: booting.bootAtMs }, booting);
    expect(d.action).toBe('none');
  });

  it('never acts without knowing which process the worker is and when it started', () => {
    expect(probeRestartDecision({ state: st(9, null), verdict: 'stale', nowMs: now, worker: null, stallMs: stall }).action).toBe('none');
  });

  it('an unreachable Redis is unhealthy but never counts toward a restart', () => {
    const d = probeRestartDecision({ state: st(2, null), verdict: 'redis-unreachable', nowMs: now, worker: upLong, stallMs: stall });
    expect(d).toEqual({ state: st(2, null), action: 'none' });
  });

  // [REVIEW-2503-A S3-1] The state file outlives the restart (same container). A stall a restart cannot
  // fix used to end in SIGKILL every 6.5 minutes forever: the new worker inherited the old stop request.
  it('a restart that does not help: each new worker gets SIGTERM first, at most twice an hour, then it is left up', () => {
    const PROBE_MS = 30_000;
    let state = freshProbeState();
    let worker = { pid: 100, bootAtMs: now };
    const log: { atMin: number; action: string }[] = [];
    for (let t = now; t <= now + 3 * 60 * MIN; t += PROBE_MS) {
      const d = probeRestartDecision({ state, verdict: 'stale', nowMs: t, worker, stallMs: stall });
      state = d.state;
      if (d.action !== 'none') log.push({ atMin: Math.round((t - now) / MIN * 10) / 10, action: d.action });
      // the worker obeys SIGTERM: its restart policy starts a new one (a new boot record) 5 s later
      if (d.action === 'term') worker = { pid: worker.pid + 1, bootAtMs: t + 5_000 };
    }
    const actions = log.map((l) => l.action);
    expect(actions).not.toContain('kill');
    const terms = log.filter((l) => l.action === 'term').map((l) => l.atMin);
    expect(PROBE_MAX_RESTARTS_PER_HOUR).toBe(2);
    for (const at of terms) expect(terms.filter((x) => x > at - 60 && x <= at).length).toBeLessThanOrEqual(PROBE_MAX_RESTARTS_PER_HOUR);
    expect(actions).toContain('capped');
    // and the cap opens again an hour after a restart: not one restart in three hours, not one every 6.5 min
    expect(terms.length).toBeGreaterThan(2);
    expect(terms.length).toBeLessThanOrEqual(6);
  });

  it('a new worker never inherits the old stop request: SIGTERM first, SIGKILL only 30 s after its own', () => {
    const old = { ...st(3, now - 10 * MIN) };
    const reborn = { pid: 8, bootAtMs: now - 7 * MIN };
    const d = probeRestartDecision({ state: old, verdict: 'stale', nowMs: now, worker: reborn, stallMs: stall });
    expect(d.action).toBe('none');
    expect(d.state).toMatchObject({ failures: 1, termSentAt: null, bootAtMs: reborn.bootAtMs });
  });

  it('a worker that ignores SIGTERM is still killed, once, and that counts as its restart', () => {
    let s: ProbeState = { ...freshProbeState(), bootAtMs: upLong.bootAtMs };
    const acts: string[] = [];
    for (let t = now; t < now + 3 * MIN; t += 30_000) {
      const d = stale(s, upLong, t);
      s = d.state;
      acts.push(d.action);
    }
    expect(acts.filter((a) => a === 'term').length).toBe(1);
    expect(acts.indexOf('kill')).toBeGreaterThan(acts.indexOf('term'));
    expect(s.restarts.length).toBe(1);
  });

  it('the worker records its own pid and boot time for the probe, and the compose worker runs under an init', () => {
    const worker = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    expect(worker).toContain('recordWorkerBoot(');
    const compose = readFileSync(join(process.cwd(), '..', '..', 'deploy', 'docker-compose.yml'), 'utf8');
    const block = compose.slice(compose.indexOf('\n  worker:'), compose.indexOf('\n  caddy:'));
    // under an init the worker is not PID 1, so the probe's SIGKILL reaches it
    expect(block).toMatch(/\n {4}init: true\n/);
    expect(block).toContain('restart: unless-stopped');
  });
});
