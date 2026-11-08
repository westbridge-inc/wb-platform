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

/** The handshake refusals that are a verdict on the credential (plugins/socket.ts). */
const CREDENTIAL_REFUSALS = new Set(['Authentication required', 'Invalid or expired token', 'Session revoked or expired']);
/** A verdict on the ACCOUNT (suspended): asking again cannot change it, so the
 *  socket waits for the app to return to the screen or for a new token. */
const ACCOUNT_REFUSALS = new Set(['Account not active']);

type RetryMode = 'plain' | 'credential' | 'resume';

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let credentialRefusals = 0;
let parked = false;
/** The access token the last handshake presented (to tell a refused token from a newer one). */
let presentedToken: string | null = null;
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
  parked = false;
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
  if (refused || tokenLapsed(current.accessToken)) {
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
  }
  s.connect();
}

function scheduleReconnect(s: Socket, mode: RetryMode): void {
  if (s !== socket || !socketOwner) return;
  clearRetry();
  if (mode === 'credential') {
    credentialRefusals += 1;
    if (credentialRefusals > SOCKET_CREDENTIAL_RETRIES) {
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
  s.on('connect', () => {
    if (s === socket) resetRetries();
  });
  s.on('disconnect', (reason) => {
    // Only the server's own disconnect is left to us: a network drop is
    // retried by Socket.IO itself, and 'io client disconnect' was asked for.
    if (reason === 'io server disconnect') scheduleReconnect(s, 'plain');
  });
  s.on('connect_error', (error: Error) => {
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
    presentedToken = null;
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
  if (!s.connected) {
    // A layer asking for the socket is a fresh start for a parked or backing-off one.
    if (!s.active) resetRetries();
    s.connect();
  }
}

export function disconnectSocket(expectedOwner?: AuthPrincipalBoundary): boolean {
  if (!canTeardownRuntime(socketOwner, expectedOwner)) return false;
  const ownedSocket = socket;
  socket = null;
  socketOwner = null;
  resetRetries();
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
