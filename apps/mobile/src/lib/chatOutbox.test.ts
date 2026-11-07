import { describe, expect, it } from 'vitest';
import { confirmedOutbox, dropOutbox, markOutbox, outboxBaseline, outboxItem, pendingOutbox, settleOutbox, roomMessagesOldestFirst, threadWithOutbox, threadWithSent, type OutboxItem } from './chatOutbox';

// [APP-SPEED 10 · 7 Nov 2026] The pure rules of a chat message sent at the tap (the screen:
// ConversationScreen.outbox.navigation.test.ts; the hooks: hooks/chat.appSpeed.test.ts).
describe('[APP-SPEED 10] the chat outbox', () => {
  it('a new message is "sending", with its own id; it can fail, go again, or go', () => {
    const a = outboxItem('hello');
    const b = outboxItem('hello');
    expect(a).toMatchObject({ text: 'hello', state: 'sending', baseline: null });
    expect(a.localId).not.toBe(b.localId);
    const failed = markOutbox([a, b], a.localId, 'failed');
    expect(failed.map((i) => i.state)).toEqual(['failed', 'sending']);
    expect(dropOutbox(failed, a.localId)).toEqual([b]);
  });

  it('the thread draws the server\'s messages, then this phone\'s on their way', () => {
    const item = outboxItem('on its way');
    expect(threadWithOutbox([{ id: 'm1' }], [item])).toEqual([{ id: 'm1' }, { ...item, outbox: true }]);
  });

  // [review S2] Id-based, never count-based: a stored copy is this sender's exact words with an id the thread did not
  // hold at the tap, newer than the thread's newest message then. Anything short of that keeps the bubble.
  const at = (min: number) => `2026-11-07T15:${String(min).padStart(2, '0')}:00.000Z`;
  const msg = (id: string, senderId: string, message: string, min: number) => ({ id, senderId, message, createdAt: at(min) });

  it('a confirmed stored copy (new id, newer than the tap\'s newest) takes the bubble away, sending or failed', () => {
    const before = [msg('m1', 'me', 'ok', 1), msg('m2', 'them', 'ok', 2)];
    const base = outboxBaseline(before, 'me', 'ok');
    expect(base).toEqual({ matchIds: ['m1'], newestAt: new Date(at(2)).getTime(), newestId: 'm2' });
    const sending = outboxItem('ok', base);
    const failed = { ...outboxItem('at the gate', outboxBaseline(before, 'me', 'at the gate')), state: 'failed' as const };
    expect(pendingOutbox(before, [sending, failed], 'me'), 'nothing stored yet: both drawn').toEqual([sending, failed]);
    const reread = [...before, msg('m3', 'me', 'ok', 3), msg('m4', 'me', 'at the gate', 4)];
    expect(pendingOutbox(reread, [sending, failed], 'me')).toEqual([]);
    expect(threadWithOutbox(reread, [sending, failed], 'me')).toEqual(reread);
    expect(pendingOutbox(reread, [sending], undefined), 'no signed-in sender: nothing is matched away').toEqual([sending]);
  });

  it('a thread not loaded at the tap gives no baseline: that message is never hidden by a re-read', () => {
    const item = { ...outboxItem('on my way', null), state: 'failed' as const };
    const history = [msg('m1', 'me', 'on my way', 1), msg('m9', 'me', 'on my way', 59)];
    expect(pendingOutbox(history, [item], 'me')).toEqual([item]);
  });

  it('a failed item stays when an OLDER identical message arrives (history loading, or scrolled in)', () => {
    const tapThread = [msg('m5', 'them', 'where are you', 5)];
    const item = { ...outboxItem('on my way', outboxBaseline(tapThread, 'me', 'on my way')), state: 'failed' as const };
    const withOlder = [msg('m1', 'me', 'on my way', 1), ...tapThread];
    expect(pendingOutbox(withOlder, [item], 'me'), 'older than the tap\'s newest: not the copy').toEqual([item]);
  });

  it('a full 50-message window that slides: the stored copy pushes an older identical one out and is still recognised', () => {
    const window = Array.from({ length: 50 }, (_, i) => msg(`m${i + 1}`, i === 0 ? 'me' : 'them', i === 0 ? 'ok' : `line ${i}`, i));
    const item = outboxItem('ok', outboxBaseline(window, 'me', 'ok'));
    expect(item.baseline!.matchIds).toEqual(['m1']);
    const slid = [...window.slice(1), { id: 'm51', senderId: 'me', message: 'ok', createdAt: '2026-11-07T15:59:59.000Z' }];
    expect(slid).toHaveLength(50);
    expect(pendingOutbox(slid, [item], 'me')).toEqual([]);
  });

  it('a message of mine already in the thread at the tap is never its copy, even tied with the newest to the millisecond', () => {
    const tap = [msg('m1', 'me', 'ok', 7), msg('m2', 'them', 'right', 7)]; // same server millisecond; m2 listed last
    const item = { ...outboxItem('ok', outboxBaseline(tap, 'me', 'ok')), state: 'failed' as const };
    expect(pendingOutbox(tap, [item], 'me')).toEqual([item]);
  });

  it('a loaded thread whose messages carry no readable time gives no baseline (newer cannot be told)', () => {
    expect(outboxBaseline([{ id: 'm1', senderId: 'them', message: 'hi' }], 'me', 'ok')).toBeNull();
    expect(outboxBaseline([], 'me', 'ok'), 'an empty loaded thread is a baseline').toEqual({ matchIds: [], newestAt: null, newestId: null });
  });

  it('a copy the server redacted (a ride code or PIN taken out) never matches: the bubble stays until the send\'s answer', () => {
    const item = outboxItem('the code is 4821', outboxBaseline([], 'me', 'the code is 4821'));
    const stored = [{ id: 'm1', senderId: 'me', message: 'the code is [removed]', createdAt: at(1) }];
    expect(pendingOutbox(stored, [item], 'me')).toEqual([item]);
  });

  it('one stored copy confirms one item: a send still out claims it before a "Not sent" one; a copy with no readable time confirms nothing', () => {
    const tap = [msg('m1', 'them', 'hi', 1)];
    const first = { ...outboxItem('ok', outboxBaseline(tap, 'me', 'ok')), state: 'failed' as const };
    const second = outboxItem('ok', outboxBaseline(tap, 'me', 'ok'));
    // A copy arriving while "ok" is still out is that send's: the earlier "Not sent" one stays, to be sent.
    expect(pendingOutbox([...tap, msg('m2', 'me', 'ok', 2)], [first, second], 'me')).toEqual([first]);
    expect(confirmedOutbox([...tap, msg('m2', 'me', 'ok', 2)], [first, second], 'me')).toEqual([{ localId: second.localId, copyId: 'm2' }]);
    // Two copies (the timed-out one was stored after all, too): both items are confirmed.
    expect(pendingOutbox([...tap, msg('m2', 'me', 'ok', 2), msg('m3', 'me', 'ok', 3)], [first, second], 'me')).toEqual([]);
    expect(pendingOutbox([...tap, { id: 'm2', senderId: 'me', message: 'ok' }], [first], 'me')).toEqual([first]);
  });

  // [review S3 · double count] A's send failed (never stored); the same words retyped as B, B stored and answered.
  it('failed A, the same words retyped as B, B answered: A is still shown (B\'s copy belongs to B alone)', () => {
    let thread: unknown[] = [msg('m1', 'them', 'leaving now', 0)];
    const A = { ...outboxItem('ok', outboxBaseline(thread, 'me', 'ok')), state: 'failed' as const };
    const B = outboxItem('ok', outboxBaseline(thread, 'me', 'ok'));
    let outbox: OutboxItem[] = [A, B];
    const sent = msg('m2', 'me', 'ok', 1);
    thread = threadWithSent(thread, sent) as unknown[];
    outbox = settleOutbox(outbox, B.localId, sent.id); // B's own answer
    expect(outbox.map((i) => i.localId)).toEqual([A.localId]);
    expect(pendingOutbox(thread, outbox, 'me')).toEqual(outbox);
    expect(pendingOutbox(thread, outbox, 'me')[0]!.state).toBe('failed');
  });

  // [review S3 · comeback] The answer was lost (Not sent) but the server stored it; a re-read confirmed it.
  it('a confirmed item is settled for good: it does not come back after its copy slides out of the 50-message window; the outbox empties', () => {
    const thread = [msg('m1', 'them', 'leaving now', 0)];
    const C = { ...outboxItem('see you', outboxBaseline(thread, 'me', 'see you')), state: 'failed' as const };
    let outbox: OutboxItem[] = [C];
    const reread = [...thread, msg('m3', 'me', 'see you', 2)];
    const confirmed = confirmedOutbox(reread, outbox, 'me');
    expect(confirmed).toEqual([{ localId: C.localId, copyId: 'm3' }]);
    outbox = confirmed.reduce((acc, c) => settleOutbox(acc, c.localId, c.copyId), outbox);
    expect(outbox, 'memory stays bounded: a settled item leaves the state').toEqual([]);
    const later = Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, senderId: 'them', message: 'hi', createdAt: new Date(Date.parse('2026-11-07T16:00:00Z') + i * 1000).toISOString() }));
    expect(pendingOutbox(later, outbox, 'me')).toEqual([]);
    expect(threadWithOutbox(later, outbox, 'me')).toEqual(later);
  });

  it('settling adds the copy to every remaining item\'s baseline, once; an answer with no id just drops the item', () => {
    const A = outboxItem('ok', { matchIds: ['m0'], newestAt: 0, newestId: 'm0' });
    const B = outboxItem('ok', { matchIds: [], newestAt: 0, newestId: 'm0' });
    const N = outboxItem('ok', null);
    const after = settleOutbox(settleOutbox([A, B, N], 'nope', 'm5'), B.localId, 'm5');
    expect(after.map((i) => i.localId)).toEqual([A.localId, N.localId]);
    expect(after[0]!.baseline!.matchIds).toEqual(['m0', 'm5']);
    expect(after[1]!.baseline).toBeNull();
    expect(settleOutbox([A, B], A.localId, undefined)).toEqual([B]);
  });

  it('the room\'s page (newest first) seeds the thread oldest first; a room with no list seeds nothing', () => {
    expect(roomMessagesOldestFirst({ id: 'room-1', messages: [{ id: 'm3' }, { id: 'm2' }, { id: 'm1' }] })).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
    expect(roomMessagesOldestFirst({ id: 'room-1' })).toBeNull();
    expect(roomMessagesOldestFirst(null)).toBeNull();
  });

  it('the server\'s stored copy of a sent message joins the thread once, at the end', () => {
    const sent = { id: 'm2', message: 'hi' };
    expect(threadWithSent([{ id: 'm1' }], sent)).toEqual([{ id: 'm1' }, sent]);
    expect(threadWithSent([{ id: 'm1' }, sent], sent)).toEqual([{ id: 'm1' }, sent]);
    expect(threadWithSent({ messages: [{ id: 'm1' }] }, sent)).toEqual({ messages: [{ id: 'm1' }, sent] });
    expect(threadWithSent(undefined, sent), 'a thread never read is left to its read').toBeUndefined();
    expect(threadWithSent([{ id: 'm1' }], { message: 'no id' })).toEqual([{ id: 'm1' }]);
  });
});
