import { useEffect } from 'react';
import { connectSocket, getSocket } from '../services/socket';
import { getAuthSessionSnapshot, useAuthStore } from '../stores/authStore';
import { samePrincipalBoundary } from '../lib/authSession';
import { bindChatRoom } from '../lib/chatRoomSubscription';
import { POLL } from '../lib/pollPolicy';
import { roomMessagesOldestFirst, threadWithSent } from '../lib/chatOutbox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi } from '../services/api';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

/** Get (or create) the chat room for an order. The room carries participants
 *  and the initial message page.
 *  [APP-SPEED 10] That page seeds the thread, so an order's chat opens on its
 *  messages after ONE read, not two in a row; the thread's own read (which also
 *  marks the room read) still follows, in the background. A thread already read
 *  is never overwritten by the room's copy. */
export function useChatRoom(orderId?: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['chat', 'room', orderId],
    queryFn: async () => {
      const room = await unwrap(chatApi.room(orderId!));
      const roomId = (room as { id?: unknown } | null)?.id;
      const seed = roomMessagesOldestFirst(room);
      if (typeof roomId === 'string' && roomId && seed && qc.getQueryData(['chat', 'messages', roomId]) === undefined) {
        qc.setQueryData(['chat', 'messages', roomId], seed);
      }
      return room;
    },
    enabled: !!orderId,
  });
}

/** Socket messages refresh promptly; polling is the reconnect safety net. */
export function useChatMessages(roomId?: string) {
  const qc = useQueryClient();
  const generation = useAuthStore((state) => state.sessionGeneration);
  useEffect(() => {
    const owner = getAuthSessionSnapshot();
    if (!roomId || !owner) return;
    connectSocket();
    return bindChatRoom(getSocket(), roomId,
      () => samePrincipalBoundary(owner, getAuthSessionSnapshot()),
      () => qc.invalidateQueries({ queryKey: ['chat', 'messages', roomId] }));
  }, [roomId, generation, qc]);
  return useQuery({
    queryKey: ['chat', 'messages', roomId],
    queryFn: () => unwrap<any[]>(chatApi.messages(roomId!)),
    enabled: !!roomId,
    refetchInterval: POLL.chatMessages,
  });
}

/** [APP-SPEED 10] The send is free at the server's answer: the stored message
 *  (redactions included) goes into the thread at once, and the thread is
 *  re-read in the background. The screen shows the message from the tap on
 *  (lib/chatOutbox). */
export function useSendMessage(roomId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => unwrap(chatApi.send(roomId!, message)),
    onSuccess: (sent: unknown) => {
      qc.setQueryData(['chat', 'messages', roomId], (thread: unknown) => threadWithSent(thread, sent));
      void qc.invalidateQueries({ queryKey: ['chat', 'messages', roomId] });
    },
  });
}
