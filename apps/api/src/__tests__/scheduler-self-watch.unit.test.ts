import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schedulerSelfWatchMs } from '../utils/scheduler-health';

// [FABLE-05 3.2] The scheduler-stall page rode the load balancer's /health
// polls, and there is no load balancer: a stalled worker paged nobody unless
// something outside polled /health. The API process now runs the same check
// itself, every minute, on the same verdict and the same paging path.
describe('the API watches the scheduler itself', () => {
  it('every 60 seconds by default in a running server; off under test unless asked', () => {
    expect(schedulerSelfWatchMs({ NODE_ENV: 'production' })).toBe(60_000);
    expect(schedulerSelfWatchMs({ NODE_ENV: 'development' })).toBe(60_000);
    expect(schedulerSelfWatchMs({ NODE_ENV: 'test' })).toBe(0);
    expect(schedulerSelfWatchMs({ NODE_ENV: 'test', SCHEDULER_SELF_WATCH_SECONDS: '5' })).toBe(5_000);
  });

  it('a junk or non-positive interval never switches it off silently: the default stands', () => {
    for (const junk of ['', 'abc', 'Infinity', '-1', '0']) {
      expect(schedulerSelfWatchMs({ NODE_ENV: 'production', SCHEDULER_SELF_WATCH_SECONDS: junk })).toBe(60_000);
    }
  });

  it('the server starts the watch when ready and stops it on close, through the same paging as /health', () => {
    const app = readFileSync(join(process.cwd(), 'src/app.ts'), 'utf8');
    expect(app).toContain('function pageSchedulerVerdict(workerHealth: SchedulerHealth, beat: string | null): void {');
    const health = app.slice(app.indexOf("app.get('/health'"), app.indexOf('registerReadinessRoute(app'));
    expect(health).toContain('pageSchedulerVerdict(workerHealth, beat);');
    const watch = app.slice(app.indexOf('schedulerSelfWatchMs()'));
    expect(watch).toMatch(/addHook\('onReady'[\s\S]*setInterval[\s\S]*pageSchedulerVerdict\(/);
    expect(watch).toMatch(/addHook\('onClose'[\s\S]*clearInterval/);
  });
});

// [REVIEW-2503-A S4-3] Right after a deploy the old worker's last beat is as old as the stop, the
// migration and the boot together: a long migration paged "Job scheduler stalled" once, falsely. A
// stall page waits until this API process has itself been up a whole stall window.
import { schedulerPageAllowed } from '../utils/scheduler-health';

describe('the stall page has a post-deploy grace', () => {
  const stall = 5 * 60_000;
  const boot = 1_000_000_000;
  it('a stale beat inside the first stall window of this process pages nothing; after it, it pages', () => {
    expect(schedulerPageAllowed({ page: true, kind: 'stall', ageMs: 9 * 60_000 }, boot + 4 * 60_000, boot, stall)).toBe(false);
    expect(schedulerPageAllowed({ page: true, kind: 'stall', ageMs: 9 * 60_000 }, boot + 5 * 60_000 + 1, boot, stall)).toBe(true);
  });
  it('the grace is a setting: 0 pages at once, junk keeps the stall window', () => {
    const h = { page: true as const, kind: 'stall' as const, ageMs: 9 * 60_000 };
    expect(schedulerPageAllowed(h, boot + 1_000, boot, stall, { SCHEDULER_STALL_PAGE_GRACE_SECONDS: '0' })).toBe(true);
    expect(schedulerPageAllowed(h, boot + 1_000, boot, stall, { SCHEDULER_STALL_PAGE_GRACE_SECONDS: 'Infinity' })).toBe(false);
    expect(schedulerPageAllowed(h, boot + 1_000, boot, stall, { SCHEDULER_STALL_PAGE_GRACE_SECONDS: '-1' })).toBe(false);
  });
  it('never-started keeps its own grace and a healthy verdict never pages', () => {
    expect(schedulerPageAllowed({ page: true, kind: 'never-booted', ageMs: 6 * 60_000 }, boot + 6 * 60_000, boot, stall)).toBe(true);
    expect(schedulerPageAllowed({ page: false }, boot + 60 * 60_000, boot, stall)).toBe(false);
  });
  it('the paging path asks it', () => {
    const app = readFileSync(join(process.cwd(), 'src/app.ts'), 'utf8');
    expect(app).toContain('if (!schedulerPageAllowed(health, Date.now(), SERVER_BOOTED_AT, schedulerStallMs())) return;');
  });
});
