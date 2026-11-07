type JobFeedSocket = {
  /** socket.io's own flag: true while the connection is up. */
  connected?: boolean;
  emit: (event: string, payload: { orderId: string }) => unknown;
  on: (event: string, callback: (payload?: any) => void) => unknown;
  off: (event: string, callback: (payload?: any) => void) => unknown;
};

/** Order-room events that change what a driver's or rider's live job shows:
 * a status change (the passenger or customer cancels, the store marks the
 * order ready, an admin moves it) or a store prep signal. */
export const MOVER_JOB_EVENTS = ['order:status_changed', 'order:prep_update'] as const;

/**
 * [APP-SPEED 7] The phone's own step, echoed back. A step's answer already puts the job's new status on screen
 * (hooks/mover writeJobStatus) and re-reads the job once; the server then tells the order's room the same news, and
 * that echo re-read the job a second time. For OWN_STEP_ECHO_MS after a step, a status change naming this order and
 * the very status the step answered is that echo and is not re-read. Any other news (another status, a prep signal,
 * another order, or the same status later) re-reads as before.
 */
export const OWN_STEP_ECHO_MS = 2_000;
const ownSteps = new Map<string, { status: string; at: number }>();
export function noteOwnJobStep(orderId: unknown, status: unknown): void {
  if (typeof orderId !== 'string' || !orderId || typeof status !== 'string' || !status) return;
  ownSteps.set(orderId, { status, at: Date.now() });
}
function isOwnStepEcho(payload: { orderId?: unknown; status?: unknown } | undefined): boolean {
  const own = typeof payload?.orderId === 'string' ? ownSteps.get(payload.orderId) : undefined;
  if (!own) return false;
  if (Date.now() - own.at >= OWN_STEP_ECHO_MS) {
    ownSteps.delete(payload!.orderId as string);
    return false;
  }
  return payload?.status === own.status;
}

/** [APP-SPEED 7] Sockets with a live job feed bound. The active job's fallback poll slows only while one of them is
 *  connected: then a change to the job reaches the phone over the room at once, and the poll is the safety net. */
const liveFeeds = new Map<JobFeedSocket, number>();
export function moverJobFeedLive(): boolean {
  for (const socket of liveFeeds.keys()) if (socket.connected === true) return true;
  return false;
}

/**
 * [PERF partner #1] Hear a live job change the moment the server says so.
 *
 * The server already sends every order change to the order's room and lets
 * that order's own driver or rider join it (plugins/socket.ts
 * `order:subscribe`). The partner app never joined, so a cancelled pickup or
 * a ready order reached the job screen only on the next poll (12 s, 30 s on a
 * slow network). Now the app joins the room of each live job and re-reads the
 * job on an event for one of them. [APP-SPEED 7] While the feed is bound and the
 * socket connected, the active job's poll is 30 s (lib/pollPolicy); the phone's
 * own step echo is not re-read (above).
 *
 * Rooms belong to one connection, so it re-joins after every reconnect. It
 * never leaves a room: other screens may hold the same order room, and the
 * server drops a socket from an order it no longer belongs to.
 */
export function bindMoverJobFeed(
  socket: JobFeedSocket,
  orderIds: readonly string[],
  refresh: () => unknown,
): () => void {
  const ids = new Set(orderIds.filter((id) => typeof id === 'string' && id.length > 0));
  if (ids.size === 0) return () => {};
  const join = () => { for (const orderId of ids) socket.emit('order:subscribe', { orderId }); };
  const onEvent = (payload?: { orderId?: unknown }) => {
    if (typeof payload?.orderId === 'string' && ids.has(payload.orderId)) refresh();
  };
  const onStatus = (payload?: { orderId?: unknown; status?: unknown }) => {
    if (isOwnStepEcho(payload)) return;
    onEvent(payload);
  };
  const handlers: Record<(typeof MOVER_JOB_EVENTS)[number], (payload?: any) => void> = {
    'order:status_changed': onStatus,
    'order:prep_update': onEvent,
  };
  join();
  socket.on('connect', join);
  for (const event of MOVER_JOB_EVENTS) socket.on(event, handlers[event]);
  liveFeeds.set(socket, (liveFeeds.get(socket) ?? 0) + 1);
  let bound = true;
  return () => {
    if (!bound) return;
    bound = false;
    socket.off('connect', join);
    for (const event of MOVER_JOB_EVENTS) socket.off(event, handlers[event]);
    const left = (liveFeeds.get(socket) ?? 1) - 1;
    if (left > 0) liveFeeds.set(socket, left);
    else liveFeeds.delete(socket);
  };
}
