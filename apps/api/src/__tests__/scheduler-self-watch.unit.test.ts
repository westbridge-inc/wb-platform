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
    expect(app).toContain('const pageSchedulerVerdict = ');
    const health = app.slice(app.indexOf("app.get('/health'"), app.indexOf('registerReadinessRoute(app'));
    expect(health).toContain('pageSchedulerVerdict(workerHealth, beat);');
    const watch = app.slice(app.indexOf('schedulerSelfWatchMs()'));
    expect(watch).toMatch(/addHook\('onReady'[\s\S]*setInterval[\s\S]*pageSchedulerVerdict\(/);
    expect(watch).toMatch(/addHook\('onClose'[\s\S]*clearInterval/);
  });
});
