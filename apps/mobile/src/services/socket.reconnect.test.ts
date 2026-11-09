import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [STORE-ALERT-RECONNECT] The phone's socket comes back by itself.
//
// Socket.IO retries a dropped network on its own, but never after the server
// ends the connection ('io server disconnect') or refuses the handshake
// (connect_error). Older APIs ended every connection that way at each token
// refresh (~14 min), and nothing here reconnected: a store's ringing new-order
// screen and a mover's live offers went silent until the app was restarted.
// These cases drive the REAL services/socket.ts over a fake Socket.IO client.
// ---------------------------------------------------------------------------

type Session = { generation: number; userId: string; accessToken: string; refreshToken: string };

const fx = vi.hoisted(() => ({
  session: null as Session | null,
  storeListeners: new Set<() => void>(),
  refresh: vi.fn(),
  sockets: [] as any[],
}));

vi.mock('socket.io-client', () => {
  class FakeSocket {
    handlers = new Map<string, Set<(...args: any[]) => void>>();
    connected = false;
    active = false;
    connectCalls = 0;
    presented: Array<string | null> = [];
    sendBuffer: unknown[] = [];
    receiveBuffer: unknown[] = [];
    constructor(public opts: any) {}
    on(event: string, cb: (...args: any[]) => void) {
      (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event)!).add(cb);
      return this;
    }
    off(event: string, cb: (...args: any[]) => void) { this.handlers.get(event)?.delete(cb); return this; }
    sent: unknown[][] = [];
    emit(...args: unknown[]) { this.sent.push(args); return this; }
    connect() {
      this.connectCalls += 1;
      this.active = true;
      this.opts.auth((data: { token: string | null }) => { this.presented.push(data.token); });
      return this;
    }
    disconnect() {
      const was = this.connected;
      this.active = false;
      this.connected = false;
      if (was) this.fire('disconnect', 'io client disconnect');
      return this;
    }
    fire(event: string, ...args: any[]) { for (const cb of [...(this.handlers.get(event) ?? [])]) cb(...args); }
    // What Socket.IO does on each server verdict.
    admitted() { this.connected = true; this.active = true; this.fire('connect'); }
    authorized() { this.fire('auth:ready', { expiresAt: 'later' }); }
    serverDisconnect() { this.connected = false; this.active = false; this.fire('disconnect', 'io server disconnect'); }
    refusedAtHandshake(message: string) { this.connected = false; this.active = false; this.fire('connect_error', new Error(message)); }
  }
  return {
    io: (_url: string, opts: any) => {
      const s = new FakeSocket(opts);
      fx.sockets.push(s);
      return s;
    },
  };
});
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => fx.session,
  useAuthStore: {
    subscribe: (listener: () => void) => {
      fx.storeListeners.add(listener);
      return () => fx.storeListeners.delete(listener);
    },
  },
}));
vi.mock('./api', () => ({ API_URL: 'https://api.test', refreshSessionAhead: (s: Session) => fx.refresh(s) }));

import {
  connectSocket,
  disconnectSocket,
  getSocket,
  reconnectSocketForStoreHandoff,
  SOCKET_AUTH_READY_FALLBACK_MS,
  SOCKET_CREDENTIAL_RETRIES,
  SOCKET_RETRY_MAX_MS,
  SOCKET_SERVER_DISCONNECT_RETRIES,
  SOCKET_SETTLED_MS,
} from './socket';
import { emitAppForeground } from '../lib/appSignals';

const jwt = (expMs: number, tag: string) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), tag })).toString('base64url')}.s`;

function signIn(accessToken: string) {
  fx.session = { generation: 1, userId: 'store-owner', accessToken, refreshToken: 'r1' };
}
function rotate(accessToken: string) {
  fx.session = { ...fx.session!, accessToken };
  for (const l of [...fx.storeListeners]) l();
}
function live() {
  connectSocket();
  const s = fx.sockets.at(-1);
  s.admitted();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-08T12:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(1); // the longest delay of each step
  fx.refresh.mockReset();
  fx.sockets.length = 0;
  signIn(jwt(Date.now() + 15 * 60_000, 'first'));
});
afterEach(() => {
  disconnectSocket();
  fx.session = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('[STORE-ALERT-RECONNECT] the server ended the connection', () => {
  it('comes back by itself after "io server disconnect", with the token the app holds NOW', async () => {
    const s = live();
    expect(s.presented).toEqual([fx.session!.accessToken]);
    const fresh = jwt(Date.now() + 15 * 60_000, 'fresh');
    rotate(fresh);
    s.serverDisconnect();
    expect(s.connectCalls).toBe(1); // RED before: never again
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.connectCalls).toBe(2);
    expect(s.presented.at(-1)).toBe(fresh);
    expect(fx.refresh).not.toHaveBeenCalled();
  });

  it('a network drop and a disconnect the app asked for are left alone (Socket.IO retries the network itself)', async () => {
    const s = live();
    s.connected = false;
    s.fire('disconnect', 'transport close');
    s.fire('disconnect', 'io client disconnect');
    await vi.advanceTimersByTimeAsync(SOCKET_RETRY_MAX_MS * 2);
    expect(s.connectCalls).toBe(1);
  });

  it('a lapsed token is refreshed through the app\'s one refresh before it is presented', async () => {
    const s = live();
    const fresh = jwt(Date.now() + 15 * 60_000, 'after-refresh');
    fx.refresh.mockImplementation(async () => { rotate(fresh); return { accessToken: fresh, session: fx.session }; });
    vi.setSystemTime(Date.now() + 16 * 60_000); // the first token is now past its exp
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fx.refresh).toHaveBeenCalledTimes(1);
    expect(s.presented.at(-1)).toBe(fresh);
  });
});

describe('[STORE-ALERT-RECONNECT] the handshake was refused', () => {
  it('a refused token is refreshed, then presented again (the new one)', async () => {
    const s = live();
    const refusedToken = fx.session!.accessToken;
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.presented.at(-1)).toBe(refusedToken);
    const fresh = jwt(Date.now() + 15 * 60_000, 'after-refusal');
    fx.refresh.mockImplementation(async () => { rotate(fresh); return { accessToken: fresh, session: fx.session }; });
    s.refusedAtHandshake('Session revoked or expired');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fx.refresh).toHaveBeenCalledTimes(1);
    expect(s.presented.at(-1)).toBe(fresh);
  });

  it('when the app already holds a newer token than the refused one, it is presented without another refresh', async () => {
    const s = live();
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    rotate(jwt(Date.now() + 15 * 60_000, 'newer'));
    s.refusedAtHandshake('Invalid or expired token');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fx.refresh).not.toHaveBeenCalled();
    expect(s.presented.at(-1)).toBe(fx.session!.accessToken);
  });

  it('an unreachable authority store is retried with growing backoff, capped, and never refreshes', async () => {
    const s = live();
    s.serverDisconnect();
    const gaps: number[] = [];
    let last = Date.now();
    for (let i = 0; i < 8; i += 1) {
      const before = s.connectCalls;
      while (s.connectCalls === before) await vi.advanceTimersByTimeAsync(250);
      gaps.push(Date.now() - last);
      last = Date.now();
      s.refusedAtHandshake('Authorization temporarily unavailable');
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(fx.refresh).not.toHaveBeenCalled();
  });

  it('a network failure while Socket.IO is still retrying is left to Socket.IO', async () => {
    const s = live();
    s.connected = false;
    s.active = true;
    s.fire('connect_error', new Error('websocket error'));
    await vi.advanceTimersByTimeAsync(SOCKET_RETRY_MAX_MS * 2);
    expect(s.connectCalls).toBe(1);
  });

  it('refused credentials that no refresh can fix stop after a bounded number of tries, then wake on the screen or a new token', async () => {
    signIn(jwt(Date.now() + 24 * 60 * 60_000, 'long-lived')); // still unexpired after the half hour below
    const s = live();
    fx.refresh.mockResolvedValue(null); // offline: no new token, no sign-out
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < SOCKET_CREDENTIAL_RETRIES + 3; i += 1) {
      s.refusedAtHandshake('Session revoked or expired');
      await vi.advanceTimersByTimeAsync(SOCKET_RETRY_MAX_MS * 4);
    }
    const parkedAt = s.connectCalls;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.connectCalls).toBe(parkedAt); // no loop
    expect(fx.refresh.mock.calls.length).toBeLessThanOrEqual(SOCKET_CREDENTIAL_RETRIES + 1);

    emitAppForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connectCalls).toBe(parkedAt + 1);

    s.refusedAtHandshake('Session revoked or expired');
    for (let i = 0; i < SOCKET_CREDENTIAL_RETRIES + 3; i += 1) {
      await vi.advanceTimersByTimeAsync(SOCKET_RETRY_MAX_MS * 4);
      if (s.active) s.refusedAtHandshake('Session revoked or expired');
    }
    const parkedAgain = s.connectCalls;
    rotate(jwt(Date.now() + 15 * 60_000, 'refreshed-elsewhere'));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connectCalls).toBe(parkedAgain + 1);
    expect(s.presented.at(-1)).toBe(fx.session!.accessToken);
  });

  it('a suspended account is not asked about again until the app returns to the screen', async () => {
    const s = live();
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    s.refusedAtHandshake('Account not active');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.connectCalls).toBe(2);
    expect(fx.refresh).not.toHaveBeenCalled();
  });
});

describe('[STORE-ALERT-RECONNECT] the app returns to the screen', () => {
  it('a socket that is down comes back at once', async () => {
    const s = live();
    s.serverDisconnect();
    emitAppForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connectCalls).toBe(2);
  });

  it('a connected (or reconnecting) socket is left as it is', async () => {
    const s = live();
    emitAppForeground();
    s.connected = false;
    s.active = true;
    emitAppForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connectCalls).toBe(1);
  });
});

describe('[STORE-ALERT-RECONNECT] never across a sign-out', () => {
  it('signed out before the retry: nothing reconnects', async () => {
    const s = live();
    s.serverDisconnect();
    fx.session = null;
    await vi.advanceTimersByTimeAsync(SOCKET_RETRY_MAX_MS * 2);
    emitAppForeground();
    expect(s.connectCalls).toBe(1);
  });

  it('another account signed in: the old socket is never reconnected', async () => {
    const s = live();
    s.serverDisconnect();
    fx.session = { generation: 2, userId: 'someone-else', accessToken: jwt(Date.now() + 60_000, 'b'), refreshToken: 'rb' };
    await vi.advanceTimersByTimeAsync(SOCKET_RETRY_MAX_MS * 2);
    emitAppForeground();
    expect(s.connectCalls).toBe(1);
  });

  it('disconnectSocket cancels a retry that is waiting', async () => {
    const s = live();
    s.serverDisconnect();
    disconnectSocket();
    await vi.advanceTimersByTimeAsync(SOCKET_RETRY_MAX_MS * 2);
    emitAppForeground();
    expect(s.connectCalls).toBe(1);
  });
});

// [review S2] A server that admits the handshake and then ends the connection (the early-packet cap,
// a credential verdict in the post-registration read) must never be asked again once a second.
describe('[review S2] admitted, then ended: the backoff grows and stops', () => {
  it('admit -> kick, again and again: each wait is longer, and after the cap nothing more until the screen returns', async () => {
    signIn(jwt(Date.now() + 24 * 60 * 60_000, 'long-lived'));
    const s = live();
    const gaps: number[] = [];
    let last = Date.now();
    for (let i = 0; i < SOCKET_SERVER_DISCONNECT_RETRIES + 3; i += 1) {
      s.serverDisconnect(); // ended before 'auth:ready'
      const before = s.connectCalls;
      for (let waited = 0; s.connectCalls === before && waited < 5 * 60_000; waited += 250) await vi.advanceTimersByTimeAsync(250);
      if (s.connectCalls === before) break;
      gaps.push(Date.now() - last);
      last = Date.now();
      s.admitted(); // the handshake is admitted again (RED before: this reset the backoff)
    }
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(gaps).toHaveLength(SOCKET_SERVER_DISCONNECT_RETRIES);
    const parkedAt = s.connectCalls;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    connectSocket(); // a layer mounting does not hurry it
    expect(s.connectCalls).toBe(parkedAt);
    emitAppForeground();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connectCalls).toBe(parkedAt + 1);
  });

  it('a connection that settled (authorized and up 30 s) starts the backoff from the bottom again', async () => {
    const s = live();
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    s.admitted();
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(2_000);
    s.admitted();
    s.authorized();
    await vi.advanceTimersByTimeAsync(SOCKET_SETTLED_MS - 1);
    s.serverDisconnect(); // not settled yet: the next wait is 4 s
    await vi.advanceTimersByTimeAsync(3_999);
    expect(s.connectCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.connectCalls).toBe(4);
    s.admitted();
    s.authorized();
    await vi.advanceTimersByTimeAsync(SOCKET_SETTLED_MS);
    s.serverDisconnect(); // settled: 1 s again
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.connectCalls).toBe(5);
  });

  it('a backing-off socket is not hurried by a layer calling connectSocket', async () => {
    const s = live();
    s.serverDisconnect();
    connectSocket();
    connectSocket();
    expect(s.connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.connectCalls).toBe(2);
  });
});

describe('[review S2] room joins wait for the server\'s auth:ready', () => {
  it('emits before auth:ready are held (duplicates collapse) and sent once it arrives', () => {
    const s = live();
    const sock = getSocket();
    for (const orderId of ['j1', 'j2', 'j3']) sock.emit('order:subscribe', { orderId });
    sock.emit('chat:join', { roomId: 'c1' });
    sock.emit('vendor:subscribe', { vendorId: 'v1' });
    sock.emit('order:subscribe', { orderId: 'j1' }); // the same join again
    expect(s.sent).toEqual([]); // RED before: five packets inside the server's four-packet window
    s.authorized();
    expect(s.sent).toEqual([
      ['order:subscribe', { orderId: 'j2' }],
      ['order:subscribe', { orderId: 'j3' }],
      ['chat:join', { roomId: 'c1' }],
      ['vendor:subscribe', { vendorId: 'v1' }],
      ['order:subscribe', { orderId: 'j1' }],
    ]);
    sock.emit('chat:leave', { roomId: 'c1' });
    expect(s.sent.at(-1)).toEqual(['chat:leave', { roomId: 'c1' }]); // authorized: straight through
  });

  it('each new connection waits again; an older API that never says auth:ready gets them after the fallback', async () => {
    const s = live();
    s.authorized();
    s.connected = false;
    s.fire('disconnect', 'transport close');
    const sock = getSocket();
    sock.emit('vendor:subscribe', { vendorId: 'v1' });
    s.admitted();
    sock.emit('vendor:subscribe', { vendorId: 'v1' });
    expect(s.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(SOCKET_AUTH_READY_FALLBACK_MS);
    expect(s.sent).toEqual([['vendor:subscribe', { vendorId: 'v1' }]]);
  });

  it('join -> leave -> join while waiting ends joined (the latest copy keeps its place)', () => {
    const s = live();
    const sock = getSocket();
    sock.emit('chat:join', { roomId: 'c1' });
    sock.emit('chat:leave', { roomId: 'c1' });
    sock.emit('chat:join', { roomId: 'c1' });
    s.authorized();
    expect(s.sent).toEqual([['chat:leave', { roomId: 'c1' }], ['chat:join', { roomId: 'c1' }]]);
  });

  it('a store handoff drops the joins held for the retired connection', () => {
    const s = live();
    getSocket().emit('vendor:subscribe', { vendorId: 'old-store' });
    reconnectSocketForStoreHandoff();
    s.admitted();
    s.authorized();
    expect(s.sent).toEqual([]);
  });
});

// [S4-1] A server refusing the token the app has just been given (a fault on the server's side) is not
// answered with a refresh per retry: one refresh per wake, then the same token again with backoff.
describe('[S4-1] at most one refresh per wake for a refused token', () => {
  it('the token this wake refreshed to is refused again: no second refresh until the app returns to the screen', async () => {
    const s = live();
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    let n = 0;
    fx.refresh.mockImplementation(async () => {
      n += 1;
      rotate(jwt(Date.now() + 15 * 60_000, `minted-${n}`));
      return { accessToken: fx.session!.accessToken, session: fx.session };
    });
    s.refusedAtHandshake('Invalid or expired token');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fx.refresh).toHaveBeenCalledTimes(1);
    const minted = fx.session!.accessToken;
    expect(s.presented.at(-1)).toBe(minted);
    for (let i = 0; i < 3; i += 1) {
      const before = s.connectCalls;
      s.refusedAtHandshake('Invalid or expired token');
      for (let waited = 0; s.connectCalls === before && waited < 5 * 60_000; waited += 250) await vi.advanceTimersByTimeAsync(250);
      expect(s.connectCalls).toBe(before + 1); // still retried, with backoff
      expect(s.presented.at(-1)).toBe(minted);
    }
    expect(fx.refresh).toHaveBeenCalledTimes(1); // RED before: one refresh per refusal
    s.refusedAtHandshake('Invalid or expired token');
    emitAppForeground(); // a new wake: shown at once, and one refresh again if it is refused
    await vi.advanceTimersByTimeAsync(0);
    expect(s.presented.at(-1)).toBe(minted);
    s.refusedAtHandshake('Invalid or expired token');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fx.refresh).toHaveBeenCalledTimes(2);
    expect(s.presented.at(-1)).toBe(fx.session!.accessToken);
    expect(s.presented.at(-1)).not.toBe(minted);
  });
});

describe('[review S4] the refreshed token has since lapsed', () => {
  it('is refreshed again (a lapsed token is refused for certain)', async () => {
    const s = live();
    s.serverDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    let n = 0;
    fx.refresh.mockImplementation(async () => {
      n += 1;
      rotate(jwt(Date.now() + 15 * 60_000, `minted-${n}`));
      return { accessToken: fx.session!.accessToken, session: fx.session };
    });
    s.refusedAtHandshake('Invalid or expired token');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fx.refresh).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 16 * 60_000); // the token this wake refreshed to is now past its exp
    s.refusedAtHandshake('Invalid or expired token');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fx.refresh).toHaveBeenCalledTimes(2);
    expect(s.presented.at(-1)).toBe(fx.session!.accessToken);
  });
});

// [S4-3] Only the current socket's refusals move the retry state.
describe('[S4-3] a retired socket\'s connect_error is ignored', () => {
  it('an "Account not active" from the previous account\'s socket does not stop the new account\'s retry', async () => {
    const a = live();
    signInAs2();
    connectSocket();
    const b = fx.sockets.at(-1);
    expect(b).not.toBe(a);
    b.admitted();
    b.serverDisconnect();
    a.fire('connect_error', new Error('Account not active')); // the retired socket, inactive
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.connectCalls).toBe(2); // RED before: the retry was cleared and the socket parked
  });
});

function signInAs2() {
  fx.session = { generation: 2, userId: 'second-account', accessToken: jwt(Date.now() + 15 * 60_000, 'second'), refreshToken: 'r2' };
}
