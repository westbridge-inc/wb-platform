import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// [STORE-ALERT-RECONNECT · S4-4] The REAL services/socket.ts over the REAL
// socket.io-client against a REAL socket.io server (the API's own copy, the
// same 4.8 line the app and API ship). The other socket tests use a fake
// client; this one pins the library behaviour the reconnect relies on: a
// refused handshake leaves the socket inactive (so the app retries it), a
// closed transport is retried by Socket.IO with the CURRENT token, and room
// joins wait for the server's 'auth:ready'. The server here is a stand-in for
// plugins/socket.ts: it refuses unknown tokens, says 'auth:ready' after a
// moment, and ends a connection that sends more than four packets before it.
// ---------------------------------------------------------------------------

type Session = { generation: number; userId: string; accessToken: string; refreshToken: string };

const fx = vi.hoisted(() => ({
  session: null as Session | null,
  listeners: new Set<() => void>(),
  refresh: (async () => null) as (s: Session) => Promise<unknown>,
  url: '',
}));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => fx.session,
  useAuthStore: { subscribe: (l: () => void) => { fx.listeners.add(l); return () => fx.listeners.delete(l); } },
}));
vi.mock('./api', () => ({
  get API_URL() { return fx.url; },
  refreshSessionAhead: (s: Session) => fx.refresh(s),
}));

import { connectSocket, disconnectSocket, getSocket } from './socket';

const jwt = (expMs: number, tag: string) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), tag })).toString('base64url')}.s`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(20);
  }
}
function rotate(token: string) {
  fx.session = { ...fx.session!, accessToken: token };
  for (const l of [...fx.listeners]) l();
}

// The API's socket.io (apps/api depends on it; the mobile app only on the client).
const apiRequire = createRequire(new URL('../../../api/package.json', import.meta.url));
const valid = new Set<string>();
const got: Array<{ token: string; event: string }> = [];
const conns: any[] = [];
let io: any;
let http: HttpServer;

beforeAll(async () => {
  const { Server } = await import(apiRequire.resolve('socket.io'));
  http = createServer();
  io = new Server(http);
  io.use((s: any, next: (e?: Error) => void) => {
    const token = s.handshake.auth?.token;
    if (!token || !valid.has(token)) return next(new Error('Session revoked or expired'));
    s.data.token = token;
    return next();
  });
  io.on('connection', (s: any) => {
    conns.push(s);
    let ready = false;
    let early = 0;
    s.use((_packet: unknown, next: (e?: Error) => void) => {
      if (ready) return next();
      early += 1;
      if (early > 4) { s.disconnect(true); return undefined; }
      return next(new Error('not ready'));
    });
    s.onAny((event: string) => got.push({ token: s.data.token, event }));
    setTimeout(() => { ready = true; s.emit('auth:ready', {}); }, 150);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  fx.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  disconnectSocket();
  io?.close();
  await new Promise((r) => http?.close(() => r(undefined)));
});

describe('[S4-4] real socket.io-client + real socket.io server', () => {
  it('joins after auth:ready; back on the new token after a transport close and a server disconnect; refused -> one refresh -> back; signed out -> stays down', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // the shortest wait of each backoff step
    const joinsWith = (token: string) => got.filter((g) => g.token === token && g.event === 'vendor:subscribe').length;
    const t1 = jwt(Date.now() + 15 * 60_000, 't1');
    valid.add(t1);
    fx.session = { generation: 1, userId: 'store-owner', accessToken: t1, refreshToken: 'r' };
    connectSocket();
    const s = getSocket();
    const join = () => { s.emit('vendor:subscribe', { vendorId: 'v1' }); };
    join();
    s.on('connect', join);
    await until(() => joinsWith(t1) > 0);
    await wait(100);
    expect(got.filter((g) => g.token === t1)).toEqual([{ token: t1, event: 'vendor:subscribe' }]); // once, after auth:ready

    // 1) A token refresh; the server closes the transport reconnectably: Socket.IO comes back on the NEW token.
    const t2 = jwt(Date.now() + 15 * 60_000, 't2');
    valid.add(t2); valid.delete(t1); rotate(t2);
    conns.at(-1).client.conn.close(true);
    await until(() => joinsWith(t2) > 0);
    expect(joinsWith(t2)).toBe(1);

    // 2) An older server ends the connection instead ('io server disconnect'): the app comes back itself.
    const t3 = jwt(Date.now() + 15 * 60_000, 't3');
    valid.add(t3); valid.delete(t2); rotate(t3);
    conns.at(-1).disconnect(true);
    await until(() => joinsWith(t3) > 0);

    // 3) The server refuses the token the app shows: a refused handshake leaves the socket inactive,
    //    the app refreshes once and comes back on the refreshed token.
    const t4 = jwt(Date.now() + 15 * 60_000, 't4');
    const refresh = vi.fn(async () => { valid.add(t4); rotate(t4); return { accessToken: t4, session: fx.session }; });
    fx.refresh = refresh;
    valid.delete(t3);
    conns.at(-1).client.conn.close(true);
    await until(() => joinsWith(t4) > 0, 15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(s.connected).toBe(true);

    // 4) Signed out: nothing reconnects.
    fx.session = null;
    disconnectSocket();
    const before = conns.length;
    await wait(2_500);
    expect(conns.length).toBe(before);
  }, 30_000);
});
