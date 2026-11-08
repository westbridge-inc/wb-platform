/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// [CALLS-UX · owner 8 Nov 2026, "B"] The in-call bar, RENDERED over the real in-app voice service and an SDK
// stand-in shaped like the installed Twilio Voice SDK: it shows only while a call is on, Speaker selects the SDK's
// speaker device, Mute goes through call.mute, Hang up ends the call. Native drawing is plain DOM here.

const fx = vi.hoisted(() => ({
  native: {} as Record<string, unknown>,
  os: 'android' as 'ios' | 'android',
  appListeners: 0,
  devices: [] as Array<{ type: string; name: string; select: () => Promise<void> }>,
  selected: 'earpiece',
  routePicker: 0,
}));

vi.mock('react-native', async () => {
  const React = await import('react');
  const h = React.createElement;
  type P = { children?: unknown; testID?: string; accessibilityLabel?: string; accessibilityState?: { selected?: boolean }; onPress?: () => void; barStyle?: string };
  return {
    NativeModules: new Proxy({}, { get: (_t, k: string) => fx.native[k] }),
    Platform: { get OS() { return fx.os; } },
    PermissionsAndroid: { PERMISSIONS: { RECORD_AUDIO: 'mic' }, RESULTS: { GRANTED: 'granted' }, check: async () => true, request: async () => 'granted' },
    AppState: { addEventListener: () => { fx.appListeners += 1; return { remove: () => { fx.appListeners -= 1; } }; } },
    // React Native keeps a stack of StatusBar settings: the newest mounted one wins, and unmounting restores.
    StatusBar: (p: P) => h('i', { 'data-testid': 'status-bar', 'data-bar-style': p.barStyle }),
    View: (p: P) => h('div', { 'data-testid': p.testID, 'aria-label': p.accessibilityLabel }, p.children as React.ReactNode),
    Pressable: (p: P) => h('button', {
      'data-testid': p.testID,
      'aria-label': p.accessibilityLabel,
      'aria-pressed': p.accessibilityState?.selected,
      onClick: p.onPress,
    }, (typeof p.children === 'function' ? (p.children as (s: { pressed: boolean }) => unknown)({ pressed: false }) : p.children) as React.ReactNode),
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: () => null }));
vi.mock('../kit', async () => {
  const React = await import('react');
  return { T: (p: { children?: React.ReactNode; testID?: string }) => React.createElement('span', { 'data-testid': p.testID }, p.children) };
});

import { InCallBoundary } from './InCallBar';
import { placeInAppCall, resetInAppVoiceForTests } from '../services/inAppVoice';

type Listener = (...args: unknown[]) => void;
class FakeCall {
  handlers = new Map<string, Listener[]>();
  muted = false;
  constructor(public connectedAt?: Date) {}
  on(e: string, l: Listener) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), l]); return this; }
  removeListener(e: string, l: Listener) { this.handlers.set(e, (this.handlers.get(e) ?? []).filter((x) => x !== l)); return this; }
  emit(e: string) { for (const l of this.handlers.get(e) ?? []) l(); }
  getState() { return this.connectedAt ? 'connected' : 'connecting'; }
  getSid() { return 'CA1'; }
  isMuted() { return this.muted; }
  getInitialConnectedTimestamp() { return this.connectedAt; }
  mute = vi.fn(async (m: boolean) => { this.muted = m; return m; });
  disconnect = vi.fn(async () => { this.emit('disconnected'); });
}
let nextCall: FakeCall;
let voiceObj: { showAvRoutePickerView: () => Promise<void> } | null = null;
const fakeSdk = () => ({
  Voice: class {
    constructor() { voiceObj = this; }
    initializePushRegistry = async () => undefined;
    setIncomingCallContactHandleTemplate = async () => undefined;
    register = async () => undefined;
    unregister = async () => undefined;
    on() { return this; }
    connect = async () => nextCall;
    getCalls = async () => new Map();
    getAudioDevices = async () => ({ audioDevices: fx.devices, selectedDevice: fx.devices.find((d) => d.type === fx.selected) });
    showAvRoutePickerView = async () => { fx.routePicker += 1; };
  },
});
const flags = () => {
  const m = new Map<string, boolean>();
  return { getBoolean: (k: string) => m.get(k), set: (k: string, v: boolean) => { m.set(k, v); }, delete: (k: string) => { m.delete(k); } };
};
const device = (type: string) => ({ type, name: type, select: vi.fn(async () => { fx.selected = type; }) });

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
const draw = async () => { await act(async () => root.render(h(InCallBoundary, null, h('main', { 'data-testid': 'screen' }, 'the order')))); await settle(); };
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const press = async (id: string) => { await act(async () => { (byId(id) as HTMLButtonElement).click(); }); await settle(); };
const call = async () => {
  await act(async () => { await placeInAppCall('o1', 'rider', { start: async () => ({ callId: 'c1', token: 't' }), cancel: async () => undefined }); });
  await settle();
};

beforeEach(() => {
  Object.assign(fx, { native: { TwilioVoiceReactNative: {} }, os: 'android', appListeners: 0, selected: 'earpiece', routePicker: 0 });
  fx.devices = [device('earpiece'), device('speaker')];
  nextCall = new FakeCall();
  resetInAppVoiceForTests(fakeSdk, flags);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[CALLS-UX] the in-call bar', () => {
  it('hidden while no call is on; the screen shows as usual', async () => {
    await draw();
    expect(byId('in-call-bar')).toBeNull();
    expect(byId('screen')?.textContent).toBe('the order');
  });

  it('shows while a call is on, with its state, then the time once connected', async () => {
    await draw();
    await call();
    expect(byId('in-call-bar')).not.toBeNull();
    expect(byId('in-call-status')?.textContent).toBe('Connecting');
    expect(byId('screen')?.textContent).toBe('the order');
    nextCall.connectedAt = new Date(Date.now() - 65_000);
    await act(async () => { nextCall.emit('connected'); });
    await settle();
    expect(byId('in-call-status')?.textContent).toBe('1:05');
  });

  it('Speaker selects the SDK speaker device, and the button shows it on; again goes back to the earpiece', async () => {
    await draw();
    await call();
    expect(byId('in-call-speaker')?.getAttribute('aria-pressed')).toBe('false');
    await press('in-call-speaker');
    expect(fx.devices[1]?.select).toHaveBeenCalledTimes(1);
    expect(byId('in-call-speaker')?.getAttribute('aria-pressed')).toBe('true');
    await press('in-call-speaker');
    expect(fx.devices[0]?.select).toHaveBeenCalledTimes(1);
    expect(byId('in-call-speaker')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('Mute toggles through the SDK call.mute', async () => {
    await draw();
    await call();
    expect(byId('in-call-mute')?.getAttribute('aria-label')).toBe('Mute');
    await press('in-call-mute');
    expect(nextCall.mute).toHaveBeenLastCalledWith(true);
    expect(byId('in-call-mute')?.getAttribute('aria-label')).toBe('Unmute');
    await press('in-call-mute');
    expect(nextCall.mute).toHaveBeenLastCalledWith(false);
    expect(byId('in-call-mute')?.getAttribute('aria-label')).toBe('Mute');
  });

  it('[review S4] Mute double-tapped before the SDK answers: one change only, the same value never sent twice', async () => {
    await draw();
    await call();
    let land!: () => void;
    nextCall.mute.mockImplementationOnce(async (m: boolean) => { await new Promise<void>((r) => { land = r; }); nextCall.muted = m; return m; });
    await act(async () => { (byId('in-call-mute') as HTMLButtonElement).click(); (byId('in-call-mute') as HTMLButtonElement).click(); });
    await act(async () => { land(); });
    await settle();
    expect(nextCall.mute).toHaveBeenCalledTimes(1);
    expect(byId('in-call-mute')?.getAttribute('aria-label')).toBe('Unmute');
  });

  it('[review S4] Speaker double-tapped: one change only', async () => {
    await draw();
    await call();
    let land!: () => void;
    vi.mocked(fx.devices[1]!.select).mockImplementationOnce(async () => { await new Promise<void>((r) => { land = r; }); fx.selected = 'speaker'; });
    await act(async () => { (byId('in-call-speaker') as HTMLButtonElement).click(); (byId('in-call-speaker') as HTMLButtonElement).click(); });
    await act(async () => { land(); });
    await settle();
    expect(fx.devices[1]?.select).toHaveBeenCalledTimes(1);
    expect(fx.devices[0]?.select).not.toHaveBeenCalled();
    expect(byId('in-call-speaker')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('[review S4] light status-bar text over the dark bar while it shows; the app\'s own comes back after', async () => {
    await draw();
    expect(byId('status-bar')).toBeNull();
    await call();
    expect(byId('status-bar')?.getAttribute('data-bar-style')).toBe('light-content');
    await press('in-call-hang-up');
    expect(byId('status-bar')).toBeNull();
  });

  it('a second call after a muted one starts unmuted (the bar shows the new call\'s own state)', async () => {
    await draw();
    await call();
    await press('in-call-mute');
    expect(byId('in-call-mute')?.getAttribute('aria-label')).toBe('Unmute');
    await press('in-call-hang-up');
    nextCall = new FakeCall();
    await call();
    expect(byId('in-call-mute')?.getAttribute('aria-label')).toBe('Mute');
    await press('in-call-mute');
    expect(nextCall.mute).toHaveBeenLastCalledWith(true);
  });

  it('Hang up ends the call and the bar goes', async () => {
    await draw();
    await call();
    await press('in-call-hang-up');
    expect(nextCall.disconnect).toHaveBeenCalledTimes(1);
    expect(byId('in-call-bar')).toBeNull();
  });

  it('the other person hangs up: the bar goes', async () => {
    await draw();
    await call();
    await act(async () => { nextCall.emit('disconnected'); });
    expect(byId('in-call-bar')).toBeNull();
  });

  it('iPhone with a Bluetooth headset: "Audio" opens the SDK route picker (no route forced over CallKit)', async () => {
    fx.os = 'ios';
    fx.devices = [device('earpiece'), device('speaker'), device('bluetooth')];
    await draw();
    await call();
    expect(byId('in-call-speaker')?.getAttribute('aria-label')).toBe('Audio');
    await press('in-call-speaker');
    expect(fx.routePicker).toBe(1);
    for (const d of fx.devices) expect(d.select).not.toHaveBeenCalled();
    expect(voiceObj).not.toBeNull();
  });

  it('build 12 (no calling module): never a bar, not even a listener', async () => {
    fx.native = {};
    await draw();
    expect(byId('in-call-bar')).toBeNull();
    expect(fx.appListeners).toBe(0);
  });
});
