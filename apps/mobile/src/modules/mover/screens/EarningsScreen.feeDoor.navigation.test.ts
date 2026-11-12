/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [FOLLOWUPS 11 Nov 2026 · REVIEW-2490 S2-1 / S4-4] The Earnings screen's weekly-fee card and its tools, RENDERED
// with the real BillingStatusBlock: a rider whose fee is owed (PAST_DUE, SUSPENDED) while no way to pay is open in the
// app (MMG and card off) is never offered "Pay now" / "Weekly fee" / "Pay weekly fee" (each opened a screen with
// nothing to pay). The card says so, and offers Swift support, and paying in person only when the server says that
// door is open. With MMG live, the buttons are there as before. Native drawing and data hooks are stand-ins.
// ---------------------------------------------------------------------------
const fx = vi.hoisted(() => ({
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  const View = ({ children }: any) => R.createElement('div', null, children);
  const Pressable = ({ children, onPress, accessibilityLabel }: any) => R.createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, typeof children === 'function' ? children({ pressed: false }) : children);
  return {
    View, ScrollView: View, Text: View, Pressable, RefreshControl: View,
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, absoluteFill: {}, hairlineWidth: 1 },
    Animated: { View, Value: class { setValue() {} }, timing: () => ({ start() {} }) },
    AccessibilityInfo: { announceForAccessibility: vi.fn() }, Alert: { alert: vi.fn() }, Platform: { OS: 'android' },
  };
});
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token, motion: fx.token, fontSize: fx.token, withAlpha: () => '' }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const Box = ({ children }: any) => R.createElement('div', null, children);
  const Button = ({ label, onPress }: any) => R.createElement('button', { type: 'button', onClick: onPress }, label);
  return {
    Card: Box, T: Box, Screen: Box, Header: () => null, ErrorState: () => null, LoadingBlock: () => null, StatTile: () => null,
    PillButton: Button, LinkText: Button, TonePill: ({ label }: any) => R.createElement('span', null, label),
    IconChip: () => null, PopupCard: Box, PopupTitle: Box,
  };
});
vi.mock('../../../hooks', () => ({}));
vi.mock('../../../hooks/usePullToRefresh', () => ({ usePullToRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }) }));
vi.mock('../../../hooks/cashSettlement', () => ({}));
vi.mock('@tanstack/react-query', () => ({ useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }) }));
vi.mock('../../../services/api', () => ({ API_URL: 'https://example.test', driverApi: {}, riderApi: {} }));
vi.mock('../../../lib/payLink', () => ({ openPayLink: vi.fn() }));
vi.mock('../../../stores/authStore', () => ({ getAuthSessionSnapshot: () => null, requireAuthSessionForPrincipal: vi.fn(), requireAuthSessionSnapshot: vi.fn() }));

import { EarningsTools, WeeklyFeeCard } from './EarningsScreen';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const allOff = [{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }];
const mmgLive = [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 6000, currencyCode: 'GYD' }, { id: 'CARD', state: 'off' }];
const pastDue = (extra: Record<string, unknown> = {}) => ({
  status: 'PAST_DUE', isInGracePeriod: true, amountDueGyd: 6000, weeklyFeeGyd: 6000,
  gracePeriodEnd: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  feeStatus: { state: 'DUE', headline: 'Payment due since 4 Nov 2026', detail: 'GY$6,000 to pay.', date: null },
  ...extra,
});
const suspended = (extra: Record<string, unknown> = {}) => ({
  status: 'SUSPENDED', amountDueGyd: 6000, weeklyFeeGyd: 6000,
  feeStatus: { state: 'SUSPENDED', headline: 'Account suspended', detail: 'GY$6,000 due now. Pay it to start receiving work again.', date: null },
  ...extra,
});

async function show(sub: unknown) {
  const open = vi.fn();
  const help = vi.fn();
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(WeeklyFeeCard, { sub, kind: 'RIDER', onPay: open }),
    React.createElement(EarningsTools, { sub, onPayFee: open, onHelp: help, onStatement: vi.fn(), statementLoading: false, statementError: false }),
  )));
  const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
  const press = (label: string) => act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!.click());
  return { open, help, buttons, press, text: () => host.textContent ?? '' };
}

describe('[REVIEW-2490 S2-1] owed, with no way to pay in the app', () => {
  it('PAST_DUE with MMG and card off: no "Pay now", no "Pay weekly fee"; the line and Swift support', async () => {
    const view = await show(pastDue({ payActions: allOff }));
    expect(view.buttons()).not.toContain('Pay now');
    expect(view.buttons()).not.toContain('Pay weekly fee');
    expect(view.text()).toContain('Paying the weekly fee in the app is not open right now.');
    expect(view.buttons()).not.toContain('Pay Swift in person');
    await view.press('Get help');
    expect(view.help).toHaveBeenCalledTimes(1);
    expect(view.open).not.toHaveBeenCalled();
  });

  it('SUSPENDED with everything off: no "Weekly fee" button either', async () => {
    const view = await show(suspended({ payActions: allOff }));
    expect(view.text()).toContain('Your account is suspended');
    expect(view.buttons()).not.toContain('Weekly fee');
    expect(view.buttons()).not.toContain('Pay weekly fee');
    expect(view.buttons()).toContain('Get help');
  });

  it('in person open (the server\'s word): the doors to it, which open the Weekly fee screen that arranges it', async () => {
    const view = await show(pastDue({ payActions: allOff, inPerson: { open: true, waitingGyd: null } }));
    expect(view.buttons()).toContain('Pay Swift in person');
    expect(view.buttons()).toContain('Pay now');
    await view.press('Pay Swift in person');
    expect(view.open).toHaveBeenCalledTimes(1);
  });
});

describe('[REVIEW-2490 S2-1] control: with MMG live the buttons are there as before', () => {
  it('PAST_DUE with MMG live: "Pay now" and "Pay weekly fee", both to the Weekly fee screen; no "not open" line', async () => {
    const view = await show(pastDue({ payActions: mmgLive }));
    expect(view.buttons()).toContain('Pay now');
    expect(view.buttons()).toContain('Pay weekly fee');
    expect(view.text()).not.toContain('not open right now');
    await view.press('Pay now');
    await view.press('Pay weekly fee');
    expect(view.open).toHaveBeenCalledTimes(2);
  });
});
