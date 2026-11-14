import { describe, expect, it } from 'vitest';
import { DragontailClient, requestNeverSent, type FetchLike } from '../modules/kitchen/dragontail/dragontail-client';
import { KitchenPermanentError, KitchenTransientError } from '../modules/kitchen/kitchen-provider';
import { kitchenBreakerSettings } from '../modules/kitchen/kitchen-link';

// ---------------------------------------------------------------------------
// [DT-OUTAGE · owner 14 Nov 2026] Which send failures CERTAINLY never reached Dragontail (connect-phase only), and
// which MAY have (everything else: when in doubt it is "may have arrived", never a double cook).
// ---------------------------------------------------------------------------

/** Node's fetch failure shape: TypeError('fetch failed', { cause }) with the system error's code on the cause. */
const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('[DT-OUTAGE] requestNeverSent', () => {
  it('connect-phase failures: refused, no such host, no route, TLS handshake, undici connect timeout', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(requestNeverSent(fetchFailed(code), false), code).toBe(true);
    }
    // Every address refused (happy eyeballs): an AggregateError of connect failures.
    const all = Object.assign(new TypeError('fetch failed'), { cause: new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })]) });
    expect(requestNeverSent(all, false)).toBe(true);
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

  it('a login refused is a LINK failure; it is never "may have landed"', async () => {
    const c = new DragontailClient({ baseUrl: 'https://api.dragontailsystem.com', login: { userName: 'u', password: 'p' }, userLevel: -1, timeoutMs: 1_000, fetch: async () => ({ status: 400, text: async () => '{}' }), sleep: async () => {}, backoffMs: 1 });
    const err = await c.login().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KitchenPermanentError);
    expect((err as KitchenPermanentError).linkFailure).toBe(true);
  });

  it('breaker defaults: 3 in 2 minutes, a probe a minute; out-of-range settings ignored', () => {
    expect(kitchenBreakerSettings({})).toEqual({ failures: 3, windowMs: 120_000, probeMs: 60_000 });
    expect(kitchenBreakerSettings({ DRAGONTAIL_BREAKER_FAILURES: '5', DRAGONTAIL_BREAKER_WINDOW_SECONDS: '300', DRAGONTAIL_BREAKER_PROBE_SECONDS: '30' })).toEqual({ failures: 5, windowMs: 300_000, probeMs: 30_000 });
    expect(kitchenBreakerSettings({ DRAGONTAIL_BREAKER_FAILURES: '0', DRAGONTAIL_BREAKER_WINDOW_SECONDS: 'x' })).toEqual({ failures: 3, windowMs: 120_000, probeMs: 60_000 });
  });
});
