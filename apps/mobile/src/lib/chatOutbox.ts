// ---------------------------------------------------------------------------
// [APP-SPEED 10 · 7 Nov 2026] Chat answers at the tap.
//
// A sent message shows in the thread the moment Send is tapped, marked "Sending…" until the server answers. The
// answer (the message as the server stored it, redactions included) then takes its place in the thread; a failed
// send stays in the thread as "Not sent" with Retry, so the words are never lost. A refusal the server names
// (CHAT_CONTENT_NOT_ALLOWED) is not retried: the bubble goes and the words go back into the box, as before.
//
// Pure: the screen keeps the outbox in state, the hook writes the answer into the thread (hooks/chat).
// ---------------------------------------------------------------------------

export type OutboxItem = { localId: string; text: string; state: 'sending' | 'failed' };

let seq = 0;
/** A new message on its way. */
export function outboxItem(text: string): OutboxItem {
  seq += 1;
  return { localId: `local-${Date.now().toString(36)}-${seq}`, text, state: 'sending' };
}

export function markOutbox(items: readonly OutboxItem[], localId: string, state: OutboxItem['state']): OutboxItem[] {
  return items.map((item) => (item.localId === localId ? { ...item, state } : item));
}

export function dropOutbox(items: readonly OutboxItem[], localId: string): OutboxItem[] {
  return items.filter((item) => item.localId !== localId);
}

/** The thread as drawn: the server's messages, then this phone's messages still on their way or not sent. */
export function threadWithOutbox<M>(messages: readonly M[], outbox: readonly OutboxItem[]): Array<M | (OutboxItem & { outbox: true })> {
  return [...messages, ...outbox.map((item) => ({ ...item, outbox: true as const }))];
}

/** The room read (POST /chat/rooms) carries the latest page of messages, newest first; the thread reads oldest first,
 *  like GET /chat/rooms/:id/messages. Null when the room carries no list (an older server): nothing is seeded. */
export function roomMessagesOldestFirst(room: unknown): unknown[] | null {
  const list = (room as { messages?: unknown } | null | undefined)?.messages;
  return Array.isArray(list) ? [...list].reverse() : null;
}

/** The thread with the server's stored copy of a sent message added at the end (once, by id). */
export function threadWithSent(thread: unknown, sent: unknown): unknown {
  const id = (sent as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== 'string' || !id) return thread;
  const list: unknown[] | null = Array.isArray(thread)
    ? thread
    : Array.isArray((thread as { messages?: unknown } | null | undefined)?.messages)
      ? (thread as { messages: unknown[] }).messages
      : null;
  if (!list) return thread;
  if (list.some((m) => (m as { id?: unknown } | null)?.id === id)) return thread;
  const next = [...list, sent];
  return Array.isArray(thread) ? next : { ...(thread as object), messages: next };
}
