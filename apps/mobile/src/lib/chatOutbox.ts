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

/** `seen`: how many of this sender's messages with these exact words the thread held at the tap (see storedCopies). */
export type OutboxItem = { localId: string; text: string; state: 'sending' | 'failed'; seen: number };

let seq = 0;
/** A new message on its way; `seen` from storedCopies at the tap. */
export function outboxItem(text: string, seen = 0): OutboxItem {
  seq += 1;
  return { localId: `local-${Date.now().toString(36)}-${seq}`, text, state: 'sending', seen };
}

/** [review S3.3] How many messages from `senderId` with exactly these words the thread holds. When a re-read brings
 *  more than there were at the tap, the server has stored this message (a socket re-read landed mid-send, or a send
 *  that timed out was stored after all): its outbox bubble goes, so the thread never shows it twice and a
 *  "Not sent" with Retry never sends it again. (The chat API takes no idempotency key, so this is the guard.) */
export function storedCopies(messages: readonly unknown[], senderId: string | undefined, text: string): number {
  if (!senderId) return 0;
  return messages.filter((m) => {
    const row = m as { senderId?: unknown; message?: unknown; text?: unknown } | null;
    return row?.senderId === senderId && (row.message ?? row.text) === text;
  }).length;
}

/** The outbox items the thread does not yet hold a stored copy of. */
export function pendingOutbox(messages: readonly unknown[], outbox: readonly OutboxItem[], senderId: string | undefined): OutboxItem[] {
  return outbox.filter((item) => storedCopies(messages, senderId, item.text) <= item.seen);
}

export function markOutbox(items: readonly OutboxItem[], localId: string, state: OutboxItem['state']): OutboxItem[] {
  return items.map((item) => (item.localId === localId ? { ...item, state } : item));
}

export function dropOutbox(items: readonly OutboxItem[], localId: string): OutboxItem[] {
  return items.filter((item) => item.localId !== localId);
}

/** The thread as drawn: the server's messages, then this phone's messages still on their way or not sent (never
 *  one the thread already holds: pendingOutbox). */
export function threadWithOutbox<M>(messages: readonly M[], outbox: readonly OutboxItem[], senderId?: string): Array<M | (OutboxItem & { outbox: true })> {
  return [...messages, ...pendingOutbox(messages, outbox, senderId).map((item) => ({ ...item, outbox: true as const }))];
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
