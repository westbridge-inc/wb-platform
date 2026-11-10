import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import {
  LOOKUP_TIMEOUT_MS,
  POWERTRANZ_SANDBOX_ROOT,
  PowerTranzCardRailProvider,
  PowerTranzConfigError,
  alphaOfCurrency,
  authenticationDecision,
  authenticationResultOf,
  minorOfTotalAmount,
  powerTranzConfigFromEnv,
  readCompletion,
  readAuthenticationReturn,
  readTransactionRecord,
  returnEvidence,
  totalAmountOf,
  voidDateOf,
  RECORD_ZONE,
  SELF_CHECK_PAGE_LINE,
  SELF_CHECK_PAGE_OPENS,
  VOID_DATE_SKEW_MS,
  hostedPageAnswer,
  redirectForm,
  type PowerTranzConfig,
} from '../providers/card/powertranz-provider';
import {
  STAGING_AMOUNT_MINOR, STAGING_CARD_SUFFIX, STAGING_ORDER, STAGING_READ_AT_MS, STAGING_RETURN_SECRETS, leaksCardSuffix, STAGING_SESSION_AT_MS, STAGING_TXN, STAGING_VOID_AT_MS,
  STAGING_VOID_DATE_TIME, STAGING_HPP_HTML, STAGING_VOID_TXN, stagingAuthenticatedRecord, stagingConductorNotFoundHtml, stagingPageNotFoundPost,
  stagingPreprocessedRecord, stagingReturnPost, stagingSaleRecord, stagingVoidRecord,
} from './fixtures/powertranz-staging-shapes';
import { CardBindingMismatchError, rawDigest } from '../providers/card/card-provider';
import { createHash, randomUUID } from 'node:crypto';
import { CARD_ON_FILE_CONSENT_SHA256, CARD_ON_FILE_CONSENT_TEXT, CARD_ON_FILE_CONSENT_VERSION, failureCodeOf } from '../modules/billing/card-rail.service';

// ---------------------------------------------------------------------------
// [PT-4] The real card provider against a fake gateway that answers in the
// shapes of PowerTranz's own guide v2.7 (sec. 6 response fields; sec. 7.2 HPP
// preprocessing; sec. 7.3 completion; sec. 7.5 refund; sec. 7.6 void;
// Appendix 1 codes). Every value is synthetic: no real card, no real
// credential, no real token. What is proved:
//   - requests carry exactly the guide's paths, headers and fields, and
//     never a card number [C1];
//   - the completion is the only money truth, sent at most once per page, and
//     only after the bank's 3-D Secure check passed (sec. 8);
//   - anything the guide does not document is unknown, never success;
//   - no off-session charge is ever sent (sec. 7.8): requires_action, no call;
//   - a refund or void is sent at most once per key.
// ---------------------------------------------------------------------------

const RUN = nanoid(8).replace(/[^A-Za-z0-9]/g, '0');
const PREFIX = `ptz:t${RUN}:`;
let redis: Redis;

const CONFIG: PowerTranzConfig = {
  account: `pt4-${RUN}`,
  environment: 'sandbox',
  apiRoot: POWERTRANZ_SANDBOX_ROOT,
  powerTranzId: 'TESTID01',
  password: 'test-password-not-real',
  pageSet: 'PTZ/SwiftTest',
  pageName: 'WeeklyFee',
  publicBaseUrl: 'https://api.example.test',
};

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
type Responder = (call: Call) => { status: number; body: unknown } | 'network' | 'timeout';

/** A fake gateway: records every call and answers with the scripted responder for its path. */
function gateway(routes: Record<string, Responder>) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
    const call: Call = {
      url: String(url), method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const path = new URL(call.url).pathname;
    const responder = routes[path];
    if (!responder) return new Response('not found', { status: 404 });
    const answer = responder(call);
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    // A 204 has no body at all (the real lookup of an unknown transaction).
    if (answer.status === 204) return new Response(null, { status: 204 });
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls, paths: () => calls.map((c) => new URL(c.url).pathname) };
}

/** sec. 7.2: the HPP preprocessing answer (SP4, RedirectData, SpiToken), echoing the request's identifiers. */
const preprocessed = (call: Call) => {
  const req = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
  return {
    status: 200,
    body: {
      TransactionType: 2, Approved: false, TransactionIdentifier: req['TransactionIdentifier'], IsoResponseCode: 'SP4',
      ResponseMessage: 'SPI Preprocessing complete', OrderIdentifier: req['OrderIdentifier'],
      RedirectData: '<html><body><form id="f" method="post" action="https://staging.ptranz.com/hpp"><input type="hidden" name="t" value="synthetic"></form><script>document.getElementById("f").submit()</script></body></html>',
      SpiToken: `spi-synthetic-${nanoid(10)}`,
    },
  };
};

/** sec. 7.3: the completion answer for the held page (its transaction and order), in the shape of PowerTranz's own
 *  "/Payment Response" sample (the HPP guides): NO RiskManagement — the real sandbox's approval had none either
 *  [CARD-STAGING-TEST B2]. It carries a PanToken, which Swift never keeps. */
const completion = (fields: Record<string, unknown>) => (page: { txnId: string; orderId: string }) => ({
  status: 200,
  body: {
    TransactionType: 2, Approved: true, AuthorizationCode: '123456', TransactionIdentifier: page.txnId, OrderIdentifier: page.orderId, TotalAmount: 2100, CurrencyCode: '328', RRN: '000000000001', CardBrand: 'Visa', IsoResponseCode: '00', ResponseMessage: 'Transaction is approved.',
    PanToken: 'synthetic-pan-token-never-kept',
    ...fields,
  },
});

function provider(gw: ReturnType<typeof gateway>, opts: { now?: () => Date; config?: Partial<PowerTranzConfig> } = {}) {
  return new PowerTranzCardRailProvider(redis, { ...CONFIG, ...opts.config }, { fetch: gw.fetch, keyPrefix: PREFIX, ...(opts.now ? { now: opts.now } : {}) });
}

const RETURN_URL = 'https://api.example.test/api/v1/billing/card/return?session=cs_synthetic&state=' + 'S'.repeat(43);

async function openPage(p: PowerTranzCardRailProvider, overrides: Partial<Parameters<PowerTranzCardRailProvider['createSession']>[0]> = {}) {
  const created = await p.createSession({
    binding: p.binding, sessionRef: `cs_${nanoid(10)}`, purpose: 'PAY_NOW', returnUrl: RETURN_URL,
    expiresAt: new Date(Date.now() + 15 * 60_000), amountMinor: 210_000, currencyCode: 'GYD', ...overrides,
  });
  expect(created.status).toBe('succeeded');
  if (created.status !== 'succeeded') throw new Error('unreachable');
  const held = await redis.hgetall(`${PREFIX}s:${created.providerSessionRef}`);
  return { ref: created.providerSessionRef, hostedUrl: created.hostedUrl, txnId: held['txnId']!, orderId: held['orderId']!, spiToken: held['spiToken']! };
}

/** What the iframe posts back (sec. 2.2 1.6, Appendix 2), flattened as the return route flattens it. */
function authResult(page: { txnId: string; orderId: string; spiToken: string }, tds: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    TransactionType: '2', Approved: 'false', TransactionIdentifier: page.txnId, IsoResponseCode: String(tds['ResponseCode'] ?? '3D0'),
    OrderIdentifier: page.orderId, SpiToken: page.spiToken,
    RiskManagement: JSON.stringify({ ThreeDSecure: { Eci: '05', AuthenticationStatus: 'Y', ResponseCode: '3D0', ...tds } }),
    ...extra,
  } as Record<string, string>;
}

beforeAll(() => {
  redis = new Redis(process.env['REDIS_URL']!);
});

afterAll(async () => {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
    cursor = next;
    const mine = keys.filter((k) => k.startsWith(PREFIX));
    if (mine.length) await redis.del(...mine);
  } while (cursor !== '0');
  await redis.quit();
});

describe('[CARDS] the completion claim: timestamped, durable, never sent twice', () => {
  it('an overlapping confirmation waits through the request deadline and margin, then treats a lost answer as voidable without resending', async () => {
    let clock = Date.now();
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw, { now: () => new Date(clock) });
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
    const k = `${PREFIX}s:${page.ref}`;
    // Model a different worker that durably claimed and is still awaiting its answer.
    await redis.hset(k, { completion: 'sending', completionClaimedAtMs: String(clock) });
    const confirm = () => p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' });
    expect(await confirm()).toMatchObject({ status: 'pending' });
    clock += 35_000;
    expect(await confirm()).toMatchObject({ status: 'pending' });
    clock += 1;
    expect(await confirm()).toMatchObject({ status: 'unknown', reason: 'COMPLETION_SENT_ANSWER_LOST', voidable: { providerRef: page.txnId } });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
  });

  it('the durable claim is asked immediately before the one completion; "send" sends it once', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const asked: string[] = [];
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => { asked.push('payment'); return completion({})(page); } });
    const p = provider(gw);
    page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
    const beforeCompletion = async (ref: string) => { asked.push(`claim:${ref}`); return 'send' as const; };
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion })).toMatchObject({ status: 'succeeded' });
    expect(asked).toEqual([`claim:${page.txnId}`, 'payment']);
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion })).toMatchObject({ status: 'succeeded' });
    expect(asked).toHaveLength(2);
  });

  it('"closed": the session closed first — the completion is never sent and nothing was taken (no void is asked for)', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
    const confirm = () => p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion: async () => 'closed' as const });
    const first = await confirm();
    expect(first).toMatchObject({ status: 'failed', reason: 'SESSION_CLOSED_BEFORE_COMPLETION' });
    expect(first).not.toHaveProperty('voidable');
    expect(await confirm()).toMatchObject({ status: 'failed', reason: 'SESSION_CLOSED_BEFORE_COMPLETION' });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
    expect(await redis.hget(`${PREFIX}s:${page.ref}`, 'spiToken')).toBeNull();
  });

  it('"claimed": a durable claim already exists (this store lost its own) — never sent again; the money is treated as possibly taken', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
    const confirm = () => p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion: async () => 'claimed' as const });
    expect(await confirm()).toMatchObject({ status: 'unknown', reason: 'COMPLETION_ALREADY_CLAIMED', voidable: { providerRef: page.txnId } });
    expect(await confirm()).toMatchObject({ status: 'unknown', reason: 'COMPLETION_ALREADY_CLAIMED', voidable: { providerRef: page.txnId } });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
  });

  it('[race audit] the durable claim waited on a lock past the SpiToken\'s five minutes: the completion is never sent late', async () => {
    let now = Date.now();
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true } }) });
    const p = provider(gw, { now: () => new Date(now) });
    const page = await openPage(p, { expiresAt: new Date(now + 15 * 60_000) });
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
    now += 4 * 60_000; // inside the five minutes when the provider store claims it
    const beforeCompletion = async () => { now += 2 * 60_000; return 'send' as const; }; // ...then the lock wait
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion }))
      .toMatchObject({ status: 'failed', reason: 'SPI_TOKEN_EXPIRED' });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion })).toMatchObject({ status: 'failed', reason: 'SPI_TOKEN_EXPIRED' });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
  });

  it('a recorded success without the provider\'s own proof (an older record) never restores booking authority: unknown, voidable', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    await redis.hset(`${PREFIX}s:${page.ref}`, { completion: 'done', result: JSON.stringify({ status: 'succeeded', amountMinor: 210_000, currencyCode: 'GYD', rawSha256: 'synthetic' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' }))
      .toMatchObject({ status: 'unknown', reason: 'COMPLETION_EVIDENCE_UNVERIFIED', voidable: { providerRef: page.txnId } });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
  });

  it('the durable claim cannot be taken (the database is down): nothing is sent, ever, for this page', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
    await expect(p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion: async () => { throw new Error('database unavailable'); } }))
      .rejects.toThrow('database unavailable');
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW', beforeCompletion: async () => 'send' as const }))
      .toMatchObject({ status: 'failed', reason: 'COMPLETION_CLAIM_FAILED' });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
    // Nothing was asked of the bank: never shown to the partner as a decline.
    expect(failureCodeOf('COMPLETION_CLAIM_FAILED')).toBe('COMPLETION_NOT_SENT');
    expect(failureCodeOf('SESSION_CLOSED_BEFORE_COMPLETION')).toBe('COMPLETION_NOT_SENT');
  });
});

describe('configuration (secrets named, never echoed)', () => {
  const base = {
    NODE_ENV: 'development',
    CARD_RAIL_ENVIRONMENT: 'sandbox', CARD_RAIL_ACCOUNT: 'swift-gy', POWERTRANZ_ID: 'TESTID01', POWERTRANZ_PASSWORD: 'p@ss-not-real',
    POWERTRANZ_PAGE_SET: 'PTZ/Swift', POWERTRANZ_PAGE_NAME: 'Weekly', API_PUBLIC_URL: 'https://api.example.test',
  };
  it('the sandbox defaults to the guide\'s staging root (sec. 2.1, 2.3)', () => {
    expect(powerTranzConfigFromEnv(base)).toMatchObject({ apiRoot: POWERTRANZ_SANDBOX_ROOT, environment: 'sandbox', pageSet: 'PTZ/Swift' });
  });
  it('live needs its own non-test root; production takes live only; every refusal names the setting, never a value', () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ ...base, NODE_ENV: 'production', CARD_RAIL_ENVIRONMENT: 'live' }, /POWERTRANZ_API_URL is required/],
      [{ ...base, NODE_ENV: 'production', CARD_RAIL_ENVIRONMENT: 'live', POWERTRANZ_API_URL: 'https://staging.ptranz.com' }, /test system/],
      [{ ...base, POWERTRANZ_API_URL: 'https://gateway.ptranz.com' }, /not a test system/],
      [{ ...base, POWERTRANZ_API_URL: 'https://staging.example.com' }, /ptranz\.com/],
      [{ ...base, CARD_RAIL_ENVIRONMENT: 'live', POWERTRANZ_API_URL: 'https://gateway.ptranz.com' }, /only on the production server/],
      [{ ...base, NODE_ENV: 'production' }, /live/],
      [{ ...base, POWERTRANZ_API_URL: 'http://staging.ptranz.com' }, /https/],
      [{ ...base, POWERTRANZ_API_URL: 'https://staging.ptranz.com/api' }, /bare https/],
      [{ ...base, POWERTRANZ_ID: '' }, /POWERTRANZ_ID/],
      [{ ...base, POWERTRANZ_ID: 'X'.repeat(26) }, /POWERTRANZ_ID/],
      [{ ...base, POWERTRANZ_PASSWORD: '' }, /POWERTRANZ_PASSWORD/],
      [{ ...base, POWERTRANZ_GATEWAY_KEY: 'not-a-guid' }, /POWERTRANZ_GATEWAY_KEY/],
      [{ ...base, POWERTRANZ_PAGE_SET: '' }, /POWERTRANZ_PAGE_SET/],
      // [CARD-STAGING-TEST 10 Nov 2026] PowerTranz's hosted page guide: a portal page set MUST be sent with "PTZ/"
      // (without it: 757 "Hosted page not found"). Never added for the owner: refused, naming the setting.
      [{ ...base, POWERTRANZ_PAGE_SET: 'SWIFT' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
      [{ ...base, POWERTRANZ_PAGE_SET: 'ptz/SWIFT' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
      [{ ...base, POWERTRANZ_PAGE_SET: 'PTZ/' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
      [{ ...base, POWERTRANZ_PAGE_SET: 'PTZ/ ' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
      [{ ...base, POWERTRANZ_PAGE_SET: ' PTZ/SWIFT' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
      [{ ...base, POWERTRANZ_PAGE_SET: 'SWIFT/PTZ/' }, /POWERTRANZ_PAGE_SET must start with PTZ\//],
      [{ ...base, API_PUBLIC_URL: 'http://api.example.test' }, /API_PUBLIC_URL/],
      [{ ...base, CARD_RAIL_ACCOUNT: 'has spaces' }, /CARD_RAIL_ACCOUNT/],
      [{ ...base, CARD_RAIL_ENVIRONMENT: undefined }, /CARD_RAIL_ENVIRONMENT/],
    ];
    for (const [env, message] of cases) {
      let thrown: unknown;
      try { powerTranzConfigFromEnv(env); } catch (err) { thrown = err; }
      expect(thrown, JSON.stringify(message)).toBeInstanceOf(PowerTranzConfigError);
      expect((thrown as Error).message).toMatch(message);
      expect((thrown as Error).message).not.toContain('p@ss-not-real');
    }
    expect(powerTranzConfigFromEnv({ ...base, NODE_ENV: 'production', CARD_RAIL_ENVIRONMENT: 'live', POWERTRANZ_API_URL: 'https://gateway.ptranz.com' }))
      .toMatchObject({ environment: 'live', apiRoot: 'https://gateway.ptranz.com' });
    expect(() => powerTranzConfigFromEnv({ ...base, NODE_ENV: 'production', CARD_RAIL_ENVIRONMENT: 'live', POWERTRANZ_API_URL: 'https://gateway.example.com' })).toThrow(/ptranz\.com/);
    // The set is sent exactly as written: PTZ/SWIFT stays PTZ/SWIFT.
    expect(powerTranzConfigFromEnv({ ...base, POWERTRANZ_PAGE_SET: 'PTZ/SWIFT' })).toMatchObject({ pageSet: 'PTZ/SWIFT' });
  });
});

// [CARDS-SWITCH-ON] PowerTranz's written answer to Swift (4 Nov 2026, item 4)
// gives production as https://gateway.ptranz.com/api/spi/ — its SPI address.
// Swift's API root is the bare origin of guide sec. 3 (paths carry /api/...),
// as on staging (https://staging.ptranz.com; the lookup at
// https://staging.ptranz.com/api/Transactions/{id}, item 2). So the production
// origin, or that exact SPI address, is accepted as the SAME bare root, and
// every call is derived from it exactly as on staging. Everything else stays
// refused: another path, a query, credentials, http, a host outside
// ptranz.com, a test system for live cards, live cards off production.
describe('[CARDS-SWITCH-ON] the production root: PowerTranz\'s production address, every path derived exactly as on staging', () => {
  const live = {
    NODE_ENV: 'production', CARD_RAIL_ENVIRONMENT: 'live', CARD_RAIL_ACCOUNT: 'swift-gy-live', POWERTRANZ_ID: 'LIVEID01', POWERTRANZ_PASSWORD: 'p@ss-not-real',
    POWERTRANZ_PAGE_SET: 'PTZ/Swift', POWERTRANZ_PAGE_NAME: 'Weekly', API_PUBLIC_URL: 'https://api.example.test',
  };
  const sandbox = { ...live, NODE_ENV: 'development', CARD_RAIL_ENVIRONMENT: 'sandbox', CARD_RAIL_ACCOUNT: 'swift-gy' };

  it('accepts the production origin and the SPI address PowerTranz wrote, as one bare root (staging by the same rule)', () => {
    for (const url of ['https://gateway.ptranz.com', 'https://gateway.ptranz.com/', 'https://gateway.ptranz.com/api/spi', 'https://gateway.ptranz.com/api/spi/', 'https://GATEWAY.ptranz.com/api/spi/']) {
      expect(powerTranzConfigFromEnv({ ...live, POWERTRANZ_API_URL: url }), url).toMatchObject({ environment: 'live', apiRoot: 'https://gateway.ptranz.com' });
    }
    for (const url of [undefined, '', 'https://staging.ptranz.com', 'https://staging.ptranz.com/api/spi/', 'https://staging.ptranz.com/api/spi']) {
      expect(powerTranzConfigFromEnv({ ...sandbox, POWERTRANZ_API_URL: url }), String(url)).toMatchObject({ environment: 'sandbox', apiRoot: POWERTRANZ_SANDBOX_ROOT });
    }
  });

  it('refuses any other path, a query, a fragment, credentials, http, another host, a test system for live cards, and live cards off production — naming the setting, never a value', () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      ...['/api', '/api/', '/spi', '/api/spi/sale', '/api/spi/payment', '/api/spix', '/api/spi//', '/api/Transactions/', '/api/refund', '/api/SPI/', '/x/api/spi/']
        .map((path): [Record<string, string | undefined>, RegExp] => [{ ...live, POWERTRANZ_API_URL: `https://gateway.ptranz.com${path}` }, /POWERTRANZ_API_URL must be/]),
      [{ ...live, POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/?x=1' }, /POWERTRANZ_API_URL must be/],
      [{ ...live, POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/#x' }, /POWERTRANZ_API_URL must be/],
      // An empty query or fragment reads as none to URL: still refused, by the text.
      [{ ...live, POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/?' }, /POWERTRANZ_API_URL must be/],
      [{ ...live, POWERTRANZ_API_URL: 'https://gateway.ptranz.com#' }, /POWERTRANZ_API_URL must be/],
      [{ ...live, POWERTRANZ_API_URL: 'https://user:pw@gateway.ptranz.com/api/spi/' }, /POWERTRANZ_API_URL must be/],
      [{ ...live, POWERTRANZ_API_URL: 'http://gateway.ptranz.com/api/spi/' }, /POWERTRANZ_API_URL must be/],
      [{ ...live, POWERTRANZ_API_URL: 'https://gateway.ptranz.com.example.test/api/spi/' }, /ptranz\.com/],
      [{ ...live, POWERTRANZ_API_URL: 'https://gatewayptranz.com/api/spi/' }, /ptranz\.com/],
      [{ ...live, POWERTRANZ_API_URL: 'https://staging.ptranz.com/api/spi/' }, /test system/],
      [{ ...live, POWERTRANZ_API_URL: undefined }, /POWERTRANZ_API_URL is required/],
      [{ ...live, NODE_ENV: 'development', POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/' }, /only on the production server/],
      [{ ...sandbox, POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/' }, /not a test system/],
    ];
    for (const [env, message] of cases) {
      let thrown: unknown;
      try { powerTranzConfigFromEnv(env); } catch (err) { thrown = err; }
      expect(thrown, String(env['POWERTRANZ_API_URL'])).toBeInstanceOf(PowerTranzConfigError);
      expect((thrown as Error).message, String(env['POWERTRANZ_API_URL'])).toMatch(message);
      expect((thrown as Error).message).not.toContain('p@ss-not-real');
      expect((thrown as Error).message).not.toContain('user:pw');
    }
  });

  it('every call — page, completion, refund, void, lookup, self-check — goes to <root>/api/... on production exactly as on staging', async () => {
    const seen: Record<string, string[]> = {};
    const original = randomUUID(); // one original transaction for both roots (each provider has its own account)
    for (const [root, env] of [
      ['https://gateway.ptranz.com', { ...live, POWERTRANZ_API_URL: 'https://gateway.ptranz.com/api/spi/' }],
      [POWERTRANZ_SANDBOX_ROOT, sandbox],
    ] as const) {
      const config = powerTranzConfigFromEnv(env);
      expect(config.apiRoot).toBe(root);
      let page!: Awaited<ReturnType<typeof openPage>>;
      const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({})(page) });
      const p = new PowerTranzCardRailProvider(redis, { ...config, account: `root-${nanoid(6).replace(/[^A-Za-z0-9]/g, '0')}` }, { fetch: gw.fetch, keyPrefix: PREFIX });
      page = await openPage(p);
      await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
      expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'succeeded' });
      await p.refund({ binding: p.binding, providerRef: original, amountMinor: 210_000, currencyCode: 'GYD', idempotencyKey: `refund-${nanoid(6)}` });
      await p.voidPayment({ binding: p.binding, providerRef: original, idempotencyKey: `void-${nanoid(6)}` });
      await p.lookupTransaction({ binding: p.binding, providerRef: original, orderRef: page.orderId, amountMinor: 210_000, currencyCode: 'GYD' });
      await p.selfCheck({ preprocess: false, returnUrl: RETURN_URL });
      expect(gw.calls.every((c) => c.url.startsWith(`${root}/api/`)), JSON.stringify(gw.calls.map((c) => c.url))).toBe(true);
      expect(gw.calls.map((c) => c.url)).toEqual([
        `${root}/api/spi/sale`, `${root}/api/spi/payment`, `${root}/api/refund`, `${root}/api/void`,
        `${root}/api/Transactions/${original}`, `${root}/api/alive`, `${root}/api/spi/riskmgmt`,
      ]);
      seen[root] = gw.calls.map((c) => new URL(c.url).pathname);
    }
    // The same paths on both: only the origin differs.
    expect(seen['https://gateway.ptranz.com']).toEqual(seen[POWERTRANZ_SANDBOX_ROOT]);
  });
});

describe('amounts and currencies (sec. 5.1 DEC 18,3; ISO 4217 numeric)', () => {
  it('minor units <-> TotalAmount, exactly, and nothing finer than the currency allows', () => {
    expect(totalAmountOf(210_000, 'GYD')).toBe(2100);
    expect(totalAmountOf(210_005, 'GYD')).toBe(2100.05);
    expect(minorOfTotalAmount(2100, 'GYD')).toBe(210_000);
    expect(minorOfTotalAmount('2100.050', 'GYD')).toBe(210_005);
    expect(minorOfTotalAmount('2100.005', 'GYD')).toBeNull();
    expect(minorOfTotalAmount(-1, 'GYD')).toBeNull();
    expect(minorOfTotalAmount('1e3', 'GYD')).toBeNull();
    expect(alphaOfCurrency('328')).toBe('GYD');
    expect(alphaOfCurrency(840)).toBe('USD');
    expect(alphaOfCurrency('978')).toBeNull();
  });
});

describe('createSession: the hosted payment page, preprocessed (sec. 2.2 1.3-1.4, 5.1, 7.2)', () => {
  it('POST <root>/api/spi/sale with the guide\'s headers and fields — 3-D Secure on, the hosted page named, NO card data', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    expect(page.hostedUrl).toBe(`https://api.example.test/api/v1/billing/card/pay/${page.ref}`);
    expect(gw.calls).toHaveLength(1);
    const call = gw.calls[0]!;
    expect(call.url).toBe('https://staging.ptranz.com/api/spi/sale');
    expect(call.method).toBe('POST');
    expect(call.headers['powertranz-powertranzid']).toBe('TESTID01');
    expect(call.headers['powertranz-powertranzpassword']).toBe('test-password-not-real');
    expect(call.headers).not.toHaveProperty('powertranz-gatewaykey'); // "Do not send until value is provided" (sec. 4)
    const body = JSON.parse(call.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      TotalAmount: 2100, CurrencyCode: '328', ThreeDSecure: true, Source: {}, OrderIdentifier: expect.stringMatching(/^SWIFT-cs_/),
      ExtendedData: { ThreeDSecure: { ChallengeWindowSize: 5, ChallengeIndicator: '01' }, MerchantResponseUrl: RETURN_URL, HostedPage: { PageSet: 'PTZ/SwiftTest', PageName: 'WeeklyFee' } },
    });
    expect(body['TransactionIdentifier']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/CardPan|CardCvv|CardExpiration|\d{13,19}/);
  });

  it('sends PowerTranz-GatewayKey only once one is configured', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const issued = randomUUID(); // a synthetic GUID, made at run time
    await openPage(provider(gw, { config: { gatewayKey: issued } }));
    expect(gw.calls[0]!.headers['powertranz-gatewaykey']).toBe(issued);
  });

  it('anything but SP4 with RedirectData and SpiToken is no page — definitively (no money can follow, sec. 7.3)', async () => {
    const answers: Responder[] = [
      () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', ResponseMessage: 'Invalid transaction', Errors: [{ Code: '757', Message: 'Hosted page not found' }] } }),
      () => ({ status: 200, body: { IsoResponseCode: 'SP4', SpiToken: 'x' } }),
      () => ({ status: 200, body: { IsoResponseCode: 'SP4', RedirectData: '<form></form>' } }),
      (call) => ({ ...preprocessed(call), body: { ...(preprocessed(call).body), TransactionIdentifier: '00000000-0000-0000-0000-000000000000' } }),
      () => ({ status: 500, body: 'server error' }),
      () => 'network',
      () => 'timeout',
    ];
    for (const answer of answers) {
      const p = provider(gateway({ '/api/spi/sale': answer }));
      const created = await p.createSession({ binding: p.binding, sessionRef: 'cs_x', purpose: 'PAY_NOW', returnUrl: RETURN_URL, expiresAt: new Date(Date.now() + 60_000), amountMinor: 100, currencyCode: 'GYD' });
      expect(created.status).toBe('failed');
    }
  });

  it('no page, no call: an Add card session (the guide documents no saved-card charge), an unknown currency, a bad amount, a return address over 255', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const ask = (o: Record<string, unknown>) => p.createSession({ binding: p.binding, sessionRef: 'cs_y', purpose: 'PAY_NOW', returnUrl: RETURN_URL, expiresAt: new Date(Date.now() + 60_000), amountMinor: 100, currencyCode: 'GYD', ...o });
    expect(await ask({ purpose: 'ENROLL', amountMinor: undefined, currencyCode: undefined })).toMatchObject({ status: 'failed', reason: 'SAVING_CARDS_NOT_OFFERED' });
    expect(await ask({ currencyCode: 'EUR' })).toMatchObject({ status: 'failed' });
    expect(await ask({ amountMinor: 0 })).toMatchObject({ status: 'failed' });
    expect(await ask({ returnUrl: `https://api.example.test/${'x'.repeat(260)}` })).toMatchObject({ status: 'failed', reason: 'RETURN_URL_INVALID' });
    expect(gw.calls).toHaveLength(0);
    expect(p.savesCards).toBe(false);
  });

  it('[review S4] a page Swift could not keep (its store failed after SP4) is definitively no page: failed — its SpiToken is gone, so no completion can ever be sent (sec. 7.3)', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const broken = new Proxy(redis, {
      get(target, key) {
        if (key === 'hset') return async () => { throw new Error('store unavailable'); };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const p = new PowerTranzCardRailProvider(broken, CONFIG, { fetch: gw.fetch, keyPrefix: PREFIX });
    const created = await p.createSession({
      binding: p.binding, sessionRef: `cs_${nanoid(10)}`, purpose: 'PAY_NOW', returnUrl: RETURN_URL,
      expiresAt: new Date(Date.now() + 15 * 60_000), amountMinor: 210_000, currencyCode: 'GYD',
    });
    expect(created).toMatchObject({ status: 'failed', reason: 'PAGE_NOT_KEPT' });
    expect(gw.paths()).toEqual(['/api/spi/sale']);
  });

  it('a binding that is not its own is refused before any call [C2]', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    await expect(p.createSession({ binding: { ...p.binding, account: 'other' }, sessionRef: 'cs', purpose: 'PAY_NOW', returnUrl: RETURN_URL, expiresAt: new Date(), amountMinor: 1, currencyCode: 'GYD' }))
      .rejects.toBeInstanceOf(CardBindingMismatchError);
    await expect(p.confirm({ binding: { ...p.binding, environment: 'live' }, providerSessionRef: 'ptz_x', purpose: 'PAY_NOW' })).rejects.toBeInstanceOf(CardBindingMismatchError);
    expect(gw.calls).toHaveLength(0);
  });
});

describe('the browser\'s 3-D Secure result decides only whether Swift completes (sec. 2.2 1.6-1.7, 8)', () => {
  const held = { spiToken: 'spi-1', txnId: '11111111-1111-1111-1111-111111111111', orderId: 'SWIFT-cs_1' };
  const result = (tds: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ SpiToken: 'spi-1', TransactionIdentifier: held.txnId, OrderIdentifier: held.orderId, IsoResponseCode: '3D0', RiskManagement: { ThreeDSecure: { ResponseCode: '3D0', ...tds } }, ...extra });
  it('proceeds on 3D0 with Y or A; declines N, R, U, 3D1, 3D3, a missing result, and a result naming another page', () => {
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }), held).proceed).toBe(true);
    expect(authenticationDecision(result({ AuthenticationStatus: 'A' }), held).proceed).toBe(true);
    for (const status of ['N', 'R', 'U', undefined]) expect(authenticationDecision(result({ AuthenticationStatus: status }), held).proceed, String(status)).toBe(false);
    expect(authenticationDecision(result({ ResponseCode: '3D1', AuthenticationStatus: undefined }, { IsoResponseCode: '3D1' }), held).proceed).toBe(false);
    expect(authenticationDecision(result({ ResponseCode: '3D3', AuthenticationStatus: 'Y' }), held).proceed).toBe(false);
    expect(authenticationDecision(null, held).proceed).toBe(false);
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }, { SpiToken: 'spi-OTHER' }), held)).toEqual({ proceed: false, note: 'OTHER_PAGE_TOKEN' });
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }, { TransactionIdentifier: '22222222-2222-2222-2222-222222222222' }), held).proceed).toBe(false);
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }, { OrderIdentifier: 'SWIFT-cs_2' }), held).proceed).toBe(false);
  });
  it('reads the result from top-level fields (nested objects as JSON text) or from one field holding the JSON', () => {
    const flat = { IsoResponseCode: '3D0', SpiToken: 'spi-1', RiskManagement: JSON.stringify({ ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'Y' } }) };
    expect(authenticationDecision(authenticationResultOf(flat), held).proceed).toBe(true);
    const wrapped = { Response: JSON.stringify(result({ AuthenticationStatus: 'Y' })) };
    expect(authenticationDecision(authenticationResultOf(wrapped), held).proceed).toBe(true);
    expect(authenticationResultOf({ hello: 'world' })).toBeNull();
    expect(authenticationResultOf({ a: JSON.stringify({ SpiToken: 'x' }), b: JSON.stringify({ SpiToken: 'y' }) })).toBeNull();
  });
  it('parseReturn is an observation: pure, and its digest never holds the token or the cardholder\'s details in the clear', () => {
    const p = provider(gateway({}));
    const params = { IsoResponseCode: '3D0', SpiToken: 'spi-secret-token', BillingAddress: JSON.stringify({ EmailAddress: 'someone@example.test' }), RiskManagement: JSON.stringify({ ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'Y' } }) };
    const observed = p.parseReturn(params);
    expect(observed.claimedStatus).toBe('pending');
    expect(observed.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.parseReturn({ nothing: 'here' }).claimedStatus).toBe('invalid');
  });
});

describe('confirm: the completion is the money truth, sent at most once (sec. 2.2 1.7-1.8, 7.3)', () => {
  it('pending until the browser comes back; then ONE POST /api/spi/payment with the SpiToken as the body, no credential headers; approved 00 -> succeeded', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({})(page) });
    const p = provider(gw);
    page = await openPage(p);
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'pending' });
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    const outcome = await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' });
    expect(outcome).toMatchObject({ status: 'succeeded', purpose: 'PAY_NOW', providerRef: page.txnId, amountMinor: 210_000, currencyCode: 'GYD' });
    const pay = gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'));
    expect(pay).toHaveLength(1);
    expect(pay[0]!.body).toBe(JSON.stringify(page.spiToken));
    expect(pay[0]!.headers).not.toHaveProperty('powertranz-powertranzid');
    expect(pay[0]!.headers).not.toHaveProperty('powertranz-powertranzpassword');
    // Asked again (a reload, the sweep): the recorded answer, never a second completion.
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'succeeded', providerRef: page.txnId });
    expect(gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'))).toHaveLength(1);
    // The token and the bank's form are gone from Swift once the page is done.
    expect(await redis.hmget(`${PREFIX}s:${page.ref}`, 'spiToken', 'redirectData')).toEqual([null, null]);
  });

  it('a failed bank check (N) is never completed: failed, nothing sent', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'N' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^NOT_AUTHENTICATED/) });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('a return naming another page (its SpiToken) is never completed', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult({ ...page, spiToken: 'spi-forged' }, { AuthenticationStatus: 'Y' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed' });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('the first return\'s decision stands: a later "Y" cannot turn a refused page into a completion', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'R' }) });
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed' });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('a page never finished: pending inside its window, failed after it, nothing sent', async () => {
    let now = Date.now();
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw, { now: () => new Date(now) });
    const page = await openPage(p, { expiresAt: new Date(now + 60_000) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'pending' });
    now += 61_000;
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed', reason: 'PAGE_NOT_FINISHED' });
    // The browser arrives late: the page's fate is already decided.
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed' });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('the completion\'s answer lost (network, timeout, 5xx, unreadable): unknown AND voidable under this transaction, and NEVER sent a second time', async () => {
    for (const lost of [(): ReturnType<Responder> => 'network', (): ReturnType<Responder> => 'timeout', (): ReturnType<Responder> => ({ status: 503, body: 'down' }), (): ReturnType<Responder> => ({ status: 200, body: '<html>oops' })]) {
      const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': lost });
      const p = provider(gw);
      const page = await openPage(p);
      await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
      expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'unknown', voidable: { providerRef: page.txnId } });
      expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'unknown', voidable: { providerRef: page.txnId } });
      expect(gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'))).toHaveLength(1);
    }
  });

  it('[CARD-STAGING-TEST B2 · OWNER RULING 10 Nov 2026] PowerTranz\'s own approval of the completion, with NO 3-D Secure block (as its sample and the real sandbox answer it), is booked — it was voided before', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({ RiskManagement: undefined })(page) });
    const p = provider(gw);
    page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    const outcome = await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' });
    expect(outcome).toMatchObject({ status: 'succeeded', providerRef: page.txnId, amountMinor: 210_000, currencyCode: 'GYD' });
    expect(outcome).not.toHaveProperty('voidable');
  });

  it('[review S2-2] an approval whose OWN 3-D Secure block says the cardholder was not authenticated contradicts itself: voidable, never succeeded', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({ RiskManagement: { ThreeDSecure: { Eci: '07', AuthenticationStatus: 'N' } } })(page) });
    const p = provider(gw);
    page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' }))
      .toMatchObject({ status: 'unknown', reason: 'APPROVED_UNAUTHENTICATED_SERVER_3DS_N', voidable: { providerRef: page.txnId } });
  });

  it('[OWNER RULING 10 Nov 2026] the Sale is always sent with ThreeDSecure true, and a page whose record does not say so is never completed: failed, nothing sent', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({})(page) });
    const p = provider(gw);
    page = await openPage(p);
    expect(JSON.parse(gw.calls[0]!.body ?? '{}')).toMatchObject({ ThreeDSecure: true });
    const k = `${PREFIX}s:${page.ref}`;
    expect(await redis.hget(k, 'threeDSecure')).toBe('true');
    for (const marker of [null, 'false']) {
      const other = await openPage(p);
      const key = `${PREFIX}s:${other.ref}`;
      if (marker === null) await redis.hdel(key, 'threeDSecure'); else await redis.hset(key, 'threeDSecure', marker);
      await p.noteReturn({ binding: p.binding, providerSessionRef: other.ref, params: authResult(other, { AuthenticationStatus: 'Y' }) });
      expect(await p.confirm({ binding: p.binding, providerSessionRef: other.ref, purpose: 'PAY_NOW' }), String(marker))
        .toMatchObject({ status: 'failed', reason: 'NOT_AUTHENTICATED:SALE_NOT_3DS' });
    }
    expect(gw.paths()).not.toContain('/api/spi/payment');
    expect(failureCodeOf('NOT_AUTHENTICATED:SALE_NOT_3DS')).toBe('NOT_AUTHENTICATED');
  });

  it('[review S4] the completion is never sent after the SpiToken\'s five minutes (sec. 2.2 1.7): failed, nothing sent', async () => {
    let now = Date.now();
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true } }) });
    const p = provider(gw, { now: () => new Date(now) });
    const page = await openPage(p, { expiresAt: new Date(now + 15 * 60_000) });
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    now += 5 * 60_000 + 1_000;
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed', reason: 'SPI_TOKEN_EXPIRED' });
    expect(gw.paths()).not.toContain('/api/spi/payment');
    // Nothing was asked of the bank: never shown to the partner as a decline.
    expect(failureCodeOf('SPI_TOKEN_EXPIRED')).toBe('COMPLETION_EXPIRED');
  });

  it('two confirmations racing: exactly one completion is sent', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({})(page) });
    const p = provider(gw);
    page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    const answers = await Promise.all(Array.from({ length: 5 }, () => p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })));
    expect(gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'))).toHaveLength(1);
    // [CARDS S2] A racer that finds the completion still being sent waits (pending): it never reads
    // an ACTIVE completion as a lost answer, which the service would void.
    expect(answers.filter((a) => a.status === 'succeeded').length + answers.filter((a) => a.status === 'pending').length).toBe(5);
    expect(answers.filter((a) => a.status === 'unknown')).toEqual([]);
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'succeeded' });
  });

  it('no record of the page (lost state): unknown, never success', async () => {
    const p = provider(gateway({}));
    expect(await p.confirm({ binding: p.binding, providerSessionRef: 'ptz_000000000000000000000000', purpose: 'PAY_NOW' })).toMatchObject({ status: 'unknown' });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: 'ptz_000000000000000000000000', purpose: 'ENROLL' })).toMatchObject({ status: 'failed' });
  });
});

describe('reading the completion (sec. 6, Appendix 1): booked only on PowerTranz\'s own approval; money that may have moved is voided, never booked', () => {
  const held = { txnId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', orderId: 'SWIFT-cs_1', amountMinor: 210_000, currencyCode: 'GYD' };
  /** PowerTranz's own "/Payment Response" sample (the HPP guides), for this page: no RiskManagement. */
  const approved = {
    TransactionType: 2, Approved: true, AuthorizationCode: '123456', TransactionIdentifier: held.txnId, TotalAmount: 2100, CurrencyCode: '328',
    RRN: '307522590956', CardBrand: 'Visa', IsoResponseCode: '00', ResponseMessage: 'Transaction is approved', PanToken: 'synthetic-pan-token-never-kept',
    OrderIdentifier: held.orderId,
  };
  const unbookable = (json: unknown) => readCompletion(json, held).status;
  it('[OWNER RULING 10 Nov 2026] approved 00, this Sale, this order, this amount: succeeded — the stored proof is the approval itself (no token, nothing personal, no 3-D Secure field required)', () => {
    const reading = readCompletion(approved, held);
    expect(reading).toEqual({ status: 'succeeded', amountMinor: 210_000, currencyCode: 'GYD', completionEvidence: {
      Approved: true, IsoResponseCode: '00', TransactionType: 2, TransactionIdentifier: held.txnId, OrderIdentifier: held.orderId, TotalAmount: 2100, CurrencyCode: '328', CardBrand: 'Visa',
    } });
    expect(JSON.stringify(reading)).not.toMatch(/synthetic-pan-token|307522590956|123456/);
    expect(readCompletion({ ...approved, TransactionIdentifier: undefined, OriginalTrxnIdentifier: held.txnId }, held).status).toBe('succeeded');
    expect(readCompletion({ ...approved, TransactionType: '2' }, held).status).toBe('succeeded');
    // The stored approval re-reads as the same approval (outcomeOf, the lookup and finance's BOOK re-check it).
    if (reading.status !== 'succeeded') throw new Error('unreachable');
    expect(readCompletion(reading.completionEvidence, held)).toEqual(reading);
    // Evidence stored before the ruling (with the 3-D Secure fields then required) still reads as an approval.
    expect(readCompletion({ ...reading.completionEvidence, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y', Eci: '05' } } }, held).status).toBe('succeeded');
  });
  it('[3DS] a 3-D Secure block on PowerTranz\'s OWN answer is not required — but one that says the cardholder was NOT authenticated (N / U / R, a failed ECI, an unreadable block) contradicts the approval: voided', () => {
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'A', Eci: '06' } } }, held).status).toBe('succeeded');
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y', Eci: '05' } } }, held).status).toBe('succeeded');
    for (const absent of [undefined, null, {}, { ThreeDSecure: null }, { ThreeDSecure: {} }]) {
      expect(readCompletion({ ...approved, RiskManagement: absent }, held).status, JSON.stringify(absent)).toBe('succeeded');
    }
    for (const tds of [{ AuthenticationStatus: 'N' }, { AuthenticationStatus: 'U' }, { AuthenticationStatus: 'R' }, { AuthenticationStatus: '' }, { AuthenticationStatus: 'Y', Eci: '07' }, { AuthenticationStatus: 'Y', Eci: '00' }]) {
      expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: tds } }, held), JSON.stringify(tds)).toMatchObject({ status: 'unbookable', reason: expect.stringMatching(/^APPROVED_UNAUTHENTICATED_/) });
    }
    // [REVIEW-2466-A F1] Its own ResponseCode counts too: 3D1 (not available), 3D3 (an error) or any code but 3D0, even
    // with no status or ECI beside it, says no authentication took place.
    for (const [tds, reason] of [
      [{ ResponseCode: '3D1' }, 'APPROVED_UNAUTHENTICATED_SERVER_3DS_3D1'],
      [{ ResponseCode: '3D3' }, 'APPROVED_UNAUTHENTICATED_SERVER_3DS_3D3'],
      [{ ResponseCode: '3D6', AuthenticationStatus: 'Y', Eci: '05' }, 'APPROVED_UNAUTHENTICATED_SERVER_3DS_3D6'],
      [{ ResponseCode: '' }, 'APPROVED_UNAUTHENTICATED_SERVER_3DS_UNREADABLE'],
    ] as const) {
      expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: tds } }, held), JSON.stringify(tds)).toMatchObject({ status: 'unbookable', reason });
    }
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'Y', Eci: '05' } } }, held).status).toBe('succeeded');
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { ResponseCode: '3D0' } } }, held).status).toBe('succeeded');
    for (const rm of ['Y', 7, { ThreeDSecure: 'Y' }]) {
      expect(readCompletion({ ...approved, RiskManagement: rm }, held), JSON.stringify(rm)).toMatchObject({ status: 'unbookable', reason: 'APPROVED_UNAUTHENTICATED_SERVER_3DS_UNREADABLE' });
    }
  });
  it('[Opus S4-c · sec. 8.4, 5] an ECI the answer DOES carry is an ALLOW-list: only a success or attempt value (Visa/Amex 05, 06; Mastercard 02, 01) agrees with the approval; a Y or A without an ECI contradicts nothing', () => {
    const tds = (fields: Record<string, unknown>, brand?: string) => ({ ...approved, CardBrand: brand, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y', ...fields } } });
    // No brand in the answer: the documented success and attempt values of every brand (they do not collide).
    for (const eci of ['05', '06', '02', '01']) expect(readCompletion(tds({ Eci: eci }), held).status, eci).toBe('succeeded');
    expect(readCompletion({ ...tds({ Eci: '01' }), RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'A', Eci: '01' } } }, held).status).toBe('succeeded');
    // No ECI at all contradicts nothing (OWNER RULING 10 Nov 2026: the approval is the proof).
    for (const fields of [{}, { Eci: null }]) expect(readCompletion(tds(fields), held).status, JSON.stringify(fields)).toBe('succeeded');
    // Failed or not 3-D Secure (07, 00), a non-payment authentication (N2, N0), anything undocumented or unreadable: voided or held.
    for (const fields of [{ Eci: '' }, { Eci: '07' }, { Eci: '00' }, { Eci: 'N2' }, { Eci: 'N0' }, { Eci: '03' }, { Eci: '99' }, { Eci: 'Y' }, { Eci: 2.5 }]) {
      expect(readCompletion(tds(fields), held), JSON.stringify(fields)).toMatchObject({ status: 'unbookable', reason: expect.stringMatching(/^APPROVED_UNAUTHENTICATED_SERVER_ECI_/) });
    }
    // The answer names the brand: only that brand's own values count.
    expect(readCompletion(tds({ Eci: '05' }, 'Visa'), held).status).toBe('succeeded');
    expect(readCompletion(tds({ Eci: '06' }, 'American Express'), held).status).toBe('succeeded');
    expect(readCompletion(tds({ Eci: '02' }, 'MasterCard'), held).status).toBe('succeeded');
    expect(readCompletion(tds({ Eci: '01' }, 'Mastercard'), held).status).toBe('succeeded');
    expect(readCompletion(tds({ Eci: '02' }, 'Visa'), held).status).toBe('unbookable');
    expect(readCompletion(tds({ Eci: '05' }, 'Mastercard'), held).status).toBe('unbookable');
    expect(readCompletion(tds({ Eci: '01' }, 'AMEX'), held).status).toBe('unbookable');
    // An unrecognised brand name falls back to the every-brand values, never to "anything".
    expect(readCompletion(tds({ Eci: '05' }, 'Discover'), held).status).toBe('succeeded');
    expect(readCompletion(tds({ Eci: '07' }, 'Discover'), held).status).toBe('unbookable');
    // The stored proof is the approval: it never carries the 3-D Secure block, only the brand that judged it.
    const ok = readCompletion(tds({ Eci: 2 }, 'Mastercard'), held);
    expect(ok).toMatchObject({ status: 'succeeded', completionEvidence: { CardBrand: 'Mastercard' } });
    expect(ok.status === 'succeeded' && ok.completionEvidence).not.toHaveProperty('RiskManagement');
  });
  it('[review S4] a numeric ECI is read like its text: 5 is authenticated, 7 is not', () => {
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y', Eci: 5 } } }, held).status).toBe('succeeded');
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y', Eci: 7 } } }, held).status).toBe('unbookable');
  });
  it('[review S3] an approval must NAME this page: its transaction (absent is not enough), its order, a Sale — else voided', () => {
    expect(readCompletion({ ...approved, TransactionIdentifier: undefined }, held)).toMatchObject({ status: 'unbookable', reason: 'APPROVAL_DOES_NOT_NAME_THIS_TRANSACTION' });
    expect(unbookable({ ...approved, TransactionIdentifier: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).toBe('unbookable');
    expect(readCompletion({ ...approved, OrderIdentifier: undefined }, held)).toMatchObject({ status: 'unbookable', reason: 'APPROVAL_DOES_NOT_NAME_THIS_ORDER' });
    expect(unbookable({ ...approved, OrderIdentifier: 'SWIFT-cs_2' })).toBe('unbookable');
    expect(readCompletion({ ...approved, TransactionType: 1 }, held)).toMatchObject({ status: 'unbookable', reason: 'APPROVAL_IS_NOT_A_SALE' });
    expect(unbookable({ ...approved, TransactionType: undefined })).toBe('unbookable');
  });
  it('approved with any other code, another amount or currency, an unreadable amount, a truthy lookalike: voided', () => {
    for (const iso of ['10', '11', '16', '32', '', undefined]) expect(unbookable({ ...approved, IsoResponseCode: iso }), String(iso)).toBe('unbookable');
    expect(readCompletion({ ...approved, TotalAmount: 2000 }, held)).toMatchObject({ status: 'unbookable', reason: 'APPROVED_AMOUNT_MISMATCH' });
    expect(unbookable({ ...approved, CurrencyCode: '840' })).toBe('unbookable');
    expect(unbookable({ ...approved, CurrencyCode: '978' })).toBe('unbookable');
    expect(unbookable({ ...approved, TotalAmount: 'lots' })).toBe('unbookable');
    expect(unbookable({ ...approved, Approved: 'true' })).toBe('unbookable');
    expect(unbookable(null)).toBe('unbookable');
  });
  it('declined by the bank: failed; a contradiction (declined with 00), a possible duplicate (787, 788, 387) or a code that is not the bank\'s answer (09, 68, 91, 94, 96, 98, 99, 06): voided', () => {
    for (const iso of ['05', '51', '54', '57', '12', '14', '82', 'N7', '97', '89']) {
      expect(readCompletion({ Approved: false, IsoResponseCode: iso }, held).status, iso).toBe('failed');
    }
    expect(readCompletion({ Approved: false, IsoResponseCode: '00' }, held)).toMatchObject({ status: 'unbookable', reason: 'DECLINED_WITH_APPROVAL_CODE' });
    for (const code of ['787', '788', '387']) {
      expect(unbookable({ Approved: false, IsoResponseCode: '12', Errors: [{ Code: code, Message: 'Duplicate' }] }), code).toBe('unbookable');
    }
    for (const iso of ['09', '68', '91', '94', '96', '98', '99', '06']) {
      expect(unbookable({ Approved: false, IsoResponseCode: iso }), iso).toBe('unbookable');
    }
  });
});

describe('off-session: never attempted (sec. 7.8)', () => {
  it('chargeInstrument answers requires_action (no penalty) and retrieve answers absent — with no call at all', async () => {
    const gw = gateway({});
    const p = provider(gw);
    expect(await p.chargeInstrument({ binding: p.binding, vaultToken: 'tok', amountMinor: 1, currencyCode: 'GYD', idempotencyKey: 'k' })).toMatchObject({ status: 'requires_action' });
    expect(await p.retrieve({ binding: p.binding, idempotencyKey: 'k' })).toMatchObject({ status: 'unknown', absent: true });
    expect(gw.calls).toHaveLength(0);
  });
});

describe('refund and void (sec. 5.2, 7.5, 7.6): the original transaction, at most one call per key', () => {
  const original = 'cab173a7-f75e-444b-ac42-cc6a367b8b6b';
  it('refund: POST <root>/api/refund {Refund true, original TransactionIdentifier, TotalAmount, CurrencyCode}; approved 00 -> succeeded; the same key again is the recorded answer', async () => {
    const gw = gateway({ '/api/refund': () => ({ status: 200, body: { OriginalTrxnIdentifier: original, TransactionType: 5, Approved: true, TransactionIdentifier: '0446a902-311d-4868-8247-e9dfbd8ea0a6', TotalAmount: 2100, CurrencyCode: '328', IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const key = `refund-${nanoid(6)}`;
    const first = await p.refund({ binding: p.binding, providerRef: original, amountMinor: 210_000, currencyCode: 'GYD', idempotencyKey: key });
    expect(first).toMatchObject({ status: 'succeeded', providerRef: '0446a902-311d-4868-8247-e9dfbd8ea0a6' });
    expect(JSON.parse(gw.calls[0]!.body!)).toEqual({ Refund: true, TransactionIdentifier: original, TotalAmount: 2100, CurrencyCode: '328' });
    expect(gw.calls[0]!.headers['powertranz-powertranzid']).toBe('TESTID01');
    expect(await p.refund({ binding: p.binding, providerRef: original, amountMinor: 210_000, currencyCode: 'GYD', idempotencyKey: key })).toEqual(first);
    expect(gw.calls).toHaveLength(1);
  });
  it('a refund whose answer was lost is unknown and is never sent again under its key; a refused one is failed', async () => {
    const lost = gateway({ '/api/refund': () => 'timeout' });
    const p = provider(lost);
    const key = `refund-${nanoid(6)}`;
    expect((await p.refund({ binding: p.binding, providerRef: original, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: key })).status).toBe('unknown');
    expect((await p.refund({ binding: p.binding, providerRef: original, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: key })).status).toBe('unknown');
    expect(lost.calls).toHaveLength(1);
    const refused = gateway({ '/api/refund': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', Errors: [{ Code: '384', Message: 'Invalid refund' }] } }) });
    const q = provider(refused);
    expect(await q.refund({ binding: q.binding, providerRef: original, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: `refund-${nanoid(6)}` })).toMatchObject({ status: 'failed' });
    expect(await q.refund({ binding: q.binding, providerRef: 'not-a-guid', amountMinor: 100, currencyCode: 'GYD', idempotencyKey: `refund-${nanoid(6)}` })).toMatchObject({ status: 'failed', reason: 'REFUND_REQUEST_INVALID' });
    expect(refused.calls).toHaveLength(1);
  });
  it('[review S2-2] a void or refund counts only when its answer is about THIS transaction (sec. 6, 7.5, 7.6): named, of its type, a refund of its amount — anything else is unknown, never done', async () => {
    const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const cases: Array<['void' | 'refund', Record<string, unknown>, string]> = [
      ['void', { OriginalTrxnIdentifier: other, TransactionIdentifier: other, TransactionType: 4 }, 'VOID_APPROVAL_NOT_FOR_THIS_TRANSACTION'],
      ['void', { TransactionType: 4 }, 'VOID_APPROVAL_NOT_FOR_THIS_TRANSACTION'],
      ['void', { OriginalTrxnIdentifier: original, TransactionIdentifier: original, TransactionType: 5 }, 'VOID_APPROVAL_NOT_FOR_THIS_TYPE'],
      ['void', { OriginalTrxnIdentifier: original, TransactionIdentifier: original }, 'VOID_APPROVAL_NOT_FOR_THIS_TYPE'],
      ['refund', { OriginalTrxnIdentifier: other, TransactionIdentifier: other, TransactionType: 5, TotalAmount: 2100, CurrencyCode: '328' }, 'REFUND_APPROVAL_NOT_FOR_THIS_TRANSACTION'],
      ['refund', { OriginalTrxnIdentifier: original, TransactionType: 4, TotalAmount: 2100, CurrencyCode: '328' }, 'REFUND_APPROVAL_NOT_FOR_THIS_TYPE'],
      ['refund', { OriginalTrxnIdentifier: original, TransactionType: 5, TotalAmount: 1, CurrencyCode: '328' }, 'REFUND_APPROVAL_NOT_FOR_THIS_AMOUNT'],
      ['refund', { OriginalTrxnIdentifier: original, TransactionType: 5, TotalAmount: 2100, CurrencyCode: '840' }, 'REFUND_APPROVAL_NOT_FOR_THIS_AMOUNT'],
      ['refund', { OriginalTrxnIdentifier: original, TransactionType: 5 }, 'REFUND_APPROVAL_NOT_FOR_THIS_AMOUNT'],
    ];
    for (const [action, fields, reason] of cases) {
      const gw = gateway({ [`/api/${action}`]: () => ({ status: 200, body: { Approved: true, IsoResponseCode: '00', ResponseMessage: 'Transaction is approved.', ...fields } }) });
      const p = provider(gw);
      const answer = action === 'void'
        ? await p.voidPayment({ binding: p.binding, providerRef: original, idempotencyKey: `void-${nanoid(6)}` })
        : await p.refund({ binding: p.binding, providerRef: original, amountMinor: 210_000, currencyCode: 'GYD', idempotencyKey: `refund-${nanoid(6)}` });
      expect(answer, JSON.stringify(fields)).toMatchObject({ status: 'unknown', reason });
    }
  });
  it('void: POST <root>/api/void with the original TransactionIdentifier only (no partial voids)', async () => {
    const gw = gateway({ '/api/void': () => ({ status: 200, body: { OriginalTrxnIdentifier: original, TransactionType: 4, Approved: true, TransactionIdentifier: original, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    expect(await p.voidPayment({ binding: p.binding, providerRef: original, idempotencyKey: `void-${nanoid(6)}` })).toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(gw.calls[0]!.body!)).toEqual({ TransactionIdentifier: original });
  });
});

describe('the owner\'s self-check: OK / FAIL lines only', () => {
  it('reachable, credentials accepted, hosted page set up — and never a value in the answer', async () => {
    const gw = gateway({
      '/api/alive': () => ({ status: 200, body: { ok: true } }),
      '/api/spi/riskmgmt': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '97', Errors: [{ Code: '37', Message: 'Missing field(s)' }] } }),
      '/api/spi/sale': preprocessed,
      '/hpp': () => ({ status: 200, body: STAGING_HPP_HTML }),
    });
    const lines = await provider(gw).selfCheck({ preprocess: true, returnUrl: RETURN_URL });
    expect(lines).toEqual([
      { check: 'gateway reachable', ok: true }, { check: 'credentials accepted', ok: true }, { check: SELF_CHECK_PAGE_LINE, ok: true },
      { check: SELF_CHECK_PAGE_OPENS.shown, ok: true },
    ]);
    // The page is opened as the browser opens it: RedirectData's form, posted once to the API root's own origin.
    const opened = gw.calls.find((c) => c.url.endsWith('/hpp'))!;
    expect(opened).toMatchObject({ url: 'https://staging.ptranz.com/hpp', method: 'POST', body: 't=synthetic' });
    expect(opened.headers['content-type']).toBe('application/x-www-form-urlencoded');
    // [CARD-STAGING-TEST 10 Nov 2026] SP4 is no proof the page exists (the sandbox preprocessed a set without PTZ/
    // and refused the page only in the browser): that line claims SP4 only, and the page has its own line.
    expect(SELF_CHECK_PAGE_LINE).toBe('a sale with this hosted page is preprocessed (SP4)');
    expect(gw.paths()).not.toContain('/api/spi/payment'); // a self-check never completes anything
  });
  it('invalid credentials (Appendix 1: 89 / 312) or an unreachable gateway: FAIL', async () => {
    const gw = gateway({
      '/api/alive': () => 'network',
      '/api/spi/riskmgmt': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '89', Errors: [{ Code: '312', Message: 'Invalid credentials' }] } }),
      '/api/spi/sale': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', Errors: [{ Code: '757' }] } }),
    });
    const lines = await provider(gw).selfCheck({ preprocess: true, returnUrl: RETURN_URL });
    expect(lines.map((l) => l.ok)).toEqual([false, false, false]);
    expect(JSON.stringify(lines)).not.toContain('test-password-not-real');
  });

  it('[CARD-STAGING-TEST 10 Nov 2026] SP4 is no proof the page exists: a page PowerTranz cannot find (757, posted straight back) FAILs, naming the settings to check; an unreadable or foreign answer is "could not tell", never OK', async () => {
    const run = async (hpp: (call: Call) => ReturnType<Responder>, redirect?: string) => {
      const gw = gateway({
        '/api/alive': () => ({ status: 200, body: {} }),
        '/api/spi/riskmgmt': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '97' } }),
        '/api/spi/sale': (call) => {
          const answer = preprocessed(call);
          return redirect === undefined ? answer : { ...answer, body: { ...answer.body, RedirectData: redirect } };
        },
        '/hpp': hpp,
      });
      const lines = await provider(gw).selfCheck({ preprocess: true, returnUrl: RETURN_URL });
      return { lines, gw };
    };
    const notFound = await run(() => ({ status: 200, body: stagingConductorNotFoundHtml(RETURN_URL, { txn: STAGING_TXN, order: STAGING_ORDER, spiToken: 'spi-x' }) }));
    expect(notFound.lines.slice(2)).toEqual([{ check: SELF_CHECK_PAGE_LINE, ok: true }, { check: SELF_CHECK_PAGE_OPENS.not_found, ok: false }]);
    expect(SELF_CHECK_PAGE_OPENS.not_found).toMatch(/POWERTRANZ_PAGE_SET, with PTZ\/, and POWERTRANZ_PAGE_NAME/);
    expect(JSON.stringify(notFound.lines)).not.toMatch(/757|Hosted page not found/); // the provider's own words are never printed
    for (const [hpp, redirect, expected] of [
      [() => ({ status: 200, body: '<html><body>Under maintenance</body></html>' }), undefined, 'could_not_tell'],
      [() => ({ status: 500, body: STAGING_HPP_HTML }), undefined, 'could_not_tell'],
      [() => 'timeout', undefined, 'could_not_tell'],
      // A post-back with another error than 757: refused.
      [() => ({ status: 200, body: stagingConductorNotFoundHtml(RETURN_URL, { txn: STAGING_TXN, order: STAGING_ORDER, spiToken: 'x' }).replace('757', '758') }), undefined, 'refused'],
      // RedirectData that is not one POST form, or posts anywhere but PowerTranz's own API origin: never opened.
      [() => ({ status: 200, body: STAGING_HPP_HTML }), '<html><body>no form</body></html>', 'could_not_tell'],
      [() => ({ status: 200, body: STAGING_HPP_HTML }), '<form method="post" action="https://evil.example.test/hpp"><input name="t" value="x"></form>', 'could_not_tell'],
      [() => ({ status: 200, body: STAGING_HPP_HTML }), '<form method="get" action="https://staging.ptranz.com/hpp"></form>', 'could_not_tell'],
    ] as const) {
      const { lines, gw } = await run(hpp as never, redirect);
      expect(lines.at(-1), String(expected)).toEqual({ check: SELF_CHECK_PAGE_OPENS[expected], ok: false });
      expect(gw.calls.some((c) => c.url.startsWith('https://evil.example.test')), String(expected)).toBe(false);
    }
  });

  it('[CARD-STAGING-TEST] reading RedirectData and the opened page (pure)', () => {
    expect(redirectForm('<form id="f" method="post" action="https://staging.ptranz.com/api/spi/Conductor"><input type="hidden" name="SpiToken" value="a&amp;b"><input name="x"></form><script>f.submit()</script>'))
      .toEqual({ action: 'https://staging.ptranz.com/api/spi/Conductor', fields: [['SpiToken', 'a&b'], ['x', '']] });
    expect(redirectForm('<form method="POST" action="/a"></form><form method="POST" action="/b"></form>')).toBeNull();
    const base = 'https://staging.ptranz.com/api/spi/Conductor';
    expect(hostedPageAnswer(STAGING_HPP_HTML, RETURN_URL, base)).toBe('shown');
    expect(hostedPageAnswer(stagingConductorNotFoundHtml(RETURN_URL, { txn: 't', order: 'o', spiToken: 's' }), RETURN_URL, base)).toBe('not_found');
    // A form posting back to the return address is no card form, whatever it carries.
    expect(hostedPageAnswer(`<form method="POST" action="${RETURN_URL.replace(/&/g, '&amp;')}"><input type="hidden" name="X" value="1"></form>`, RETURN_URL, base)).toBe('refused');
    expect(hostedPageAnswer('<p>nothing to type into</p>', RETURN_URL, base)).toBe('could_not_tell');
    // [REVIEW-2466-B F5] Inputs alone are not PowerTranz's card form: its card-number and security-code fields must be there.
    expect(hostedPageAnswer('<form method="POST" action="/login"><input name="user"><input type="password" name="pw"></form>', RETURN_URL, base)).toBe('could_not_tell');
    expect(hostedPageAnswer('<input name="CardNo">', RETURN_URL, base)).toBe('could_not_tell');
    expect(hostedPageAnswer('<div><input type="tel" name=\'CardNo\'><input type=tel name=CardCVV2></div>', RETURN_URL, base)).toBe('shown');
  });
});

describe('the card-save consent (owner sign-off, 7 Oct 2026)', () => {
  it('version card-on-file-v1 is exactly the approved words: a new wording is a new version, never a silent edit', () => {
    expect(CARD_ON_FILE_CONSENT_VERSION).toBe('card-on-file-v1');
    expect(CARD_ON_FILE_CONSENT_TEXT).toBe('Swift will charge the card you add for your weekly fee each week, when it is due, until you remove it. Your bank may ask you to confirm a charge. You can remove the card here at any time.');
    expect(createHash('sha256').update(CARD_ON_FILE_CONSENT_TEXT).digest('hex')).toBe(CARD_ON_FILE_CONSENT_SHA256);
  });
});

// ---------------------------------------------------------------------------
// [CARD-LOOKUP] PowerTranz's transaction lookup (PowerTranz's written answer to Swift, 4 Nov 2026):
// GET <root>/api/Transactions/{TransactionIdentifier} with the PowerTranz-PowerTranzId / -PowerTranzPassword
// headers, ONLY when an outcome is unknown, never as the normal flow; VoidDateTime present = reversed; OrderSummary
// carries SettledAmount, TotalCaptureAmount and TotalCreditAmount. The double answers with those field names and the
// guide's sec. 6 response fields only. Every value is synthetic.
// ---------------------------------------------------------------------------

describe('[CARD-LOOKUP] the transaction lookup: read strictly, judged against what Swift asked, never the normal flow', () => {
  const txn = 'd7b3c1a2-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
  const order = 'SWIFT-cs_lookup_synthetic';
  const ask = (p: PowerTranzCardRailProvider, providerRef = txn) =>
    p.lookupTransaction({ binding: p.binding, providerRef, orderRef: order, amountMinor: 210_000, currencyCode: 'GYD' });
  /** [CARD-STAGING-TEST 10 Nov 2026] A transaction record in the REAL shape PowerTranz's staging sandbox answered
   *  (fixtures/powertranz-staging-shapes.ts): no Approved and no top-level order; the order, the counts and the void
   *  in OrderSummary. `fields` patch the top level, `summary` OrderSummary (undefined drops a field). */
  const record = (fields: Record<string, unknown> = {}, summary: Record<string, unknown> = {}) =>
    stagingSaleRecord({ txn, order, summary: { TotalCaptureAmount: 2100, ...summary }, top: { TotalAmount: 2100, ...fields } });
  const at = (answer: ReturnType<Responder>) => gateway({ [`/api/Transactions/${txn}`]: () => answer });
  /** Each case its own merchant label, so one case's backoff never gates another. */
  const fresh = (gw: ReturnType<typeof gateway>, now?: () => Date) => provider(gw, { config: { account: `lk-${nanoid(6).replace(/[^A-Za-z0-9]/g, '0')}` }, ...(now ? { now } : {}) });

  it('GET <root>/api/Transactions/{id}, credentials in the headers, no body; an approved sale of this transaction and order at Swift\'s price, not reversed, not refunded -> confirmed', async () => {
    const gw = at({ status: 200, body: record() });
    const p = fresh(gw);
    expect(await ask(p)).toMatchObject({ status: 'confirmed', providerRef: txn, amountMinor: 210_000, currencyCode: 'GYD' });
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]).toMatchObject({ url: `${POWERTRANZ_SANDBOX_ROOT}/api/Transactions/${txn}`, method: 'GET', body: undefined });
    expect(gw.calls[0]!.headers['powertranz-powertranzid']).toBe('TESTID01');
    expect(gw.calls[0]!.headers['powertranz-powertranzpassword']).toBe('test-password-not-real');
    // [REVIEW-2460-B B7 · B8] A GET with no body carries no content-type; the read waits at most 10 s.
    expect(gw.calls[0]!.headers).not.toHaveProperty('content-type');
    expect(LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('[REVIEW-2460-DELTA D3] the read is aborted at LOOKUP_TIMEOUT_MS (10 s), not the 15 s of the other calls', async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(Number(ms));
      return real(fn, ms);
    }) as unknown as typeof setTimeout);
    let signal: AbortSignal | undefined;
    const slow = (async (_url: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
      signal = init?.signal ?? undefined;
      return new Response(JSON.stringify(record()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      const p = new PowerTranzCardRailProvider(redis, { ...CONFIG, account: `lk-${nanoid(6).replace(/[^A-Za-z0-9]/g, '0')}` }, { fetch: slow, keyPrefix: PREFIX });
      expect(await ask(p)).toMatchObject({ status: 'confirmed' });
    } finally { spy.mockRestore(); }
    expect(signal).toBeDefined();
    expect(delays).toContain(LOOKUP_TIMEOUT_MS);
    expect(delays).not.toContain(15_000);
  });

  it('VoidDateTime present (a real date; in OrderSummary, as the real record, or at the top level) = reversed; a credit of the whole capture = reversed; a smaller credit = part refunded: never confirmed', async () => {
    expect(await ask(fresh(at({ status: 200, body: record({}, { VoidDateTime: '2026-11-09T12:00:00' }) })))).toMatchObject({ status: 'reversed', reason: 'LOOKUP_VOIDED' });
    expect(await ask(fresh(at({ status: 200, body: record({}, { VoidDateTime: '2026-11-09 12:00:00.123' }) })))).toMatchObject({ status: 'reversed', reason: 'LOOKUP_VOIDED' });
    expect(await ask(fresh(at({ status: 200, body: record({ VoidDateTime: '2026-11-09T12:00:00' }) })))).toMatchObject({ status: 'reversed', reason: 'LOOKUP_VOIDED' });
    expect(await ask(fresh(at({ status: 200, body: record({}, { TotalCreditAmount: 2100, CreditCount: 1 }) })))).toMatchObject({ status: 'reversed', reason: 'LOOKUP_CREDITED' });
    // [REVIEW-2460-A S3-1] Part of it refunded: the rest WAS taken. Never "reversed", never confirmed.
    expect(await ask(fresh(at({ status: 200, body: record({}, { TotalCreditAmount: 1, CreditCount: 1 }) })))).toMatchObject({ status: 'part_credited', reason: 'LOOKUP_PARTIAL_CREDIT' });
    expect(await ask(fresh(at({ status: 200, body: record({}, { TotalCreditAmount: 2099.99, CreditCount: 2 }) })))).toMatchObject({ status: 'part_credited', reason: 'LOOKUP_PARTIAL_CREDIT' });
    // An absent or null VoidDateTime is no reversal.
    expect(await ask(fresh(at({ status: 200, body: record({ VoidDateTime: null }, { VoidDateTime: null }) })))).toMatchObject({ status: 'confirmed' });
  });

  it('readable but not a confirmed sale at Swift\'s price -> not_bookable (another capture amount, another currency, declined, not a sale)', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
      [{}, { TotalCaptureAmount: 2000 }, 'LOOKUP_AMOUNT_MISMATCH'],
      [{}, { TotalCaptureAmount: 0 }, 'LOOKUP_AMOUNT_MISMATCH'],
      [{ TotalAmount: 2000 }, {}, 'LOOKUP_AMOUNT_MISMATCH'],
      [{ CurrencyCode: '840' }, { CurrencyCode: '840' }, 'LOOKUP_CURRENCY_MISMATCH'],
      [{ CurrencyCode: '840' }, { CurrencyCode: undefined }, 'LOOKUP_CURRENCY_MISMATCH'],
      [{ IsoResponseCode: '05' }, { TotalCaptureAmount: 0, CaptureCount: 0 }, 'LOOKUP_NOT_APPROVED_05'],
      [{ Approved: false }, {}, 'LOOKUP_NOT_APPROVED_00'],
      [{ Approved: true, IsoResponseCode: '96' }, {}, 'LOOKUP_NOT_APPROVED_96'],
      [{}, { CaptureCount: 0 }, 'LOOKUP_NOT_CAPTURED'],
      // [CARD-STAGING-TEST] PowerTranz's portal lists every hosted page as a "Sale" row: one with nothing taken is never confirmed.
      [{}, { CaptureCount: 0, TotalCaptureAmount: 0 }, 'LOOKUP_NOT_CAPTURED'],
    ];
    for (const [fields, summary, reason] of cases) {
      expect(await ask(fresh(at({ status: 200, body: record(fields, summary) }))), JSON.stringify({ fields, summary })).toMatchObject({ status: 'not_bookable', reason });
    }
  });

  it('an unreadable answer is unknown, never success: another transaction or order, missing or mistyped fields, HTTP errors, no answer', async () => {
    const noSummary: Record<string, unknown> = record();
    delete noSummary['OrderSummary'];
    const cases: Array<[ReturnType<Responder>, string]> = [
      [{ status: 200, body: record({ TransactionIdentifier: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { OriginalTrxnIdentifier: undefined }) }, 'LOOKUP_OTHER_TRANSACTION'],
      [{ status: 200, body: record({}, { OrderIdentifier: 'SWIFT-someone-else' }) }, 'LOOKUP_OTHER_ORDER'],
      [{ status: 200, body: record({ OrderIdentifier: 'SWIFT-someone-else' }, { OrderIdentifier: undefined }) }, 'LOOKUP_OTHER_ORDER'],
      // [CARD-STAGING-TEST] An approved sale whose record names no order cannot be attributed: unknown.
      [{ status: 200, body: record({}, { OrderIdentifier: undefined }) }, 'LOOKUP_NO_ORDER'],
      // [CARD-STAGING-TEST] Not a Sale (a void is its own type-4 transaction): never read as the payment, before anything else.
      [{ status: 200, body: record({ TransactionType: 1 }) }, 'LOOKUP_NOT_A_SALE'],
      [{ status: 200, body: record({ TransactionType: 4 }, { VoidDateTime: '2026-11-09T12:00:00' }) }, 'LOOKUP_NOT_A_SALE'],
      [{ status: 200, body: noSummary }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { TotalCreditAmount: undefined }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { TotalCaptureAmount: '21.005' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({ Approved: 'true' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({ CurrencyCode: '999' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({ TotalAmount: undefined }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({ TotalAmount: 2100.005 }) }, 'LOOKUP_UNREADABLE'],
      // [CARD-STAGING-TEST] Two copies that disagree, or a count that is no count: unreadable, never a guess.
      [{ status: 200, body: record({}, { CurrencyCode: '840' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({ OrderIdentifier: 'SWIFT-someone-else' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { OrderIdentifier: 17 }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { OriginalTrxnIdentifier: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { CaptureCount: undefined }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { CreditCount: -1 }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { CaptureCount: '1' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: '' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: 17 }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({ VoidDateTime: '' }) }, 'LOOKUP_UNREADABLE'],
      // [REVIEW-2460-A S2-1] A VoidDateTime that is not a real date (a "no date" sentinel, a placeholder) is never
      // read as a reversal: unreadable, so today's void is still sent.
      [{ status: 200, body: record({}, { VoidDateTime: '0001-01-01T00:00:00' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: '1900-01-01T00:00:00' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: 'N/A' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: 'garbage' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: '1' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: '2026-13-45T99:99:99' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({ VoidDateTime: '0001-01-01T00:00:00' }) }, 'LOOKUP_UNREADABLE'],
      // [REVIEW-2460-DELTA D1] ... nor a date later than a day after the read (.NET's "no date" maximum, SQL's
      // smalldatetime maximum, any future date).
      [{ status: 200, body: record({}, { VoidDateTime: '9999-12-31T23:59:59.9999999' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: '2079-06-06T23:59:00' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: new Date(Date.now() + 2 * 86_400_000).toISOString() }) }, 'LOOKUP_UNREADABLE'],
      // [REVIEW-2460-DELTA D2] A credit that contradicts the capture (more than captured; nothing captured) is unknown.
      [{ status: 200, body: record({}, { TotalCreditAmount: 2200, CreditCount: 1 }) }, 'LOOKUP_CREDIT_UNREADABLE'],
      [{ status: 200, body: record({}, { TotalCaptureAmount: 0, TotalCreditAmount: 100, CreditCount: 1 }) }, 'LOOKUP_CREDIT_UNREADABLE'],
      // A credit amount with no credit counted, or a credit counted with no amount: contradictory.
      [{ status: 200, body: record({}, { TotalCreditAmount: 2100 }) }, 'LOOKUP_CREDIT_UNREADABLE'],
      [{ status: 200, body: record({}, { CreditCount: 1 }) }, 'LOOKUP_CREDIT_UNREADABLE'],
      [{ status: 200, body: [record()] }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: 'not json at all' }, 'LOOKUP_UNREADABLE'],
      // [CARD-STAGING-TEST] A transaction PowerTranz does not know: HTTP 204, no body.
      [{ status: 204, body: '' }, 'LOOKUP_NOT_FOUND'],
      [{ status: 404, body: 'not found' }, 'LOOKUP_HTTP_404'],
      [{ status: 500, body: record() }, 'LOOKUP_HTTP_500'],
      ['network', 'LOOKUP_NO_ANSWER_NETWORK'],
      ['timeout', 'LOOKUP_NO_ANSWER_TIMEOUT'],
    ];
    for (const [answer, reason] of cases) {
      const outcome = await ask(fresh(at(answer)));
      expect(outcome, `${JSON.stringify(answer)}`).toMatchObject({ status: 'unknown', reason });
      expect(outcome.status).not.toBe('confirmed');
    }
  });

  it('a reference that is not a transaction id is never asked about; another binding is refused before any call', async () => {
    const gw = at({ status: 200, body: record() });
    const p = fresh(gw);
    expect(await ask(p, 'not-a-guid')).toMatchObject({ status: 'unknown', reason: 'LOOKUP_REQUEST_INVALID' });
    await expect(p.lookupTransaction({ binding: { ...p.binding, account: 'someone-else' }, providerRef: txn, orderRef: order, amountMinor: 210_000, currencyCode: 'GYD' }))
      .rejects.toBeInstanceOf(CardBindingMismatchError);
    expect(gw.calls).toHaveLength(0);
  });

  it('at most one read per transaction per backoff window, timed by Redis\'s own clock (one clock for every server); the window doubles (1, 2, 4 ... minutes, at most 30)', async () => {
    // [REVIEW-2460-A S4-2] The server's own clock is not the gate's clock: even a server whose clock runs an hour
    // ahead is held inside the window.
    const gw = at('timeout');
    const p = fresh(gw, () => new Date(Date.now() + 60 * 60_000));
    const reads = () => gw.calls.length;
    const gate = `${PREFIX}l:${p.binding.account}:${txn}`;
    const windowMs = async () => {
      const [sec, micro] = await redis.time();
      return Number(await redis.hget(gate, 'nextAtMs')) - (Number(sec) * 1000 + Math.floor(Number(micro) / 1000));
    };
    expect(await ask(p)).toMatchObject({ status: 'unknown', reason: 'LOOKUP_NO_ANSWER_TIMEOUT' });
    expect(reads()).toBe(1);
    expect(await ask(p)).toMatchObject({ status: 'unknown', reason: 'LOOKUP_BACKOFF', backoff: true });
    expect(reads()).toBe(1);
    const windows: number[] = [await windowMs()];
    for (let i = 0; i < 7; i += 1) {
      await redis.hset(gate, 'nextAtMs', '0'); // the window has passed
      await ask(p);
      windows.push(await windowMs());
      expect(await ask(p)).toMatchObject({ backoff: true });
    }
    expect(reads()).toBe(8);
    const minutes = windows.map((w) => Math.round(w / 60_000));
    expect(minutes).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });

  it('never the normal flow: a page made, completed, declined, refunded or voided reads no transaction record', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const original = 'cab173a7-f75e-444b-ac42-cc6a367b8b6b';
    const gw = gateway({
      '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({})(page),
      '/api/refund': () => ({ status: 200, body: { OriginalTrxnIdentifier: original, TransactionType: 5, Approved: true, TransactionIdentifier: '0446a902-311d-4868-8247-e9dfbd8ea0a6', TotalAmount: 2100, CurrencyCode: '328', IsoResponseCode: '00' } }),
      '/api/void': () => 'timeout',
    });
    const p = provider(gw);
    page = await openPage(p);
    await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' });
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, {}) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'succeeded' });
    const declined = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: declined.ref, params: authResult(declined, { AuthenticationStatus: 'N' }) });
    await p.confirm({ binding: p.binding, providerSessionRef: declined.ref, purpose: 'PAY_NOW' });
    await p.refund({ binding: p.binding, providerRef: original, amountMinor: 210_000, currencyCode: 'GYD', idempotencyKey: `refund-${nanoid(6)}` });
    await p.voidPayment({ binding: p.binding, providerRef: original, idempotencyKey: `void-${nanoid(6)}` });
    expect(gw.paths().filter((x) => x.toLowerCase().startsWith('/api/transactions'))).toEqual([]);
    expect(gw.calls.every((c) => c.method === 'POST')).toBe(true);
  });
});

describe('[CARD-REFUND-LOOKUP] a refund whose answer is not known: the original transaction\'s record, judged for the WHOLE payment back', () => {
  const txn = 'e8c4d2b3-6f70-4b9c-8d1e-2f3a4b5c6d7e';
  const order = 'SWIFT-cs_refund_lookup_synthetic';
  const ask = (p: PowerTranzCardRailProvider, amountMinor = 210_000) =>
    p.lookupRefund({ binding: p.binding, providerRef: txn, orderRef: order, amountMinor, currencyCode: 'GYD' });
  /** [CARD-STAGING-TEST 10 Nov 2026] The original Sale's record in the REAL shape (fixtures/powertranz-staging-shapes.ts),
   *  settled. A refund's own record shape is not captured yet: `credited` adds the documented OrderSummary credit
   *  fields as ASSUMED (TotalCreditAmount with its CreditCount). */
  const record = (fields: Record<string, unknown> = {}, summary: Record<string, unknown> = {}) =>
    stagingSaleRecord({ txn, order, summary: { SettledAmount: 2100, TotalCaptureAmount: 2100, ...summary }, top: { TotalAmount: 2100, ...fields } });
  const credited = (amount: number | string, more: Record<string, unknown> = {}) => ({ TotalCreditAmount: amount, CreditCount: 1, ...more });
  const at = (answer: ReturnType<Responder>) => gateway({ [`/api/Transactions/${txn}`]: () => answer });
  const fresh = (gw: ReturnType<typeof gateway>) => provider(gw, { config: { account: `rl-${nanoid(6).replace(/[^A-Za-z0-9]/g, '0')}` } });

  it('the whole payment credited back (TotalCreditAmount = TotalCaptureAmount = Swift\'s price) -> refunded; a real VoidDateTime -> refunded (void). One GET, nothing sent', async () => {
    const gw = at({ status: 200, body: record({}, credited(2100)) });
    expect(await ask(fresh(gw))).toMatchObject({ status: 'refunded', how: 'credit', reason: 'LOOKUP_CREDITED' });
    expect(gw.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`GET /api/Transactions/${txn}`]);
    expect(await ask(fresh(at({ status: 200, body: record({}, { VoidDateTime: '2026-11-09T12:00:00' }) })))).toMatchObject({ status: 'refunded', how: 'void', reason: 'LOOKUP_VOIDED' });
    expect(await ask(fresh(at({ status: 200, body: record({}, { VoidDateTime: '2026-11-09 12:00:00.1234567' }) })))).toMatchObject({ status: 'refunded', how: 'void' });
  });

  it('a credit that is not the whole payment is never "refunded": part of it, or the whole of a capture that is not Swift\'s price -> part_credited (the owner)', async () => {
    expect(await ask(fresh(at({ status: 200, body: record({}, credited(1)) })))).toMatchObject({ status: 'part_credited', reason: 'LOOKUP_PARTIAL_CREDIT' });
    expect(await ask(fresh(at({ status: 200, body: record({}, credited(2099.99)) })))).toMatchObject({ status: 'part_credited', reason: 'LOOKUP_PARTIAL_CREDIT' });
    expect(await ask(fresh(at({ status: 200, body: record({}, credited(2000, { TotalCaptureAmount: 2000 })) })))).toMatchObject({ status: 'part_credited', reason: 'LOOKUP_CREDIT_NOT_THE_PAYMENT' });
    expect(await ask(fresh(at({ status: 200, body: record({}, credited(2100, { TotalCaptureAmount: 2200 })) })))).toMatchObject({ status: 'part_credited', reason: 'LOOKUP_PARTIAL_CREDIT' });
    // Swift's price differs from the record's whole credit: never refunded.
    expect(await ask(fresh(at({ status: 200, body: record({}, credited(2100)) })), 200_000)).toMatchObject({ status: 'part_credited', reason: 'LOOKUP_CREDIT_NOT_THE_PAYMENT' });
  });

  it('no credit and no void on the record -> not_refunded (nothing to record yet)', async () => {
    expect(await ask(fresh(at({ status: 200, body: record() })))).toMatchObject({ status: 'not_refunded', reason: 'LOOKUP_NO_CREDIT' });
    expect(await ask(fresh(at({ status: 200, body: record({ VoidDateTime: null }, { VoidDateTime: null }) })))).toMatchObject({ status: 'not_refunded' });
  });

  it('an unreadable or contradictory answer is unknown, never refunded: another transaction, order or currency; a credit above the capture; a credit on a sale that was not approved; a VoidDateTime that is no real date; HTTP errors; no answer', async () => {
    const cases: Array<[ReturnType<Responder>, string]> = [
      [{ status: 200, body: record({ TransactionIdentifier: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, credited(2100, { OriginalTrxnIdentifier: undefined })) }, 'LOOKUP_OTHER_TRANSACTION'],
      [{ status: 200, body: record({}, credited(2100, { OrderIdentifier: 'SWIFT-someone-else' })) }, 'LOOKUP_OTHER_ORDER'],
      [{ status: 200, body: record({}, credited(2100, { OrderIdentifier: undefined })) }, 'LOOKUP_NO_ORDER'],
      [{ status: 200, body: record({ CurrencyCode: '840' }, credited(2100, { CurrencyCode: '840' })) }, 'LOOKUP_CURRENCY_MISMATCH'],
      [{ status: 200, body: record({}, credited(2200)) }, 'LOOKUP_CREDIT_UNREADABLE'],
      [{ status: 200, body: record({}, credited(2100, { TotalCaptureAmount: 0 })) }, 'LOOKUP_CREDIT_UNREADABLE'],
      [{ status: 200, body: record({}, credited(2100, { CreditCount: 0 })) }, 'LOOKUP_CREDIT_UNREADABLE'],
      [{ status: 200, body: record({}, credited(2100, { CaptureCount: 0 })) }, 'LOOKUP_CREDIT_UNREADABLE'],
      [{ status: 200, body: record({ Approved: false, IsoResponseCode: '05' }, credited(2100)) }, 'LOOKUP_NOT_AN_APPROVED_SALE'],
      [{ status: 200, body: record({ TransactionType: 5 }, credited(2100)) }, 'LOOKUP_NOT_A_SALE'],
      [{ status: 200, body: record({ TransactionType: 4 }, { VoidDateTime: '2026-11-09T12:00:00' }) }, 'LOOKUP_NOT_A_SALE'],
      [{ status: 200, body: record({}, credited('2100.005')) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, credited(-2100)) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { TotalCreditAmount: undefined }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: '0001-01-01T00:00:00' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: '9999-12-31T23:59:59.9999999' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: record({}, { VoidDateTime: 'N/A' }) }, 'LOOKUP_UNREADABLE'],
      [{ status: 200, body: 'not json at all' }, 'LOOKUP_UNREADABLE'],
      [{ status: 204, body: '' }, 'LOOKUP_NOT_FOUND'],
      [{ status: 404, body: 'not found' }, 'LOOKUP_HTTP_404'],
      [{ status: 500, body: record({}, credited(2100)) }, 'LOOKUP_HTTP_500'],
      ['network', 'LOOKUP_NO_ANSWER_NETWORK'],
      ['timeout', 'LOOKUP_NO_ANSWER_TIMEOUT'],
    ];
    for (const [answer, reason] of cases) {
      const outcome = await ask(fresh(at(answer)));
      expect(outcome, JSON.stringify(answer)).toMatchObject({ status: 'unknown', reason });
    }
  });

  it('the same backoff as the completion lookup, per transaction: a refund check right after any read of that transaction reads nothing; another binding is refused before any call', async () => {
    const gw = at({ status: 200, body: record({}, credited(2100)) });
    const p = fresh(gw);
    await p.lookupTransaction({ binding: p.binding, providerRef: txn, orderRef: order, amountMinor: 210_000, currencyCode: 'GYD' });
    expect(await ask(p)).toMatchObject({ status: 'unknown', reason: 'LOOKUP_BACKOFF', backoff: true });
    expect(gw.calls).toHaveLength(1);
    await redis.hset(`${PREFIX}l:${p.binding.account}:${txn}`, 'nextAtMs', '0'); // the window has passed
    expect(await ask(p)).toMatchObject({ status: 'refunded' });
    expect(await ask(p)).toMatchObject({ status: 'unknown', reason: 'LOOKUP_BACKOFF', backoff: true });
    expect(gw.calls).toHaveLength(2);
    await expect(p.lookupRefund({ binding: { ...p.binding, account: 'someone-else' }, providerRef: txn, orderRef: order, amountMinor: 210_000, currencyCode: 'GYD' }))
      .rejects.toBeInstanceOf(CardBindingMismatchError);
    expect(gw.calls).toHaveLength(2);
    expect(gw.calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [CARD-STAGING-TEST 10 Nov 2026] PowerTranz's REAL staging sandbox, redacted
// (fixtures/powertranz-staging-shapes.ts): the return post Swift could not
// read (every payment failed NOT_AUTHENTICATED), and the lookup records it
// read as unreadable.
// ---------------------------------------------------------------------------

describe('[CARD-STAGING-TEST] the real return post: Response (the result as JSON text), TransactionIdentifier, SpiToken', () => {
  const okPayment = (page: () => { txnId: string; orderId: string }) => () => completion({})(page());

  it('a passed 3-D Secure check (3D0, Y, ECI 05) proceeds: Swift completes once, and PowerTranz\'s approval books', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': okPayment(() => page) });
    const p = provider(gw);
    page = await openPage(p);
    const post = stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken });
    expect(Object.keys(post)).toEqual(['Response', 'TransactionIdentifier', 'SpiToken']);
    expect(p.parseReturn(post).claimedStatus).toBe('pending');
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: post });
    expect(await redis.hmget(`${PREFIX}s:${page.ref}`, 'authDecision', 'authNote')).toEqual(['proceed', '3D0_Y']);
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'succeeded', providerRef: page.txnId, amountMinor: 210_000 });
    expect(gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'))).toHaveLength(1);
    expect(JSON.parse(gw.calls.find((c) => c.url.endsWith('/api/spi/payment'))!.body ?? 'null')).toBe(page.spiToken);
    const reading = readAuthenticationReturn(post);
    expect(reading.result).toMatchObject({ IsoResponseCode: '3D0', TransactionIdentifier: page.txnId, OrderIdentifier: page.orderId, SpiToken: page.spiToken });
    expect(authenticationDecision(reading.result, page)).toEqual({ proceed: true, note: '3D0_Y' });
  });

  it('a failed 3-D Secure check (N, ECI 07; or U, R, 3D1) is refused: failed NOT_AUTHENTICATED, nothing sent', async () => {
    for (const [status, eci, code] of [['N', '07', '3D0'], ['U', '07', '3D0'], ['R', '07', '3D0'], ['Y', '05', '3D1']] as const) {
      const gw = gateway({ '/api/spi/sale': preprocessed });
      const p = provider(gw);
      const page = await openPage(p);
      const post = stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken, status, eci, responseCode: code });
      expect(p.parseReturn(post).claimedStatus, status).toBe('failed');
      await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: post });
      expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' }), status)
        .toMatchObject({ status: 'failed', reason: `NOT_AUTHENTICATED:NOT_AUTHENTICATED_${code}_${status}` });
      expect(gw.paths(), status).toEqual(['/api/spi/sale']);
    }
  });

  it('a Response that is not a JSON result, or a post with a result both inside and beside it, is unreadable — never a result, nothing sent', async () => {
    const cases: Array<[(page: Awaited<ReturnType<typeof openPage>>) => Record<string, string>, string]> = [
      [(page) => ({ ...stagingReturnPost({ spiToken: page.spiToken, txn: page.txnId, order: page.orderId }), Response: '{"IsoResponseCode":"3D0",' }), 'RETURN_RESPONSE_UNREADABLE'],
      [(page) => ({ ...stagingReturnPost({ spiToken: page.spiToken, txn: page.txnId, order: page.orderId }), Response: 'Approved' }), 'RETURN_RESPONSE_UNREADABLE'],
      [(page) => ({ ...stagingReturnPost({ spiToken: page.spiToken, txn: page.txnId, order: page.orderId }), Response: '"3D0"' }), 'RETURN_RESPONSE_UNREADABLE'],
      [(page) => ({ ...stagingReturnPost({ spiToken: page.spiToken, txn: page.txnId, order: page.orderId }), Response: '[]' }), 'RETURN_RESPONSE_UNREADABLE'],
      [(page) => ({ ...stagingReturnPost({ spiToken: page.spiToken, txn: page.txnId, order: page.orderId }), Response: '{"hello":"world"}' }), 'RETURN_RESPONSE_UNREADABLE'],
      [(page) => ({ ...stagingReturnPost({ spiToken: page.spiToken, txn: page.txnId, order: page.orderId }), IsoResponseCode: '3D0' }), 'RETURN_RESPONSE_AMBIGUOUS'],
      [(page) => ({ ...stagingReturnPost({ spiToken: page.spiToken, txn: page.txnId, order: page.orderId }), RiskManagement: JSON.stringify({ ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'Y' } }) }), 'RETURN_RESPONSE_AMBIGUOUS'],
    ];
    for (const [make, note] of cases) {
      const gw = gateway({ '/api/spi/sale': preprocessed });
      const p = provider(gw);
      const page = await openPage(p);
      const post = make(page);
      expect(readAuthenticationReturn(post), note).toEqual({ result: null, note });
      expect(p.parseReturn(post).claimedStatus, note).toBe('invalid');
      await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: post });
      expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' }), note).toMatchObject({ status: 'failed', reason: `NOT_AUTHENTICATED:${note}` });
      expect(gw.paths(), note).toEqual(['/api/spi/sale']);
    }
  });

  it('identifiers that disagree — beside Response vs inside it, or both naming another page — are refused: nothing sent', async () => {
    const other = '99999999-9999-4999-8999-999999999999';
    const cases: Array<[(page: Awaited<ReturnType<typeof openPage>>) => Record<string, string>, string]> = [
      // The copy beside Response names another transaction or token than the one inside it.
      [(page) => stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken, outerTxn: other }), 'RETURN_TRANSACTIONIDENTIFIER_DISAGREES'],
      [(page) => stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken, outerSpiToken: 'spi-someone-else' }), 'RETURN_SPITOKEN_DISAGREES'],
      [(page) => ({ ...stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken }), OrderIdentifier: 'SWIFT-someone-else' }), 'RETURN_ORDERIDENTIFIER_DISAGREES'],
      // Both copies agree, and name another page than the one Swift holds.
      [(page) => stagingReturnPost({ txn: other, order: page.orderId, spiToken: page.spiToken }), 'OTHER_TRANSACTION'],
      [(page) => stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: 'spi-someone-else' }), 'OTHER_PAGE_TOKEN'],
      [(page) => stagingReturnPost({ txn: page.txnId, order: 'SWIFT-someone-else', spiToken: page.spiToken }), 'OTHER_ORDER'],
      // An identifier only beside Response is still checked against the page Swift holds.
      [(page) => {
        const post = stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken });
        const inner = JSON.parse(post.Response) as Record<string, unknown>;
        delete inner['SpiToken'];
        return { ...post, Response: JSON.stringify(inner), SpiToken: 'spi-someone-else' };
      }, 'OTHER_PAGE_TOKEN'],
      // An identifier inside Response that is not text is unreadable.
      [(page) => {
        const post = stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken });
        return { ...post, Response: JSON.stringify({ ...(JSON.parse(post.Response) as object), TransactionIdentifier: 7 }) };
      }, 'RETURN_TRANSACTIONIDENTIFIER_UNREADABLE'],
    ];
    for (const [make, note] of cases) {
      const gw = gateway({ '/api/spi/sale': preprocessed });
      const p = provider(gw);
      const page = await openPage(p);
      await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: make(page) });
      expect(await redis.hmget(`${PREFIX}s:${page.ref}`, 'authDecision', 'authNote'), note).toEqual(['refused', note]);
      expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' }), note).toMatchObject({ status: 'failed', reason: `NOT_AUTHENTICATED:${note}` });
      expect(gw.paths(), note).toEqual(['/api/spi/sale']);
    }
    // The same identifier in another case (a GUID) is the same identifier.
    const p = provider(gateway({ '/api/spi/sale': preprocessed }));
    const page = await openPage(p);
    const upper = stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken, outerTxn: page.txnId.toUpperCase() });
    expect(authenticationDecision(readAuthenticationReturn(upper).result, page).proceed).toBe(true);
  });

  it('a page PowerTranz refused itself (Response: IsoResponseCode 12, Errors 757 "Hosted page not found") is no bank check: PAGE_REFUSED, never NOT_AUTHENTICATED; nothing sent', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    const post = stagingPageNotFoundPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken });
    expect(authenticationDecision(readAuthenticationReturn(post).result, page)).toEqual({ proceed: false, note: 'PAGE_REFUSED_12_757' });
    expect(p.parseReturn(post).claimedStatus).toBe('failed');
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: post });
    const outcome = await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'PAGE_REFUSED:PAGE_REFUSED_12_757' });
    expect(failureCodeOf('PAGE_REFUSED:PAGE_REFUSED_12_757')).toBe('PROVIDER_PAGE_UNAVAILABLE');
    expect(gw.paths()).toEqual(['/api/spi/sale']);
    // A 3-D Secure result stays a bank check, whatever else it carries: 3D1 (not available), N.
    expect(authenticationDecision({ IsoResponseCode: '3D1' }, page).note).toBe('NOT_AUTHENTICATED_3D1_NONE');
    expect(authenticationDecision({ IsoResponseCode: '3D0', RiskManagement: { ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'N' } }, Errors: [{ Code: '1' }] }, page).note).toBe('NOT_AUTHENTICATED_3D0_N');
    // Untrusted words never reach the note in full.
    expect(authenticationDecision({ IsoResponseCode: '12<script>', Errors: [{ Code: '757; DROP' }, { Code: 'x' }, { Code: 'y' }, { Code: 'z' }] }, page).note).toBe('PAGE_REFUSED_12sc_757D_x_y');
  });

  it('the PanToken, the cardholder\'s details and the card digits in the post are never stored, logged or echoed: the digest\'s preimage blinds them, and the page record holds only the decision', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    const post = stagingReturnPost({ txn: page.txnId, order: page.orderId, spiToken: page.spiToken });
    for (const secret of STAGING_RETURN_SECRETS) expect(JSON.stringify(post), secret).toContain(secret); // the fixture carries them
    expect(leaksCardSuffix(JSON.stringify(post))).toBe(true); // ... and the card's last digits
    const evidence = JSON.stringify(returnEvidence(post));
    for (const secret of [...STAGING_RETURN_SECRETS, page.spiToken]) expect(evidence, secret).not.toContain(secret);
    expect(leaksCardSuffix(evidence), STAGING_CARD_SUFFIX).toBe(false);
    expect(evidence).toContain(page.txnId); // what is not secret stays readable in the preimage
    const observed = p.parseReturn(post);
    expect(observed.rawSha256).toBe(rawDigest(returnEvidence(post)));
    expect(JSON.stringify(observed)).not.toMatch(/SYNTHETIC|cardholder@/);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: post });
    const kept = JSON.stringify(await redis.hgetall(`${PREFIX}s:${page.ref}`));
    for (const secret of STAGING_RETURN_SECRETS) expect(kept, secret).not.toContain(secret);
    expect(leaksCardSuffix(kept), STAGING_CARD_SUFFIX).toBe(false);
    // An unreadable Response is digested as its own digest, never in the clear.
    const broken = { ...post, Response: `${post.Response.slice(0, -1)}` };
    expect(JSON.stringify(returnEvidence(broken))).not.toContain('SYNTHETIC-PAN-TOKEN');
  });
});

describe('[CARD-STAGING-TEST] the real lookup records: read strictly, a void read from OrderSummary', () => {
  const ask = (p: PowerTranzCardRailProvider, opts: { txn?: string; notBefore?: Date } = {}) =>
    p.lookupTransaction({ binding: p.binding, providerRef: opts.txn ?? STAGING_TXN, orderRef: STAGING_ORDER, amountMinor: STAGING_AMOUNT_MINOR, currencyCode: 'GYD', ...(opts.notBefore ? { notBefore: opts.notBefore } : {}) });
  const askRefund = (p: PowerTranzCardRailProvider) =>
    p.lookupRefund({ binding: p.binding, providerRef: STAGING_TXN, orderRef: STAGING_ORDER, amountMinor: STAGING_AMOUNT_MINOR, currencyCode: 'GYD', notBefore: new Date(STAGING_SESSION_AT_MS - VOID_DATE_SKEW_MS) });
  const at = (body: unknown, status = 200) => gateway({ [`/api/Transactions/${STAGING_TXN}`]: () => ({ status, body }) });
  /** Read as the staging lane read them: at 05:04:40Z, for a session that began at 05:02:46Z. */
  const fresh = (gw: ReturnType<typeof gateway>) => provider(gw, { now: () => new Date(STAGING_READ_AT_MS), config: { account: `st-${nanoid(6).replace(/[^A-Za-z0-9]/g, '0')}` } });
  const notBefore = new Date(STAGING_SESSION_AT_MS - VOID_DATE_SKEW_MS);

  it('dates name no zone: read as UTC-4 (the void Swift sent at 05:03:11Z is dated 01:03:11)', () => {
    expect(RECORD_ZONE).toBe('-04:00');
    expect(voidDateOf(STAGING_VOID_DATE_TIME)).toBe(STAGING_VOID_AT_MS);
    expect(voidDateOf('2026-11-10T01:03:11.773Z')).toBe(STAGING_VOID_AT_MS - 4 * 60 * 60_000); // a named zone is its own
    expect(voidDateOf('0001-01-01T00:00:00')).toBeNull();
  });

  it('the approved, captured sale (no Approved, no top-level order) at Swift\'s price -> confirmed', async () => {
    expect(readTransactionRecord(stagingSaleRecord())).toEqual({
      transactionIdentifier: STAGING_TXN, orderIdentifier: STAGING_ORDER, transactionType: '2', approved: null, isoResponseCode: '00', currencyCode: 'GYD',
      totalAmountMinor: STAGING_AMOUNT_MINOR, captureCount: 1, creditCount: 0, voided: false, totalCaptureMinor: STAGING_AMOUNT_MINOR, totalCreditMinor: 0,
    });
    expect(await ask(fresh(at(stagingSaleRecord())), { notBefore })).toMatchObject({ status: 'confirmed', providerRef: STAGING_TXN, amountMinor: STAGING_AMOUNT_MINOR, currencyCode: 'GYD' });
  });

  it('DANGER: the same sale voided the same day (IsoResponseCode still 00, the capture kept, no credit; VoidDateTime ONLY in OrderSummary) is reversed — never confirmed', async () => {
    const voided = stagingSaleRecord({ voidDateTime: STAGING_VOID_DATE_TIME });
    expect(voided).not.toHaveProperty('VoidDateTime');
    expect(voided.IsoResponseCode).toBe('00');
    expect(readTransactionRecord(voided, notBefore.getTime(), STAGING_READ_AT_MS + VOID_DATE_SKEW_MS)).toMatchObject({ voided: true, totalCaptureMinor: STAGING_AMOUNT_MINOR, totalCreditMinor: 0 });
    const outcome = await ask(fresh(at(voided)), { notBefore });
    expect(outcome).toMatchObject({ status: 'reversed', reason: 'LOOKUP_VOIDED' });
    expect(outcome.status).not.toBe('confirmed');
    // ... and, for a refund Swift sent whose answer is not known, it reads as the whole payment back (a void).
    expect(await askRefund(fresh(at(voided)))).toMatchObject({ status: 'refunded', how: 'void', reason: 'LOOKUP_VOIDED' });
    expect(await askRefund(fresh(at(stagingSaleRecord())))).toMatchObject({ status: 'not_refunded', reason: 'LOOKUP_NO_CREDIT' });
  });

  it('a page only preprocessed (SP4) or only authenticated (3D0) is no approved sale: not_bookable, never confirmed', async () => {
    expect(readTransactionRecord(stagingPreprocessedRecord())).toMatchObject({ orderIdentifier: null, approved: null, captureCount: 0, voided: false });
    expect(await ask(fresh(at(stagingPreprocessedRecord())))).toMatchObject({ status: 'not_bookable', reason: 'LOOKUP_NOT_APPROVED_SP4' });
    expect(await ask(fresh(at(stagingAuthenticatedRecord())))).toMatchObject({ status: 'not_bookable', reason: 'LOOKUP_NOT_APPROVED_3D0' });
    // For a refund check, a record that names no order is not about this payment.
    expect(await askRefund(fresh(at(stagingAuthenticatedRecord())))).toMatchObject({ status: 'unknown', reason: 'LOOKUP_NO_ORDER' });
  });

  it('a VOID is its own transaction (TransactionType 4, its own id; its record also reads "00", a capture of 15000 and the order): looked up by either id, it is never read as the sale — never confirmed, never "refunded"', async () => {
    const voidRecord = stagingVoidRecord();
    expect(voidRecord).toMatchObject({ IsoResponseCode: '00', TransactionType: 4, TotalAmount: 15000, OrderSummary: { CaptureCount: 1, TotalCaptureAmount: 15000, OrderIdentifier: STAGING_ORDER } });
    // Asked about the sale, answered with the void's record: another transaction.
    const asSale = gateway({ [`/api/Transactions/${STAGING_TXN}`]: () => ({ status: 200, body: voidRecord }) });
    expect(await ask(fresh(asSale), { notBefore })).toMatchObject({ status: 'unknown' });
    // Looked up by the void's own id (its OriginalTrxnIdentifier names the sale): unreadable, never a sale of its own.
    expect(readTransactionRecord(voidRecord, notBefore.getTime(), STAGING_READ_AT_MS + VOID_DATE_SKEW_MS)).toBeNull();
    const asVoid = gateway({ [`/api/Transactions/${STAGING_VOID_TXN}`]: () => ({ status: 200, body: voidRecord }) });
    const outcome = await ask(fresh(asVoid), { txn: STAGING_VOID_TXN, notBefore });
    expect(outcome).toMatchObject({ status: 'unknown', reason: 'LOOKUP_UNREADABLE' });
    // Even a void record that named itself as its original is no sale: Sale first, before any void or capture is read.
    const selfNamed = stagingVoidRecord({ sale: STAGING_VOID_TXN });
    const named = gateway({ [`/api/Transactions/${STAGING_VOID_TXN}`]: () => ({ status: 200, body: selfNamed }) });
    expect(await ask(fresh(named), { txn: STAGING_VOID_TXN, notBefore })).toMatchObject({ status: 'unknown', reason: 'LOOKUP_NOT_A_SALE' });
    const refundAsk = (p: PowerTranzCardRailProvider) => p.lookupRefund({ binding: p.binding, providerRef: STAGING_VOID_TXN, orderRef: STAGING_ORDER, amountMinor: STAGING_AMOUNT_MINOR, currencyCode: 'GYD', notBefore });
    expect(await refundAsk(fresh(gateway({ [`/api/Transactions/${STAGING_VOID_TXN}`]: () => ({ status: 200, body: selfNamed }) })))).toMatchObject({ status: 'unknown', reason: 'LOOKUP_NOT_A_SALE' });
  });

  it('a transaction PowerTranz does not know answers 204 with no body: unknown, never "nothing taken"', async () => {
    expect(await ask(fresh(at(null, 204)))).toMatchObject({ status: 'unknown', reason: 'LOOKUP_NOT_FOUND' });
    expect(await askRefund(fresh(at(null, 204)))).toMatchObject({ status: 'unknown', reason: 'LOOKUP_NOT_FOUND' });
  });
});
