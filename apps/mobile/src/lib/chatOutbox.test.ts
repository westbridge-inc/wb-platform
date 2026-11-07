import { describe, expect, it } from 'vitest';
import { dropOutbox, markOutbox, outboxItem, pendingOutbox, roomMessagesOldestFirst, storedCopies, threadWithOutbox, threadWithSent } from './chatOutbox';

// [APP-SPEED 10 · 7 Nov 2026] The pure rules of a chat message sent at the tap (the screen:
// ConversationScreen.outbox.navigation.test.ts; the hooks: hooks/chat.appSpeed.test.ts).
describe('[APP-SPEED 10] the chat outbox', () => {
  it('a new message is "sending", with its own id; it can fail, go again, or go', () => {
    const a = outboxItem('hello');
    const b = outboxItem('hello');
    expect(a).toMatchObject({ text: 'hello', state: 'sending', seen: 0 });
    expect(a.localId).not.toBe(b.localId);
    const failed = markOutbox([a, b], a.localId, 'failed');
    expect(failed.map((i) => i.state)).toEqual(['failed', 'sending']);
    expect(dropOutbox(failed, a.localId)).toEqual([b]);
  });

  it('the thread draws the server\'s messages, then this phone\'s on their way', () => {
    const item = outboxItem('on its way');
    expect(threadWithOutbox([{ id: 'm1' }], [item])).toEqual([{ id: 'm1' }, { ...item, outbox: true }]);
  });

  it('[review S3.3] a message the thread already holds a stored copy of is never drawn twice, nor offered for Retry', () => {
    const before = [{ id: 'm1', senderId: 'me', message: 'ok' }, { id: 'm2', senderId: 'them', message: 'ok' }];
    const seen = storedCopies(before, 'me', 'ok');
    expect(seen, 'only this sender, these exact words').toBe(1);
    const sending = outboxItem('ok', seen);
    const failed = { ...outboxItem('at the gate', 0), state: 'failed' as const };
    expect(pendingOutbox(before, [sending, failed], 'me'), 'nothing stored yet: both drawn').toEqual([sending, failed]);
    const reread = [...before, { id: 'm3', senderId: 'me', message: 'ok' }, { id: 'm4', senderId: 'me', message: 'at the gate' }];
    expect(pendingOutbox(reread, [sending, failed], 'me'), 'the re-read holds both: neither drawn').toEqual([]);
    expect(threadWithOutbox(reread, [sending, failed], 'me')).toEqual(reread);
    expect(pendingOutbox(reread, [sending], undefined), 'no signed-in sender: nothing is matched away').toEqual([sending]);
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
