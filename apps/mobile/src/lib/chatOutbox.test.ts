import { describe, expect, it } from 'vitest';
import { dropOutbox, markOutbox, outboxItem, roomMessagesOldestFirst, threadWithOutbox, threadWithSent } from './chatOutbox';

// [APP-SPEED 10 · 7 Nov 2026] The pure rules of a chat message sent at the tap (the screen:
// ConversationScreen.outbox.navigation.test.ts; the hooks: hooks/chat.appSpeed.test.ts).
describe('[APP-SPEED 10] the chat outbox', () => {
  it('a new message is "sending", with its own id; it can fail, go again, or go', () => {
    const a = outboxItem('hello');
    const b = outboxItem('hello');
    expect(a).toMatchObject({ text: 'hello', state: 'sending' });
    expect(a.localId).not.toBe(b.localId);
    const failed = markOutbox([a, b], a.localId, 'failed');
    expect(failed.map((i) => i.state)).toEqual(['failed', 'sending']);
    expect(dropOutbox(failed, a.localId)).toEqual([b]);
  });

  it('the thread draws the server\'s messages, then this phone\'s on their way', () => {
    const item = outboxItem('on its way');
    expect(threadWithOutbox([{ id: 'm1' }], [item])).toEqual([{ id: 'm1' }, { ...item, outbox: true }]);
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
