import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [APP-SPEED 10 · 7 Nov 2026] An order's chat opens on its messages after ONE read (the room's own page seeds the
// thread), and a send is free at the server's answer (its stored copy goes into the thread; the thread re-reads in
// the background). The REAL hooks' options against a REAL query client; the server is a stand-in.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({
  qc: null as unknown as import('@tanstack/react-query').QueryClient,
  room: vi.fn(),
  send: vi.fn(),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useMutation: (o: unknown) => o, useQuery: (o: unknown) => o, useQueryClient: () => fx.qc };
});
vi.mock('../services/api', () => ({ chatApi: { room: fx.room, messages: vi.fn(), send: fx.send } }));
vi.mock('../services/socket', () => ({ connectSocket: vi.fn(), getSocket: vi.fn(() => ({ connected: false })) }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, useAuthStore: (s: (x: unknown) => unknown) => s({ sessionGeneration: 1 }) }));

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { useChatRoom, useSendMessage } from './chat';

type Opts = { queryFn?: () => Promise<unknown>; onSuccess?: (...a: unknown[]) => unknown };

beforeEach(() => { fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { fx.qc.clear(); vi.clearAllMocks(); });

describe('[APP-SPEED 10] the room read seeds the thread', () => {
  it('the room\'s page (newest first) is the thread, oldest first, before the thread\'s own read', async () => {
    fx.room.mockResolvedValue({ data: { data: { id: 'room-1', participants: [], messages: [{ id: 'm2' }, { id: 'm1' }] } } });
    const room = await (useChatRoom('order-1') as unknown as Opts).queryFn!();
    expect(room).toMatchObject({ id: 'room-1' });
    expect(fx.qc.getQueryData(['chat', 'messages', 'room-1'])).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('a thread already read is never overwritten by the room\'s copy', async () => {
    fx.qc.setQueryData(['chat', 'messages', 'room-1'], [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
    fx.room.mockResolvedValue({ data: { data: { id: 'room-1', messages: [{ id: 'm2' }, { id: 'm1' }] } } });
    await (useChatRoom('order-1') as unknown as Opts).queryFn!();
    expect(fx.qc.getQueryData(['chat', 'messages', 'room-1'])).toEqual([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
  });

  it('a room with no message list (an older server) seeds nothing: the thread\'s own read still answers', async () => {
    fx.room.mockResolvedValue({ data: { data: { id: 'room-2' } } });
    await (useChatRoom('order-2') as unknown as Opts).queryFn!();
    expect(fx.qc.getQueryData(['chat', 'messages', 'room-2'])).toBeUndefined();
  });
});

describe('[APP-SPEED 10] a send is free at the server\'s answer', () => {
  it('the stored copy joins the thread at once; nothing to wait for; the thread re-reads in the background', async () => {
    const read = vi.fn(async () => [{ id: 'm1' }, { id: 'm2', message: 'hi' }]);
    fx.qc.setQueryData(['chat', 'messages', 'room-1'], [{ id: 'm1' }]);
    const off = new QueryObserver(fx.qc, { queryKey: ['chat', 'messages', 'room-1'], queryFn: read, staleTime: Infinity }).subscribe(() => {});
    const returned = (useSendMessage('room-1') as unknown as Opts).onSuccess!({ id: 'm2', message: 'hi' });
    expect(returned, 'the send button is not held for the re-read').toBeUndefined();
    expect(fx.qc.getQueryData(['chat', 'messages', 'room-1'])).toEqual([{ id: 'm1' }, { id: 'm2', message: 'hi' }]);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    off();
  });
});
