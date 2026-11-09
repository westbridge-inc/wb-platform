import { io, Socket } from 'socket.io-client';
import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import {
  authSessionForPrincipal,
  samePrincipalBoundary,
  type AuthPrincipalBoundary,
} from '../lib/authSession';
import { API_URL, refreshSessionAhead } from './api';
import { canTeardownRuntime } from '../lib/runtimeOwnership';
import { onAppForeground } from '../lib/appSignals';
import { accessTokenExpiresAt } from '../lib/sessionRefreshAhead';

// The realtime socket rides the SAME origin as the REST API — including the
// EXPO_PUBLIC_API_URL override — so a staging/preview EAS build repoints both at
// once. The previous `__DEV__ ? localhost : api.swiftgy.com` hardcode had no env
// escape hatch, so a non-prod build could never reach a non-prod socket.
// Read API_URL when connecting: store handoffs now load this module during
// API/auth initialization, before the API export is necessarily initialized.

let socket: Socket | null = null;
let socketOwner: AuthPrincipalBoundary | null = null;

// ---------------------------------------------------------------------------
// [STORE-ALERT-RECONNECT] Coming back by itself.
//
// Socket.IO retries a dropped network connection on its own, but never two
// cases: the server ending the connection ('io server disconnect'), and the
// server refusing the handshake (connect_error). Older APIs ended every
// connection that way when its access token was refreshed (about every 14
// minutes) or lapsed, so a store's ringing new-order screen and a mover's live
// offers went silent 14 minutes after the app opened, until it was restarted.
// The API now closes those connections reconnectably; this side comes back in
// every case, with backoff, presenting the token the app holds NOW (the auth
// callback below), refreshed through the app's one refresh when the server
// refused the one it was shown, and at once when the app returns to the screen.
// Every layer's 'connect' handler rejoins its rooms (store, order, chat).
// ---------------------------------------------------------------------------

export const SOCKET_RETRY_BASE_MS = 1_000;
export const SOCKET_RETRY_MAX_MS = 30_000;
/** Refused credentials in a row before the socket waits for the app to return
 *  to the screen, or for a new token, instead of asking again. */
export const SOCKET_CREDENTIAL_RETRIES = 6;
/** Server disconnects in a row (admitted, then ended before the connection
 *  settled) before the socket waits the same way. Never a loop of handshakes. */
export const SOCKET_SERVER_DISCONNECT_RETRIES = 6;
/** A connection is settled once it has been authorized ('auth:ready') and has
 *  stayed up this long: only then does the backoff start again from the bottom. */
export const SOCKET_SETTLED_MS = 30_000;
/** Room joins wait for the server's 'auth:ready' (the server holds at most four
 *  packets before it, then ends the connection). A server that never says it
 *  (an older API) gets them this long after the connect. */
export const SOCKET_AUTH_READY_FALLBACK_MS = 10_000;
/** The most emits held for 'auth:ready' (duplicates collapse first). */
export const SOCKET_HELD_EMITS_MAX = 64;

/** The handshake refusals that are a verdict on the credential (plugins/socket.ts). */
const CREDENTIAL_REFUSALS = new Set(['Authentication required', 'Invalid or expired token', 'Session revoked or expired']);
/** A verdict on the ACCOUNT (suspended): asking again cannot change it, so the
 *  socket waits for the app to return to the screen or for a new token. */
const ACCOUNT_REFUSALS = new Set(['Account not active']);

type RetryMode = 'plain' | 'credential' | 'resume';

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let credentialRefusals = 0;
let serverDisconnects = 0;
let parked = false;
let settledTimer: ReturnType<typeof setTimeout> | null = null;
// [review S2] Emits wait for 'auth:ready' on each connection.
let authorized = false;
let held: Array<{ event: string; args: unknown[] }> = [];
let authFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let sendNow: ((event: string, ...args: unknown[]) => unknown) | null = null;
/** The access token the last handshake presented (to tell a refused token from a newer one). */
let presentedToken: string | null = null;
/** [S4-1] The token this wake's refresh produced. Refused too, it is shown again with backoff, never
 *  refreshed again: a server refusing tokens it just issued (a fault on its side) costs one refresh
 *  per wake, not one per retry. A wake = a new socket, the screen, a new token, a settled connection. */
let refreshedTo: string | null = null;
let stopForeground: (() => void) | null = null;
let stopTokenWatch: (() => void) | null = null;

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function resetRetries() {
  clearRetry();
  retryAttempt = 0;
  credentialRefusals = 0;
  serverDisconnects = 0;
  parked = false;
  refreshedTo = null;
}

function clearConnectionTimers() {
  if (settledTimer) clearTimeout(settledTimer);
  settledTimer = null;
  if (authFallbackTimer) clearTimeout(authFallbackTimer);
  authFallbackTimer = null;
}

function sameEmit(a: { event: string; args: unknown[] }, b: { event: string; args: unknown[] }): boolean {
  if (a.event !== b.event || a.args.some((x) => typeof x === 'function') || b.args.some((x) => typeof x === 'function')) return false;
  try {
    return JSON.stringify(a.args) === JSON.stringify(b.args);
  } catch {
    return false;
  }
}

function hold(event: string, args: unknown[]) {
  const next = { event, args };
  // A join emitted while down and again by the layer's 'connect' handler is one
  // join. The latest copy keeps its place, so join -> leave -> join ends joined.
  held = held.filter((h) => !sameEmit(h, next));
  held.push(next);
  while (held.length > SOCKET_HELD_EMITS_MAX) held.shift();
}

function releaseHeld(s: Socket) {
  if (s !== socket || !s.connected) return;
  authorized = true;
  if (authFallbackTimer) clearTimeout(authFallbackTimer);
  authFallbackTimer = null;
  const out = held;
  held = [];
  for (const { event, args } of out) sendNow?.(event, ...args);
}

function ownedSession() {
  const current = getAuthSessionSnapshot();
  return socketOwner && current && samePrincipalBoundary(socketOwner, current) ? current : null;
}

function tokenLapsed(accessToken: string): boolean {
  const expiresAt = accessTokenExpiresAt(accessToken);
  return expiresAt !== null && expiresAt <= Date.now();
}

async function reconnectNow(s: Socket, mode: RetryMode): Promise<void> {
  retryTimer = null;
  if (s !== socket || s.connected || s.active) return;
  let current = ownedSession();
  // Signed out, or another account: connectSocket/disconnectSocket own that.
  if (!current) return;
  const refused = mode === 'credential' && current.accessToken === presentedToken;
  // [review S4] ...unless that token has since lapsed: a lapsed token is refused for certain.
  const alreadyRefreshed = refreshedTo !== null && current.accessToken === refreshedTo && !tokenLapsed(current.accessToken);
  if (!alreadyRefreshed && (refused || tokenLapsed(current.accessToken))) {
    // The app's one refresh (single-flight with the 401 path and the refresh
    // ahead). A refresh the server refuses signs the session out, and the
    // sign-out retires this socket; one that could not be reached is retried.
    const outcome = await refreshSessionAhead(current).catch(() => null);
    if (s !== socket || s.connected || s.active) return;
    current = ownedSession();
    if (!current) return;
    if (!outcome && (current.accessToken === presentedToken || tokenLapsed(current.accessToken))) {
      scheduleReconnect(s, 'credential');
      return;
    }
    if (outcome) refreshedTo = current.accessToken;
  }
  s.connect();
}

function scheduleReconnect(s: Socket, mode: RetryMode, cause: 'refused' | 'server' | 'other' = 'other'): void {
  if (s !== socket || !socketOwner) return;
  clearRetry();
  if (mode === 'credential') {
    credentialRefusals += 1;
    if (credentialRefusals > SOCKET_CREDENTIAL_RETRIES) {
      parked = true;
      return;
    }
  }
  if (cause === 'server') {
    // [review S2] Admitted, then ended before the connection settled: a server
    // that keeps doing that is not asked again and again (each try is a full
    // handshake and its database reads). Counted like refused credentials.
    serverDisconnects += 1;
    if (serverDisconnects > SOCKET_SERVER_DISCONNECT_RETRIES) {
      parked = true;
      return;
    }
  }
  const step = Math.min(SOCKET_RETRY_MAX_MS, SOCKET_RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 10));
  retryAttempt += 1;
  // Spread the fleet: never every phone at the same instant after a deploy.
  const delay = Math.round(step / 2 + Math.random() * (step / 2));
  retryTimer = setTimeout(() => { void reconnectNow(s, mode); }, delay);
}

/** The app is back on the screen: a socket that is down comes back now. */
function onForeground() {
  const s = socket;
  if (!s || !ownedSession()) return;
  if (s.connected || s.active) return;
  resetRetries();
  void reconnectNow(s, 'resume');
}

function watchSocket(s: Socket) {
  // [review S2] Every emit waits for this connection's 'auth:ready'. The server
  // holds at most four packets before it and ends the connection on the fifth,
  // and the layers rejoin on 'connect' (a rider's stacked jobs, a chat, a
  // store): sent at once, they could end every connection, forever.
  if (typeof s.emit === 'function') {
    const raw = s.emit.bind(s) as (event: string, ...args: unknown[]) => unknown;
    sendNow = raw;
    s.emit = ((event: string, ...args: unknown[]) => {
      if (s !== socket || (authorized && s.connected)) return raw(event, ...args);
      hold(event, args);
      return s;
    }) as Socket['emit'];
  }
  s.on('connect', () => {
    if (s !== socket) return;
    // NOT a reset of the backoff: a server can admit the handshake and end the
    // connection a moment later. That waits for a settled connection.
    authorized = false;
    clearConnectionTimers();
    authFallbackTimer = setTimeout(() => releaseHeld(s), SOCKET_AUTH_READY_FALLBACK_MS);
  });
  s.on('auth:ready', () => {
    if (s !== socket) return;
    releaseHeld(s);
    if (settledTimer) clearTimeout(settledTimer);
    settledTimer = setTimeout(() => {
      settledTimer = null;
      if (s === socket && s.connected) resetRetries();
    }, SOCKET_SETTLED_MS);
  });
  s.on('disconnect', (reason) => {
    if (s !== socket) return;
    authorized = false;
    clearConnectionTimers();
    // Only the server's own disconnect is left to us: a network drop is
    // retried by Socket.IO itself, and 'io client disconnect' was asked for.
    if (reason === 'io server disconnect') scheduleReconnect(s, 'plain', 'server');
  });
  s.on('connect_error', (error: Error) => {
    if (s !== socket) return;
    // Still active = Socket.IO is retrying the network itself.
    if (s.active) return;
    if (ACCOUNT_REFUSALS.has(error?.message)) {
      clearRetry();
      parked = true;
      return;
    }
    scheduleReconnect(s, CREDENTIAL_REFUSALS.has(error?.message) ? 'credential' : 'plain');
  });
  if (!stopForeground) stopForeground = onAppForeground(onForeground);
  if (!stopTokenWatch) {
    try {
      // A parked socket wakes when the app holds a new token (a refresh by
      // the refresh ahead or the 401 path), not only at the next foreground.
      let lastToken = getAuthSessionSnapshot()?.accessToken ?? null;
      stopTokenWatch = useAuthStore.subscribe(() => {
        const token = getAuthSessionSnapshot()?.accessToken ?? null;
        if (token === lastToken) return;
        lastToken = token;
        const live = socket;
        if (!token || !parked || !live || live.connected || live.active || !ownedSession()) return;
        resetRetries();
        void reconnectNow(live, 'plain');
      });
    } catch { /* no store subscription: the foreground still wakes it */ }
  }
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      // Try polling when a carrier proxy rejects the first WebSocket transport.
      tryAllTransports: true,
      // Callback form: every (re)connection attempt reads the CURRENT access
      // token. A static object froze the login-time token, so any reconnect
      // after a token refresh was rejected forever — an online mover silently
      // stopped receiving dispatch offers after a network blip.
      auth: (cb) => {
        const current = getAuthSessionSnapshot();
        const token = socketOwner
          ? authSessionForPrincipal(current, socketOwner)?.accessToken ?? null
          : null;
        presentedToken = token;
        cb({ token });
      },
    });
    resetRetries();
    clearConnectionTimers();
    presentedToken = null;
    authorized = false;
    held = [];
    sendNow = null;
    watchSocket(socket);
  }
  return socket;
}

export function connectSocket() {
  const current = getAuthSessionSnapshot();
  if (!current) {
    disconnectSocket();
    return;
  }
  if (socketOwner && !samePrincipalBoundary(socketOwner, current)) {
    // A socket carries user-scoped rooms and listeners. Cross-principal reuse
    // is never safe, even though the auth callback itself is generation-bound.
    socket?.disconnect();
    socket = null;
  }
  socketOwner = { generation: current.generation, userId: current.userId };
  const s = getSocket();
  // A socket backing off, or waiting for the screen or a new token, is not
  // hurried by a layer mounting (that would undo the backoff).
  if (!s.connected && !retryTimer && !parked) {
    s.connect();
  }
}

export function disconnectSocket(expectedOwner?: AuthPrincipalBoundary): boolean {
  if (!canTeardownRuntime(socketOwner, expectedOwner)) return false;
  const ownedSocket = socket;
  socket = null;
  socketOwner = null;
  resetRetries();
  clearConnectionTimers();
  authorized = false;
  held = [];
  sendNow = null;
  // `disconnect()` also cancels an in-progress connect/reconnect. Checking
  // only `.connected` leaves an old account's Manager alive between attempts.
  ownedSocket?.disconnect();
  return true;
}

/** A same-account store handoff must leave the old store's server room WITHOUT
 *  discarding the shared socket other mounted layers hold: a mover's dispatch
 *  offers, a customer's live tracking. Rooms belong to one connection and the
 *  server has no vendor-room leave, so reconnect THIS instance. socket.io keeps
 *  listeners on the instance across disconnect()/connect(), and every layer's
 *  'connect' handler re-joins what it still needs. Emits buffered for the
 *  retired connection are dropped, never replayed into the new one. */
export function reconnectSocketForStoreHandoff(): void {
  const current = socket;
  if (!current || !socketOwner) return;
  if (!samePrincipalBoundary(socketOwner, getAuthSessionSnapshot())) {
    // Never reconnect another account's socket under this session.
    disconnectSocket();
    return;
  }
  current.sendBuffer = [];
  current.receiveBuffer = [];
  held = [];
  if (!current.active) return;
  current.disconnect();
  current.connect();
}

// Joins the order's socket room (server verifies the order belongs to this
// user) — the entry point for live `rider:location` / `driver:location` events
// on the tracking screens. GPS UPLOAD stays on the REST PUT /location routes,
// which check entity ownership; there is intentionally no socket upload path.
export function subscribeToOrder(orderId: string) {
  const s = getSocket();
  s.emit('order:subscribe', { orderId });
}
