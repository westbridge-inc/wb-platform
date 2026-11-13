/**
 * [FABLE-05 3.7 · 3.11] What paged nobody now pages, from the worker's five-minute watch, through the
 * durable ops-page path (an OpsAlert row, a push, the on-call text, escalation until acknowledged):
 *   - the server's disk or memory nearly full (a full disk stops Postgres and Redis, and then no page
 *     can be stored at all, so the alarm comes well before);
 *   - sign-in texts failing at Twilio (an empty balance, a revoked key, an outage: nobody can sign in,
 *     the console included);
 *   - the routing engine not answering (every taxi and courier quote is refused);
 *   - MMG not giving an answer on payments partners came back from.
 * A healthy reading closes the page. Provider failures are logged with the provider's HTTP status as
 * a number of its own (never its message, which may echo the request).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/ops/ops-page', () => ({
  pageOps: vi.fn(async () => ({ status: 'delivered', opsAlertId: 'a1', recipients: 1 })),
  resolveOpsPage: vi.fn(async () => 1),
}));

import { pageOps, resolveOpsPage } from '../modules/ops/ops-page';
import {
  DISK_PAGE_TITLE, MEMORY_PAGE_TITLE, MMG_WAITING_PAGE_TITLE, ROUTING_PAGE_TITLE, TWILIO_PAGE_TITLE,
  watchHostResources, watchProviderOutages,
} from '../modules/ops/infra-watch';
import { ProviderCallError, providerStatusOf, recordProviderFailure } from '../lib/provider-failure';

afterEach(() => {
  vi.mocked(pageOps).mockClear();
  vi.mocked(resolveOpsPage).mockClear();
});

function fakeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    incrby: vi.fn(async (k: string, n: number) => { const v = (store.get(k) ?? 0) + n; store.set(k, v); return v; }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (...keys: string[]) => { keys.forEach((k) => store.delete(k)); return keys.length; }),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => (store.has(k) ? String(store.get(k)) : null))),
  };
}
const fakePrisma = (waiting = 0) => ({ mmgCheckoutIntent: { count: vi.fn(async () => waiting) } });
const deps = (redis = fakeRedis(), prisma = fakePrisma()) => ({ prisma: prisma as never, redis: redis as never, notifications: {} as never });
const titles = (fn: typeof pageOps | typeof resolveOpsPage) =>
  vi.mocked(fn).mock.calls.map((c) => (fn === pageOps ? (c[1] as { title: string }).title : (c[1] as unknown as string)));

const GB = 1024 ** 3;
const disk = (usedPct: number) => async () => ({ total: 100 * GB, free: (100 - usedPct) * GB });
const memory = (usedPct: number) => async () => ({ total: 8 * GB, available: (8 * (100 - usedPct) / 100) * GB });

describe('the server disk and memory', () => {
  it('pages at 85% of the disk used, and closes the page below it', async () => {
    await watchHostResources(deps(), { disk: disk(86), memory: memory(40) });
    expect(titles(pageOps)).toEqual([DISK_PAGE_TITLE]);
    expect(titles(resolveOpsPage)).toEqual([MEMORY_PAGE_TITLE]);
    vi.mocked(pageOps).mockClear();
    vi.mocked(resolveOpsPage).mockClear();
    await watchHostResources(deps(), { disk: disk(60), memory: memory(40) });
    expect(titles(pageOps)).toEqual([]);
    expect(titles(resolveOpsPage).sort()).toEqual([DISK_PAGE_TITLE, MEMORY_PAGE_TITLE].sort());
  });

  it('pages when less than a tenth of the memory is available', async () => {
    await watchHostResources(deps(), { disk: disk(10), memory: memory(93) });
    expect(titles(pageOps)).toEqual([MEMORY_PAGE_TITLE]);
    const body = (vi.mocked(pageOps).mock.calls[0]![1] as { body: string }).body;
    expect(body).toMatch(/93%/);
  });

  it('thresholds are settings; a junk value keeps the default, never silence', async () => {
    await watchHostResources(deps(), { disk: disk(80), memory: memory(10), env: { HOST_DISK_ALERT_PERCENT: '75' } });
    expect(titles(pageOps)).toEqual([DISK_PAGE_TITLE]);
    vi.mocked(pageOps).mockClear();
    await watchHostResources(deps(), { disk: disk(86), memory: memory(10), env: { HOST_DISK_ALERT_PERCENT: 'off' } });
    expect(titles(pageOps)).toEqual([DISK_PAGE_TITLE]);
  });

  it('an unreadable reading pages nothing and closes nothing (no false calm)', async () => {
    const broken = async () => { throw new Error('statfs failed'); };
    await watchHostResources(deps(), { disk: broken, memory: broken });
    expect(titles(pageOps)).toEqual([]);
    expect(titles(resolveOpsPage)).toEqual([]);
  });
});

describe('providers that stop answering', () => {
  const now = Date.UTC(2026, 10, 13, 6, 0, 0);
  const routingOk = vi.fn(async () => ({ ok: true as const }));
  const routingDown = vi.fn(async () => ({ ok: false as const, status: 502 }));

  it('five failed sign-in texts in ten minutes page "sign-in texts are failing"; none closes it', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 4; i++) await recordProviderFailure(redis as never, 'twilio', now - 60_000);
    await watchProviderOutages(deps(redis), { nowMs: now, probeRouting: routingOk, env: {} });
    expect(titles(pageOps)).not.toContain(TWILIO_PAGE_TITLE);
    await recordProviderFailure(redis as never, 'twilio', now);
    await watchProviderOutages(deps(redis), { nowMs: now, probeRouting: routingOk, env: {} });
    expect(titles(pageOps)).toContain(TWILIO_PAGE_TITLE);
    vi.mocked(resolveOpsPage).mockClear();
    // twenty minutes later nothing failed: the page closes
    await watchProviderOutages(deps(redis), { nowMs: now + 20 * 60_000, probeRouting: routingOk, env: {} });
    expect(titles(resolveOpsPage)).toContain(TWILIO_PAGE_TITLE);
  });

  it('the routing engine: two failed probes in a row page; an answer closes it; off when routing is not OSRM', async () => {
    const redis = fakeRedis();
    const env = { MAPS_PROVIDER: 'osrm', OSRM_URL: 'http://osrm:5000' };
    await watchProviderOutages(deps(redis), { nowMs: now, probeRouting: routingDown, env });
    expect(titles(pageOps)).not.toContain(ROUTING_PAGE_TITLE);
    await watchProviderOutages(deps(redis), { nowMs: now + 5 * 60_000, probeRouting: routingDown, env });
    expect(titles(pageOps)).toContain(ROUTING_PAGE_TITLE);
    const page = vi.mocked(pageOps).mock.calls.find((c) => (c[1] as { title: string }).title === ROUTING_PAGE_TITLE)![1] as { data: Record<string, unknown> };
    expect(page.data['status']).toBe(502);
    await watchProviderOutages(deps(redis), { nowMs: now + 10 * 60_000, probeRouting: routingOk, env });
    expect(titles(resolveOpsPage)).toContain(ROUTING_PAGE_TITLE);
    const probe = vi.fn(async () => ({ ok: false as const, status: 502 }));
    await watchProviderOutages(deps(fakeRedis()), { nowMs: now, probeRouting: probe, env: { MAPS_PROVIDER: 'haversine' } });
    expect(probe).not.toHaveBeenCalled();
  });

  it('payments partners came back from that MMG has not answered for 30 minutes page; none closes it', async () => {
    const prisma = fakePrisma(2);
    await watchProviderOutages(deps(fakeRedis(), prisma), { nowMs: now, probeRouting: routingOk, env: {} });
    expect(titles(pageOps)).toContain(MMG_WAITING_PAGE_TITLE);
    const where = (prisma.mmgCheckoutIntent.count.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where['status']).toBe('CONFIRMING');
    expect(where['replyAt']).toEqual({ lt: new Date(now - 30 * 60_000) });
    vi.mocked(pageOps).mockClear();
    await watchProviderOutages(deps(fakeRedis(), fakePrisma(0)), { nowMs: now, probeRouting: routingOk, env: {} });
    expect(titles(pageOps)).not.toContain(MMG_WAITING_PAGE_TITLE);
    expect(titles(resolveOpsPage)).toContain(MMG_WAITING_PAGE_TITLE);
  });

  it('one provider failing to read never stops the others', async () => {
    const prisma = { mmgCheckoutIntent: { count: vi.fn(async () => { throw new Error('db'); }) } };
    const redis = fakeRedis();
    for (let i = 0; i < 5; i++) await recordProviderFailure(redis as never, 'twilio', now);
    await watchProviderOutages(deps(redis, prisma as never), { nowMs: now, probeRouting: routingOk, env: {} });
    expect(titles(pageOps)).toContain(TWILIO_PAGE_TITLE);
  });
});

describe('the provider status code, as a number of its own', () => {
  it('reads the HTTP status of a provider error, and nothing else', () => {
    expect(providerStatusOf(new ProviderCallError('twilio', 'http', 401))).toBe(401);
    expect(providerStatusOf(new ProviderCallError('twilio', 'timeout'))).toBe('timeout');
    expect(providerStatusOf(new ProviderCallError('twilio', 'network'))).toBe('network');
    expect(providerStatusOf(new Error('Twilio SMS failed (500) +5926000000'))).toBeUndefined();
    expect(providerStatusOf('junk')).toBeUndefined();
  });
});

// [Security review, 13 Nov] A failed send counts toward "sign-in texts are failing" only when the
// PROVIDER failed (no answer, our credentials or rate refused, its own error). A number Twilio refuses
// (400 invalid number, 404) is the caller's choice: anyone can ask for codes to bad numbers, and that
// must never page the on-call phones.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countsAsProviderOutage } from '../lib/provider-failure';

describe('only provider-side failures count toward the outage page', () => {
  it('timeouts, network failures, 401/403/429 and 5xx count; per-recipient 4xx and unknown errors never do', () => {
    for (const err of [new ProviderCallError('twilio', 'timeout'), new ProviderCallError('twilio', 'network'),
      new ProviderCallError('twilio', 'http', 401), new ProviderCallError('twilio', 'http', 403), new ProviderCallError('twilio', 'http', 429),
      new ProviderCallError('twilio', 'http', 500), new ProviderCallError('twilio', 'http', 503)]) {
      expect(countsAsProviderOutage(err), `${err.kind} ${err.status}`).toBe(true);
    }
    for (const err of [new ProviderCallError('twilio', 'http', 400), new ProviderCallError('twilio', 'http', 404),
      new ProviderCallError('twilio', 'http', 422), new Error('Twilio SMS failed (500)'), 'junk', undefined]) {
      expect(countsAsProviderOutage(err)).toBe(false);
    }
  });

  it('a burst of invalid-number rejections never pages', async () => {
    const redis = fakeRedis();
    const now = Date.UTC(2026, 10, 13, 6, 0, 0);
    for (let i = 0; i < 50; i++) {
      const err = new ProviderCallError('twilio', 'http', 400);
      if (countsAsProviderOutage(err)) await recordProviderFailure(redis as never, 'twilio', now);
    }
    await watchProviderOutages(deps(redis), { nowMs: now, probeRouting: async () => ({ ok: true as const }), env: {} });
    expect(titles(pageOps)).not.toContain(TWILIO_PAGE_TITLE);
  });

  it('the sign-in send counts a failure only through that rule', () => {
    const src = readFileSync(join(process.cwd(), 'src/modules/auth/auth.service.ts'), 'utf8');
    expect(src).toMatch(/if \(countsAsProviderOutage\(err\)\) await recordProviderFailure\(this\.app\.redis, 'twilio'\)/);
  });
});
