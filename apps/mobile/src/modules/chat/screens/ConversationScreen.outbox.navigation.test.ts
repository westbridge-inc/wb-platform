/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// [APP-SPEED 10 · 7 Nov 2026] A chat message shows at the tap.
//
// The REAL ConversationScreen drawn by a real React renderer, with a REAL React Query mutation for the send; only
// the server is a stand-in whose answers each case releases by hand. Asserted: the message is in the thread at the
// tap as "Sending…"; the server's yes replaces it with the stored copy; a failed send stays as "Not sent" with
// Retry, and Retry sends the same words again; a refusal the server names puts the words back in the box with its
// reason; a thread still loading shows a loader, never "Say hi".
// ---------------------------------------------------------------------------

interface Sent { text: string; ok: (stored: unknown) => void; fail: (error: unknown) => void }

const fx = vi.hoisted(() => {
  const tok = (path: string): any => new Proxy(() => path, {
    get: (_t, k) => (k === Symbol.toPrimitive || k === 'toString' ? () => path : tok(`${path}.${String(k)}`)),
  });
  return {
    tok,
    sent: [] as Sent[],
    messages: { data: [] as unknown, isError: false, refetch: () => undefined } as { data: unknown; isError: boolean; refetch: () => void },
    qc: null as unknown as import('@tanstack/react-query').QueryClient,
    input: null as null | { value: string; onChangeText: (v: string) => void },
  };
});

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  const a11y = (p: any) => ({ 'aria-label': p.accessibilityLabel, role: p.accessibilityRole });
  const View = (p: any) => h('div', a11y(p), p.children);
  const Pressable = (p: any) => h('div', { ...a11y(p), role: p.accessibilityRole ?? 'button', onClick: p.disabled ? undefined : p.onPress },
    typeof p.children === 'function' ? p.children({ pressed: false }) : p.children);
  const FlatList = R.forwardRef((p: any, _ref) => {
    const data: any[] = p.data ?? [];
    if (data.length === 0) return h('div', { 'data-testid': 'thread' }, p.ListEmptyComponent ?? null);
    return h('div', { 'data-testid': 'thread' }, data.map((item, index) => h(R.Fragment, { key: p.keyExtractor(item, index) }, p.renderItem({ item, index }))));
  });
  const TextInput = (p: any) => { fx.input = { value: p.value, onChangeText: p.onChangeText }; return h('input', { value: p.value, readOnly: true }); };
  return {
    View, Pressable, Text: View, FlatList, KeyboardAvoidingView: View, TextInput,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null }));
vi.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: { roomId: 'room-1', title: 'Rider' } }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@swift/ui', () => ({ color: fx.tok('color'), font: fx.tok('font'), fontSize: fx.tok('fontSize'), radius: fx.tok('radius'), space: fx.tok('space'), withAlpha: () => 'alpha' }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    T: (p: any) => h('span', null, p.children), Screen: Box, Header: (p: any) => h('header', null, p.title, p.right),
    CircleChip: () => null, ActionSheet: () => null, LoadingBlock: () => h('div', null, 'Loading'),
    ConfirmDialog: (p: any) => (p.open ? h('div', { role: 'dialog' }, p.title) : null),
    ErrorState: (p: any) => h('div', { role: 'alert' }, p.message),
    Spinner: () => h('div', { 'data-testid': 'spinner' }),
  };
});
vi.mock('../../../stores/authStore', () => ({ useAuthStore: (s: (x: unknown) => unknown) => s({ user: { id: 'me' } }) }));
vi.mock('../../../hooks/customer', () => ({ useBlockUser: () => ({ mutate: vi.fn(), isPending: false }), useReportContent: () => ({ mutate: vi.fn(), isPending: false }) }));
// The thread is a stand-in; the send is the REAL hook's REAL mutation over a stand-in server.
vi.mock('../../../services/api', () => ({
  chatApi: {
    room: vi.fn(), messages: vi.fn(),
    send: (_roomId: string, text: string) => new Promise((resolve, reject) => {
      fx.sent.push({ text, ok: (stored) => resolve({ data: { data: stored } }), fail: reject });
    }),
  },
}));
vi.mock('../../../hooks/chat', async () => {
  const real = await vi.importActual<typeof import('../../../hooks/chat')>('../../../hooks/chat');
  return { useChatRoom: () => ({ data: undefined, isLoading: false, isError: false }), useChatMessages: () => fx.messages, useSendMessage: real.useSendMessage };
});
vi.mock('../../../services/socket', () => ({ connectSocket: vi.fn(), getSocket: vi.fn(() => ({ connected: false })) }));

import { ConversationScreen } from './ConversationScreen';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const draw = async () => { await act(async () => root.render(h(QueryClientProvider, { client: fx.qc }, h(ConversationScreen)))); };
const text = () => host.textContent ?? '';
const typeAndSend = async (words: string) => {
  await act(async () => { fx.input!.onChangeText(words); });
  await act(async () => { fx.input!.onChangeText(words); });
  const send = Array.from(host.querySelectorAll('[role="button"]')).at(-1) as HTMLElement; // the send circle
  await act(async () => { send.click(); });
};
// React Query hands a settled mutation to its observers on a timer: wait one past it.
const settle = async (fn: () => void) => { await act(async () => { fn(); await new Promise((r) => setTimeout(r, 20)); }); };
const retry = () => host.querySelector('[aria-label="Retry sending this message"]') as HTMLElement | null;

beforeEach(async () => {
  fx.sent = [];
  fx.input = null;
  fx.messages = { data: [{ id: 'm1', senderId: 'them', message: 'On my way', createdAt: '2026-11-07T15:01:00.000Z' }], isError: false, refetch: () => undefined };
  fx.qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await draw();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); fx.qc.clear(); });

describe('[APP-SPEED 10] a sent message shows at the tap', () => {
  it('in the thread at once as "Sending…"; the server\'s yes replaces it with the stored copy', async () => {
    await typeAndSend('At the gate');
    expect(fx.sent.map((s) => s.text)).toEqual(['At the gate']);
    expect(text()).toContain('At the gate');
    expect(text()).toContain('Sending…');
    expect(fx.input!.value, 'the box is cleared for the next message').toBe('');
    fx.qc.setQueryData(['chat', 'messages', 'room-1'], [{ id: 'm1', senderId: 'them', message: 'On my way', createdAt: '2026-11-07T15:01:00.000Z' }]);
    await settle(() => fx.sent[0]!.ok({ id: 'm2', senderId: 'me', message: 'At the gate', createdAt: '2026-11-07T15:02:00.000Z' }));
    expect(text()).not.toContain('Sending…');
    expect(retry()).toBeNull();
    expect(fx.qc.getQueryData(['chat', 'messages', 'room-1'])).toEqual([
      { id: 'm1', senderId: 'them', message: 'On my way', createdAt: '2026-11-07T15:01:00.000Z' }, { id: 'm2', senderId: 'me', message: 'At the gate', createdAt: '2026-11-07T15:02:00.000Z' },
    ]);
  });

  it('a failed send stays in the thread as "Not sent" with Retry, and Retry sends the same words again', async () => {
    await typeAndSend('At the gate');
    await settle(() => fx.sent[0]!.fail(new Error('Network Error')));
    expect(text()).toContain('At the gate');
    expect(text()).toContain('Not sent');
    expect(text()).not.toContain('Sending…');
    expect(retry()).toBeTruthy();
    await act(async () => { retry()!.click(); });
    expect(fx.sent.map((s) => s.text)).toEqual(['At the gate', 'At the gate']);
    expect(text()).toContain('Sending…');
    expect(retry()).toBeNull();
    await settle(() => fx.sent[1]!.ok({ id: 'm2', senderId: 'me', message: 'At the gate', createdAt: '2026-11-07T15:02:00.000Z' }));
    expect(text()).not.toContain('Not sent');
    expect(text()).not.toContain('Sending…');
  });

  it('a refusal the server names is not retried: the words go back in the box, with the reason', async () => {
    await typeAndSend('call me on my number');
    await settle(() => fx.sent[0]!.fail({ response: { status: 422, data: { error: { code: 'CHAT_CONTENT_NOT_ALLOWED' } } } }));
    expect(retry()).toBeNull();
    expect(text()).not.toContain('Sending…');
    expect(fx.input!.value).toBe('call me on my number');
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Message not sent.');
  });
});

describe('[review S3.3] a re-read that already holds the message', () => {
  it('lands mid-send: the stored copy only, no "Sending…" twin; the answer then adds nothing twice', async () => {
    await typeAndSend('At the gate');
    expect(text()).toContain('Sending…');
    fx.messages = { ...fx.messages, data: [{ id: 'm1', senderId: 'them', message: 'On my way', createdAt: '2026-11-07T15:01:00.000Z' }, { id: 'm2', senderId: 'me', message: 'At the gate', createdAt: '2026-11-07T15:02:00.000Z' }] };
    await draw();
    expect(text()).not.toContain('Sending…');
    expect(text().split('At the gate')).toHaveLength(2); // exactly one copy
    await settle(() => fx.sent[0]!.ok({ id: 'm2', senderId: 'me', message: 'At the gate', createdAt: '2026-11-07T15:02:00.000Z' }));
    expect(text().split('At the gate')).toHaveLength(2);
  });

  it('a timed-out send the server stored after all: once a re-read shows it, no "Not sent" and no Retry to send it twice', async () => {
    await typeAndSend('At the gate');
    await settle(() => fx.sent[0]!.fail(new Error('timeout of 15000ms exceeded')));
    expect(retry()).toBeTruthy();
    fx.messages = { ...fx.messages, data: [{ id: 'm1', senderId: 'them', message: 'On my way', createdAt: '2026-11-07T15:01:00.000Z' }, { id: 'm2', senderId: 'me', message: 'At the gate', createdAt: '2026-11-07T15:02:00.000Z' }] };
    await draw();
    expect(retry()).toBeNull();
    expect(text()).not.toContain('Not sent');
    expect(fx.sent).toHaveLength(1);
  });
});

describe('[review S2] a message is never lost to an older identical one', () => {
  it('sent before the thread loaded (no baseline), failed, then history loads with an older identical message: "Not sent" with Retry stays', async () => {
    fx.messages = { data: undefined, isError: false, refetch: () => undefined };
    await draw();
    await typeAndSend('On my way');
    await settle(() => fx.sent[0]!.fail(new Error('Network Error')));
    fx.messages = { data: [{ id: 'm0', senderId: 'me', message: 'On my way', createdAt: '2026-11-06T09:00:00.000Z' }], isError: false, refetch: () => undefined };
    await draw();
    expect(retry(), 'the unsent message is still there to send').toBeTruthy();
    expect(text()).toContain('Not sent');
  });

  it('sent with the thread loaded, failed, then an OLDER identical message scrolls in: still "Not sent" with Retry', async () => {
    await typeAndSend('On my way');
    await settle(() => fx.sent[0]!.fail(new Error('Network Error')));
    fx.messages = { ...fx.messages, data: [{ id: 'm0', senderId: 'me', message: 'On my way', createdAt: '2026-11-06T09:00:00.000Z' }, ...(fx.messages.data as unknown[])] };
    await draw();
    expect(retry()).toBeTruthy();
  });
});

describe('[APP-SPEED 10] the thread while it loads', () => {
  it('a loader, never "Say hi" over messages not yet arrived', async () => {
    fx.messages = { data: undefined, isError: false, refetch: () => undefined };
    await draw();
    expect(host.querySelector('[data-testid="spinner"]')).toBeTruthy();
    expect(text()).not.toContain('Say hi');
  });

  it('an empty thread that answered says "Say hi" (control)', async () => {
    fx.messages = { data: [], isError: false, refetch: () => undefined };
    await draw();
    expect(text()).toContain('Say hi');
    expect(host.querySelector('[data-testid="spinner"]')).toBeNull();
  });
});
