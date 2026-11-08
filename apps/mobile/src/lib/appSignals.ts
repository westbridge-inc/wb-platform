// ---------------------------------------------------------------------------
// [STORE-ALERT-RECONNECT] Two app-wide moments the live alert layers act on:
// the app came back to the screen, and a push arrived while it is on screen.
//
// One installer (services/appSignals.ts) turns the native events into these
// signals; the layers (the realtime socket, the store's new-order screen, a
// mover's offer card) subscribe here. This module imports nothing native, so
// every layer and its tests can use it as it is.
// ---------------------------------------------------------------------------

export type ForegroundPushData = Record<string, unknown>;

const foregroundListeners = new Set<() => void>();
const pushListeners = new Set<(data: ForegroundPushData) => void>();

/** Called each time the app returns to the screen. Returns the unsubscribe. */
export function onAppForeground(listener: () => void): () => void {
  foregroundListeners.add(listener);
  return () => { foregroundListeners.delete(listener); };
}

/** Called with the data of each push that arrives while the app is on screen. */
export function onForegroundPush(listener: (data: ForegroundPushData) => void): () => void {
  pushListeners.add(listener);
  return () => { pushListeners.delete(listener); };
}

export function emitAppForeground(): void {
  for (const listener of [...foregroundListeners]) {
    try { listener(); } catch { /* one layer never stops the others */ }
  }
}

export function emitForegroundPush(data: unknown): void {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  for (const listener of [...pushListeners]) {
    try { listener(data as ForegroundPushData); } catch { /* one layer never stops the others */ }
  }
}
