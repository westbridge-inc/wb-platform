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

/** [review S2] What the thread held at the tap, so a stored copy can be told from an OLDER identical message:
 *  the ids of this sender's messages with these exact words, and the thread's newest message (time and id).
 *  Null when the thread was not loaded at the tap (not read yet, or its read failed): such an item is never hidden
 *  by a re-read; only the send's own answer removes it (a brief twin beats a lost message). */
export type OutboxBaseline = { matchIds: string[]; newestAt: number | null; newestId: string | null };
export type OutboxItem = { localId: string; text: string; state: 'sending' | 'failed'; baseline: OutboxBaseline | null };

let seq = 0;
/** A new message on its way; `baseline` from outboxBaseline at the tap (null: the thread was not loaded). */
export function outboxItem(text: string, baseline: OutboxBaseline | null = null): OutboxItem {
  seq += 1;
  return { localId: `local-${Date.now().toString(36)}-${seq}`, text, state: 'sending', baseline };
}

type Row = { id?: unknown; senderId?: unknown; message?: unknown; text?: unknown; createdAt?: unknown } | null | undefined;
const timeOf = (row: Row): number => (typeof row?.createdAt === 'string' ? new Date(row.createdAt).getTime() : Number.NaN);
const matches = (row: Row, senderId: string, text: string) =>
  row?.senderId === senderId && (row.message ?? row.text) === text && typeof row.id === 'string' && !!row.id;

/** The baseline at the tap, from a LOADED thread (the caller passes null for a thread not loaded). Null too when
 *  the thread holds messages but none with a readable time: "newer than the tap" could not be told. */
export function outboxBaseline(messages: readonly unknown[], senderId: string | undefined, text: string): OutboxBaseline | null {
  let newestAt: number | null = null;
  let newestId: string | null = null;
  for (const m of messages as Row[]) {
    const t = timeOf(m);
    if (!Number.isNaN(t) && (newestAt === null || t >= newestAt)) {
      newestAt = t;
      newestId = typeof m?.id === 'string' ? m.id : null;
    }
  }
  if (newestAt === null && messages.length > 0) return null;
  const matchIds = senderId ? (messages as Row[]).filter((m) => matches(m, senderId, text)).map((m) => m!.id as string) : [];
  return { matchIds, newestAt, newestId };
}

/** Is `row` the server's stored copy of `item`: this sender, these exact words (a copy the server redacted never
 *  matches, so its bubble stays until the send's own answer), an id not in the thread at the tap, and newer than
 *  the thread's newest message at the tap. A message without a readable time is never taken for the copy. */
function isStoredCopy(row: Row, item: OutboxItem, senderId: string): boolean {
  const base = item.baseline;
  if (!base || !matches(row, senderId, item.text) || base.matchIds.includes(row!.id as string)) return false;
  if (base.newestAt === null) return true; // the thread was loaded and empty at the tap: any new match is the copy
  const t = timeOf(row);
  return !Number.isNaN(t) && (t > base.newestAt || (t === base.newestAt && row!.id !== base.newestId));
}

/**
 * [review S3.3 · S2] The outbox items the thread does not yet hold a confirmed stored copy of. A re-read that lands
 * mid-send (or a timed-out send the server stored after all) brings the copy: that bubble goes, so there is no
 * twin and no Retry that would send it twice (the chat API takes no idempotency key). Each stored copy confirms at
 * most one item, oldest first. An item whose thread was not loaded at the tap, or with no confirmed copy, always
 * stays, "sending" or "failed": a message is never lost to a guess.
 */
export function pendingOutbox(messages: readonly unknown[], outbox: readonly OutboxItem[], senderId: string | undefined): OutboxItem[] {
  if (!senderId) return [...outbox];
  const used = new Set<string>();
  return outbox.filter((item) => {
    const copy = (messages as Row[]).find((m) => !used.has(m?.id as string) && isStoredCopy(m, item, senderId));
    if (!copy) return true;
    used.add(copy!.id as string);
    return false;
  });
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
