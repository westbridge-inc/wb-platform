import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider, getPushProvider } from '../providers/notifications/channels';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expoAccessToken, expoPushTokenBootLine } from '../providers/notifications/expo-access-token';
import { applySecretFiles } from '../utils/secret-files';
import { assertSafeBootConfig } from '../utils/boot-config';
import { setAppLogger } from '../utils/logger';

// ---------------------------------------------------------------------------
// [EXPO-PUSH-AUTH] Expo's "enhanced push security" makes Expo refuse any push
// that does not carry the project's access token. The adapter sends that token
// as a bearer header on BOTH calls it makes (send, receipts) once
// EXPO_ACCESS_TOKEN is set (a secret file on deployed hosts), and sends no
// Authorization header at all while it is unset, so production behaves
// exactly as before until the owner adds the token. The token never appears
// in an error, a log line or a dump of the adapter.
// ---------------------------------------------------------------------------

const ACCESS = 'expo-test-access-token_0123456789abcdefABCDEF';
const DEVICE = 'ExponentPushToken[auth-wire]';

type Init = { headers: Record<string, string>; body: string };

/** Answers the send with one ok ticket per message (with a receipt id) and the receipts call with ok receipts. */
function expoFetch() {
  return vi.fn(async (url: string, init: Init) => {
    if (url.endsWith('/getReceipts')) {
      const ids = (JSON.parse(init.body) as { ids: string[] }).ids;
      return { ok: true, status: 200, text: async () => '', json: async () => ({ data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) }) };
    }
    const messages = JSON.parse(init.body) as unknown[];
    return { ok: true, status: 200, text: async () => '', json: async () => ({ data: messages.map((_m, i) => ({ status: 'ok', id: `r-${i}` })) }) };
  });
}

const headersOf = (fetchMock: ReturnType<typeof expoFetch>) =>
  fetchMock.mock.calls.map((call) => [(call[0] as string).split('/').at(-1), (call[1] as Init).headers] as const);

type Line = { level: string; obj: unknown; msg: unknown };
let lines: Line[] = [];
const capture = {
  info: (obj: unknown, msg: unknown) => { lines.push({ level: 'info', obj, msg }); },
  warn: (obj: unknown, msg: unknown) => { lines.push({ level: 'warn', obj, msg }); },
  error: (obj: unknown, msg: unknown) => { lines.push({ level: 'error', obj, msg }); },
  debug: (obj: unknown, msg: unknown) => { lines.push({ level: 'debug', obj, msg }); },
};

beforeEach(() => {
  lines = [];
  setAppLogger(capture as never);
  delete process.env['EXPO_ACCESS_TOKEN'];
});
afterEach(() => {
  setAppLogger(console);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env['EXPO_ACCESS_TOKEN'];
});

describe('[EXPO-PUSH-AUTH] the access token on the wire', () => {
  it('set: the send AND the receipts call each carry Authorization: Bearer <token>', async () => {
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    const fetchMock = expoFetch();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ExpoPushProvider({ receiptCheckDelayMs: 1 });
    expect(await provider.sendPush([DEVICE], 'T', 'B', { kind: 'vendor_order_alert' })).toEqual({ sent: 1 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(headersOf(fetchMock)).toEqual([
      ['send', { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${ACCESS}` }],
      ['getReceipts', { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${ACCESS}` }],
    ]);
  });

  it('set: the production selection (PUSH_PROVIDER=expo) sends it too, and every chunk of a large send carries it', async () => {
    process.env['EXPO_ACCESS_TOKEN'] = `  ${ACCESS}\n`; // surrounding whitespace is not part of the token
    vi.stubEnv('PUSH_PROVIDER', 'expo');
    vi.stubEnv('EXPO_PUSH_RECEIPT_DELAY_MS', '0');
    const fetchMock = expoFetch();
    vi.stubGlobal('fetch', fetchMock);
    const devices = Array.from({ length: 150 }, (_v, i) => `ExponentPushToken[auth-${i}]`);
    expect(await getPushProvider().sendPush(devices, 'T', 'B', {})).toEqual({ sent: 150 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, headers] of headersOf(fetchMock)) expect(headers['Authorization']).toBe(`Bearer ${ACCESS}`);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('%s: no Authorization header on either call, exactly as before', async (_label, value) => {
    if (value !== undefined) process.env['EXPO_ACCESS_TOKEN'] = value;
    const fetchMock = expoFetch();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ExpoPushProvider({ receiptCheckDelayMs: 1 });
    expect(await provider.sendPush([DEVICE], 'T', 'B', {})).toEqual({ sent: 1 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(headersOf(fetchMock)).toEqual([
      ['send', { 'Content-Type': 'application/json', Accept: 'application/json' }],
      ['getReceipts', { 'Content-Type': 'application/json', Accept: 'application/json' }],
    ]);
  });

  it('the token is read when the adapter is built: a later change of the setting does not move a live adapter', async () => {
    const fetchMock = expoFetch();
    vi.stubGlobal('fetch', fetchMock);
    const before = new ExpoPushProvider();
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    await before.sendPush([DEVICE], 'T', 'B', {});
    expect((fetchMock.mock.calls[0]?.[1] as Init).headers['Authorization']).toBeUndefined();
  });
});

describe('[EXPO-PUSH-AUTH] the token never leaks', () => {
  it('a network error that quotes the token is thrown and logged without it', async () => {
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`connect failed, header Bearer ${ACCESS}`); }));
    const error = await new ExpoPushProvider().sendPush([DEVICE], 'T', 'B', {}).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Expo push request failed');
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain(ACCESS);
    expect(JSON.stringify(lines)).not.toContain(ACCESS);
  });

  it('a refused send whose reply echoes the token is thrown and logged without it', async () => {
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, text: async () => `{"errors":[{"message":"bad token ${ACCESS}"}]}`, json: async () => ({}),
    })));
    const error = await new ExpoPushProvider().sendPush([DEVICE], 'T', 'B', {}).catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain(ACCESS);
    // Not even a cut-off piece of it.
    expect((error as Error).message).not.toContain(ACCESS.slice(0, 12));
    expect(JSON.stringify(lines)).not.toContain(ACCESS);
  });

  it('a refused receipts call is logged without it', async () => {
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => ACCESS, json: async () => ({ token: ACCESS }) })));
    expect(await new ExpoPushProvider().checkReceipts(['r-1'])).toEqual({ ok: 0, failed: [] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(ACCESS); }));
    expect(await new ExpoPushProvider().checkReceipts(['r-1'])).toEqual({ ok: 0, failed: [] });
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(ACCESS);
  });

  it('a dump of the adapter (JSON, inspect, its keys) never shows the token', () => {
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    const provider = new ExpoPushProvider();
    expect(JSON.stringify(provider)).not.toContain(ACCESS);
    expect(inspect(provider, { depth: 5, showHidden: true })).not.toContain(ACCESS);
    expect(Object.values(provider).map(String).join(' ')).not.toContain(ACCESS);
  });
});

describe('[EXPO-PUSH-AUTH] a set token must be usable', () => {
  // The SAME list is run against the owner's prompt helpers' local check
  // (swift-coordination owner tools): keep the two rules identical.
  const REFUSED: Array<[string, string]> = [
    ['an inner space', 'abc def'],
    ['a line break', 'abc\ndef'],
    ['a tab', 'abc\tdef'],
    ['a no-break space inside', 'abc def'],
    ['a zero-width space', 'abc​def'],
    ['smart quotes', '“abcdef”'],
    ['a non-ASCII letter', 'abcédef'],
    ['double quotes around it', '"abcdef"'],
    ['single quotes around it', "'abcdef'"],
    ['a backtick at the end', 'abcdef`'],
    ['a "Bearer " prefix', 'Bearer abcdef'],
    ['a "bearer:" prefix', 'bearer:abcdef'],
    ['a NAME=value line', 'EXPO_ACCESS_TOKEN=abcdef'],
    ['another NAME=value line', 'TOKEN=abcdef'],
    ['an empty NAME= line', 'EXPO_ACCESS_TOKEN='],
    ['a control character', 'abc\u0007def'],
  ];

  it.each(REFUSED)('refused with %s, naming the setting and never the value: at boot in every mode, and by the adapter', (_label, value) => {
    for (const mode of ['production', 'development', 'test']) {
      let message = '';
      try { assertSafeBootConfig({ NODE_ENV: mode, EXPO_ACCESS_TOKEN: value }); } catch (e) { message = (e as Error).message; }
      expect(message, mode).toContain('EXPO_ACCESS_TOKEN');
      expect(message, mode).not.toContain(value.trim());
      expect(message, mode).not.toContain('abcdef');
    }
    process.env['EXPO_ACCESS_TOKEN'] = value;
    expect(() => new ExpoPushProvider()).toThrow('EXPO_ACCESS_TOKEN');
  });

  it.each([
    ['a plain token', ACCESS],
    ['the base64 alphabet with padding', 'a.b-c_d~e+f/g=='],
    ['any other printable ASCII (the rule never depends on Expo\'s alphabet)', 'abc:def!#$%&*()[]{}<>?@^|\\'],
    ['a quote inside, not around it', 'abc"def'],
    ['a token that only starts like the word', 'bearerless123'],
  ])('accepts %s', (_label, value) => {
    expect(expoAccessToken({ EXPO_ACCESS_TOKEN: value })).toBe(value);
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', EXPO_ACCESS_TOKEN: value })).not.toThrow();
  });

  it('unset, empty and blank are no token at all (pushes go as before)', () => {
    expect(expoAccessToken({})).toBeNull();
    expect(expoAccessToken({ EXPO_ACCESS_TOKEN: '' })).toBeNull();
    expect(expoAccessToken({ EXPO_ACCESS_TOKEN: ' \n\t' })).toBeNull();
  });

  it('deployed hosts deliver it as a secret file (EXPO_ACCESS_TOKEN_FILE), read into memory at boot', () => {
    const env: Record<string, string | undefined> = { EXPO_ACCESS_TOKEN_FILE: '/run/secrets/EXPO_ACCESS_TOKEN' };
    const read: string[] = [];
    const loaded = applySecretFiles(env, { readFileSync: (path) => { read.push(path); return Buffer.from(`${ACCESS}\n`); } });
    expect(loaded).toContain('EXPO_ACCESS_TOKEN');
    expect(read).toEqual(['/run/secrets/EXPO_ACCESS_TOKEN']);
    expect(env['EXPO_ACCESS_TOKEN']).toBe(ACCESS);
    expect(env['EXPO_ACCESS_TOKEN_FILE']).toBeUndefined();
    expect(expoAccessToken(env)).toBe(ACCESS);
  });
});

describe('[EXPO-PUSH-AUTH] the token only travels over https', () => {
  it.each([
    ['plain http to another host', 'http://exp.host/--/api/v2/push/send'],
    ['another scheme', 'ftp://exp.host/--/api/v2/push/send'],
    ['not a URL', 'exp.host/send'],
  ])('with a token set, %s is refused at boot (every mode) and by the adapter, naming EXPO_PUSH_URL', (_label, url) => {
    for (const mode of ['production', 'development', 'test']) {
      let message = '';
      try { assertSafeBootConfig({ NODE_ENV: mode, EXPO_ACCESS_TOKEN: ACCESS, EXPO_PUSH_URL: url }); } catch (e) { message = (e as Error).message; }
      expect(message, mode).toContain('EXPO_PUSH_URL');
      expect(message, mode).not.toContain(ACCESS);
    }
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    vi.stubEnv('EXPO_PUSH_URL', url);
    expect(() => new ExpoPushProvider()).toThrow('EXPO_PUSH_URL');
  });

  it.each([
    ['the default (https)', undefined],
    ['another https endpoint', 'https://push.example.test/--/api/v2/push/send'],
    ['plain http to this machine (tests)', 'http://127.0.0.1:4010/--/api/v2/push/send'],
    ['plain http to localhost (tests)', 'http://localhost:4010/--/api/v2/push/send'],
  ])('with a token set, %s is allowed', (_label, url) => {
    const env: Record<string, string | undefined> = { NODE_ENV: 'development', EXPO_ACCESS_TOKEN: ACCESS, EXPO_PUSH_URL: url };
    expect(() => assertSafeBootConfig(env)).not.toThrow();
    process.env['EXPO_ACCESS_TOKEN'] = ACCESS;
    if (url) vi.stubEnv('EXPO_PUSH_URL', url);
    expect(() => new ExpoPushProvider()).not.toThrow();
  });

  it('with no token, the URL rule does not apply (nothing secret travels): as before', () => {
    expect(() => assertSafeBootConfig({ NODE_ENV: 'development', EXPO_PUSH_URL: 'http://exp.host/--/api/v2/push/send' })).not.toThrow();
    vi.stubEnv('EXPO_PUSH_URL', 'http://exp.host/--/api/v2/push/send');
    expect(() => new ExpoPushProvider()).not.toThrow();
  });
});

describe('[EXPO-PUSH-AUTH] the boot log says whether a token is set, never the value', () => {
  it('set / not set', () => {
    expect(expoPushTokenBootLine({ EXPO_ACCESS_TOKEN: ACCESS })).toBe('expo push token: set');
    expect(expoPushTokenBootLine({})).toBe('expo push token: not set');
    expect(expoPushTokenBootLine({ EXPO_ACCESS_TOKEN: '  ' })).toBe('expo push token: not set');
    expect(expoPushTokenBootLine({ EXPO_ACCESS_TOKEN: ACCESS })).not.toContain(ACCESS.slice(0, 6));
  });

  it('both processes that send pushes print it at start (api server and worker)', () => {
    for (const file of ['server.ts', 'worker.ts']) {
      const text = readFileSync(join(__dirname, '..', file), 'utf8');
      expect(text, file).toMatch(/\.info\(expoPushTokenBootLine\(\)\);/);
    }
  });
});
