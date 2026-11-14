import { describe, expect, it } from 'vitest';
import { DragontailClient, requestNeverSent, type FetchLike } from '../modules/kitchen/dragontail/dragontail-client';
import { KitchenPermanentError, KitchenTransientError } from '../modules/kitchen/kitchen-provider';
import { kitchenBreakerSettings } from '../modules/kitchen/kitchen-link';

// ---------------------------------------------------------------------------
// [DT-OUTAGE · owner 14 Nov 2026] Which send failures CERTAINLY never reached Dragontail (connect-phase only), and
// which MAY have (everything else: when in doubt it is "may have arrived", never a double cook).
// ---------------------------------------------------------------------------

/** Node's fetch failure shape: TypeError('fetch failed', { cause }) with the system error's code on the cause. */
const fetchFailed = (code: string, syscall?: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code, ...(syscall ? { syscall } : {}) }) });

describe('[DT-OUTAGE] requestNeverSent', () => {
  it('connect-phase failures: refused, no such host, no route, TLS handshake, undici connect timeout', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(requestNeverSent(fetchFailed(code), false), code).toBe(true);
    }
    for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL']) {
      expect(requestNeverSent(fetchFailed(code, 'connect'), false), `${code} on connect`).toBe(true);
    }
    // Every address refused (happy eyeballs): an AggregateError of connect failures.
    const all = Object.assign(new TypeError('fetch failed'), { cause: new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })]) });
    expect(requestNeverSent(all, false)).toBe(true);
  });

  it('[round 3 · review B S3-4] an unreachable/down code from a write or read on a pooled socket is NOT certain', () => {
    for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL']) {
      expect(requestNeverSent(fetchFailed(code, 'write'), false), `${code} on write`).toBe(false);
      expect(requestNeverSent(fetchFailed(code, 'read'), false), `${code} on read`).toBe(false);
      expect(requestNeverSent(fetchFailed(code), false), `${code} with no syscall`).toBe(false);
    }
  });

  it('anything that may have happened after the request left is NOT certain: reset, socket closed, our timeout, unknown', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']) {
      expect(requestNeverSent(fetchFailed(code), false), code).toBe(false);
    }
    expect(requestNeverSent(fetchFailed('ECONNREFUSED'), true), 'our own abort wins: may have arrived').toBe(false);
    expect(requestNeverSent(new TypeError('fetch failed'), false)).toBe(false);
    expect(requestNeverSent(new TypeError('unexpected redirect'), false), 'a redirect is an ANSWER').toBe(false);
    const mixed = Object.assign(new TypeError('fetch failed'), { cause: new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNRESET' })]) });
    expect(requestNeverSent(mixed, false)).toBe(false);
  });
});

function client(fetch: FetchLike) {
  return new DragontailClient({ baseUrl: 'https://api.dragontailsystem.com', login: { userName: 'u', password: 'p' }, userLevel: -1, timeoutMs: 1_000, fetch, sleep: async () => {}, backoffMs: 1, token: 'cached' });
}

describe('[DT-OUTAGE] the client says which it was', () => {
  it('an insert that could not connect: NOT may-have-landed (and not retried)', async () => {
    let calls = 0;
    const c = client(async () => { calls += 1; throw fetchFailed('ECONNREFUSED'); });
    const err = await c.call('POST', '/PosInsertOrders', {}, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitchenTransientError);
    expect((err as KitchenTransientError).mayHaveLanded).toBe(false);
    expect(calls).toBe(1);
  });

  it('an insert whose connection was reset: may-have-landed, exactly as before', async () => {
    const c = client(async () => { throw fetchFailed('ECONNRESET'); });
    const err = await c.call('POST', '/PosInsertOrders', {}, false).catch((e: unknown) => e);
    expect((err as KitchenTransientError).mayHaveLanded).toBe(true);
  });

  it('[round 2 · S2-1] a 504, then a refused connection on the retry: MAY have landed (an earlier attempt reached Dragontail)', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      if (calls === 1) return { status: 504, text: async () => 'gateway timeout' };
      throw fetchFailed('ECONNREFUSED');
    });
    const err = await c.call('POST', '/PosInsertOrders', {}, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitchenTransientError);
    expect(calls).toBe(2);
    expect((err as KitchenTransientError).mayHaveLanded).toBe(true);
    expect((err as KitchenTransientError).linkFailure, 'and the link is failing').toBe(true);
    expect((err as Error).message).not.toContain('nothing was sent');
  });

  it('[round 2 · S2-1] a write still 5xx after every retry: MAY have landed; a read or a login: not (asked again)', async () => {
    const fiveHundreds = () => client(async () => ({ status: 502, text: async () => 'bad gateway' }));
    const write = await fiveHundreds().call('POST', '/PosInsertOrders', {}, false).catch((e: unknown) => e);
    expect((write as KitchenTransientError).mayHaveLanded).toBe(true);
    expect((write as KitchenTransientError).linkFailure).toBe(true);
    const read = await fiveHundreds().call('GET', '/PosGetVehicles/1').catch((e: unknown) => e);
    expect((read as KitchenTransientError).mayHaveLanded).toBe(false);
    const login = await fiveHundreds().login().catch((e: unknown) => e);
    expect((login as KitchenTransientError).mayHaveLanded).toBe(false);
  });

  it('[round 3 · review B S3-5] a 504, then a REFUSAL answer on the retry (flowError, a duplicate): may have arrived', async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return calls === 1 ? { status: 504, text: async () => 'gateway timeout' } : { status: 200, text: async () => JSON.stringify({ status: 'flowError' }) };
    });
    const answer = await c.call('POST', '/PosInsertOrders', {}, false) as { status: number; after5xx?: boolean };
    expect(calls).toBe(2);
    expect(answer.status).toBe(200);
    expect(answer.after5xx, 'the caller is told an earlier attempt reached Dragontail').toBe(true);
    let first = 0;
    const plain = await client(async () => { first += 1; return { status: 200, text: async () => JSON.stringify({ status: 'validationError' }) }; }).call('POST', '/PosInsertOrders', {}, false) as { after5xx?: boolean };
    expect(first).toBe(1);
    expect(plain.after5xx ?? false, 'a first-attempt refusal is a real refusal').toBe(false);
  });

  it('a timeout alone is "may have landed" but NOT a link failure (a slow kitchen is not a down one)', async () => {
    const err = await client(async () => { throw fetchFailed('ECONNRESET'); }).call('POST', '/PosInsertOrders', {}, false).catch((e: unknown) => e);
    expect((err as KitchenTransientError).mayHaveLanded).toBe(true);
    expect((err as KitchenTransientError).linkFailure ?? false).toBe(false);
  });

  it('a login refused is a LINK failure; it is never "may have landed"', async () => {
    const c = new DragontailClient({ baseUrl: 'https://api.dragontailsystem.com', login: { userName: 'u', password: 'p' }, userLevel: -1, timeoutMs: 1_000, fetch: async () => ({ status: 400, text: async () => '{}' }), sleep: async () => {}, backoffMs: 1 });
    const err = await c.login().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitchenPermanentError);
    expect((err as KitchenPermanentError).linkFailure).toBe(true);
  });

  it('breaker defaults: 3 in a row, a probe a minute (at most 15 min after failed trials), quiet after 10 min; out-of-range settings ignored', () => {
    expect(kitchenBreakerSettings({})).toEqual({ failures: 3, probeMs: 60_000, probeMaxMs: 900_000, quietMs: 600_000 });
    expect(kitchenBreakerSettings({ DRAGONTAIL_BREAKER_FAILURES: '5', DRAGONTAIL_BREAKER_PROBE_SECONDS: '30', DRAGONTAIL_LINK_QUIET_SECONDS: '300' })).toEqual({ failures: 5, probeMs: 30_000, probeMaxMs: 900_000, quietMs: 300_000 });
    expect(kitchenBreakerSettings({ DRAGONTAIL_BREAKER_FAILURES: '0', DRAGONTAIL_LINK_QUIET_SECONDS: 'x' })).toEqual({ failures: 3, probeMs: 60_000, probeMaxMs: 900_000, quietMs: 600_000 });
  });

  it('[round 3 · review B S2-1] the probe waits twice as long after each failed trial, at most 15 minutes', async () => {
    const link = await import('../modules/kitchen/kitchen-link') as unknown as { probeWaitMs?: (s: { probeMs: number; probeMaxMs: number }, n: number) => number };
    const s = { probeMs: 60_000, probeMaxMs: 900_000 };
    expect([0, 1, 2, 3, 4, 5, 40].map((n) => link.probeWaitMs?.(s, n))).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  });

  it('[follow-up · N-6] a 504, then a 403, then a 403 again after a fresh login, on a WRITE: may have arrived', async () => {
    let inserts = 0;
    const c = client(async (url: string) => {
      if (url.endsWith('/login')) return { status: 200, text: async () => JSON.stringify({ token: 'fresh', status: 'Ok' }) };
      inserts += 1;
      return inserts === 1 ? { status: 504, text: async () => 'gateway timeout' } : { status: 403, text: async () => '{}' };
    });
    const err = await c.call('POST', '/PosInsertOrders', {}, false).catch((e: unknown) => e);
    expect(inserts).toBe(3);
    expect(err).toBeInstanceOf(KitchenTransientError);
    expect((err as KitchenTransientError).mayHaveLanded).toBe(true);
    // Without the earlier 5xx a 403 after a fresh login stays a plain refusal (a link failure).
    const plain = await client(async (url: string) => (url.endsWith('/login') ? { status: 200, text: async () => JSON.stringify({ token: 'x' }) } : { status: 403, text: async () => '{}' }))
      .call('POST', '/PosInsertOrders', {}, false).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(KitchenPermanentError);
  });
});

