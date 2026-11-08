/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// [CALLS-UX · owner 8 Nov 2026, "A"] "In-app first, the number only as a backup", RENDERED: the real CallParty and
// CallInApp side by side as the order screens use them (VendorOrderDetailScreen, DeliveryScreen, TaxiScreen,
// ActiveJobScreen), the real hooks and the real in-app voice service over an SDK stand-in. Only the network, the
// toast and the dialler are doubles.

const fx = vi.hoisted(() => ({
  native: {} as Record<string, unknown>,
  bridgeOn: false,
  inAppOn: true as boolean | null,
  appConfigReads: 0,
  startError: null as null | { status: number; code: string; message: string },
  starts: [] as unknown[][],
  bridges: [] as unknown[][],
  dials: [] as string[],
  toasts: [] as Array<[string, string, string]>,
  connects: 0,
  os: 'ios' as 'ios' | 'android',
  micGranted: true,
  configGate: null as null | Promise<void>,
  connectError: null as null | Error,
  lastCall: null as null | { emit: (e: string) => void },
  cancels: [] as string[],
}));

vi.mock('react-native', () => ({
  NativeModules: new Proxy({}, { get: (_t, k: string) => fx.native[k] }),
  Platform: { get OS() { return fx.os; } },
  PermissionsAndroid: { PERMISSIONS: { RECORD_AUDIO: 'mic' }, RESULTS: { GRANTED: 'granted' }, check: async () => fx.micGranted, request: async () => 'denied' },
  // Swift's own words before the system prompt: the person taps "Not now".
  Alert: { alert: (_t: string, _m: string, buttons: Array<{ onPress?: () => void }>) => { buttons[0]?.onPress?.(); } },
}));
vi.mock('../kit/toast', () => ({
  toast: {
    success: (t: string, b: string) => { fx.toasts.push(['success', t, b]); },
    error: (t: string, b: string) => { fx.toasts.push(['error', t, b]); },
  },
}));
vi.mock('../lib/openExternal', () => ({ openExternal: async (url: string) => { fx.dials.push(url); } }));
vi.mock('../services/api', () => ({
  callsApi: {
    config: async () => ({ data: { data: { enabled: fx.bridgeOn, callerId: null } } }),
    bridge: async (...a: unknown[]) => { fx.bridges.push(a); return { data: { data: { callId: 'b1', status: 'RINGING' } } }; },
    appConfig: async () => {
      fx.appConfigReads += 1;
      if (fx.configGate) await fx.configGate;
      if (fx.inAppOn === null) throw new Error('network');
      return { data: { data: { enabled: fx.inAppOn } } };
    },
    appToken: async () => ({ data: { data: { token: 'reg', identity: 'sX', ttlSeconds: 900 } } }),
    appStart: async (...a: unknown[]) => {
      fx.starts.push(a);
      if (fx.startError) {
        const { status, code, message } = fx.startError;
        throw Object.assign(new Error(code), { response: { status, data: { error: { code, message } } } });
      }
      return { data: { data: { callId: 'c1', token: 'tok', ttlSeconds: 900 } } };
    },
    appCancel: async (callId: string) => { fx.cancels.push(callId); return { data: { data: { ended: true } } }; },
  },
}));

import { CallParty } from './CallParty';
import { CallInApp } from './CallInApp';
import { resetCallConfigForTests } from '../hooks/useCallParty';
import { resetInAppConfigForTests } from '../hooks/useInAppCall';
import { resetInAppVoiceForTests } from '../services/inAppVoice';
import type { CallTarget } from '../lib/callBridge';

class FakeCall {
  handlers = new Map<string, Array<() => void>>();
  on(e: string, l: () => void) { this.handlers.set(e, [...(this.handlers.get(e) ?? []), l]); return this; }
  removeListener(e: string, l: () => void) { this.handlers.set(e, (this.handlers.get(e) ?? []).filter((x) => x !== l)); return this; }
  emit(e: string) { for (const l of this.handlers.get(e) ?? []) l(); }
  getState() { return 'connecting'; }
  disconnect = async () => undefined;
}
const fakeSdk = () => ({
  Voice: class {
    initializePushRegistry = async () => undefined;
    setIncomingCallContactHandleTemplate = async () => undefined;
    register = async () => undefined;
    unregister = async () => undefined;
    connect = async () => {
      fx.connects += 1;
      if (fx.connectError) throw fx.connectError;
      const call = new FakeCall();
      fx.lastCall = call;
      return call;
    };
  },
});
const flags = () => {
  const m = new Map<string, boolean>();
  return { getBoolean: (k: string) => m.get(k), set: (k: string, v: boolean) => { m.set(k, v); }, delete: (k: string) => { m.delete(k); } };
};

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** One person's call controls, exactly as a screen lays them out: CallParty, then CallInApp. */
function Controls(props: { orderId: string; target: CallTarget; phone: string | null }) {
  return h('div', null,
    h(CallParty, { orderId: props.orderId, target: props.target, phone: props.phone, dialFailText: 'x', children: (call) => h('button', { 'data-testid': 'backup', onClick: call.onPress }, call.label) }),
    h(CallInApp, { orderId: props.orderId, target: props.target, children: (call) => h('button', { 'data-testid': 'inapp', onClick: call.onPress }, call.label) }),
  );
}

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); }); };
const draw = async (props: { orderId?: string; target?: CallTarget; phone?: string | null } = {}) => {
  await act(async () => root.render(h(Controls, { orderId: props.orderId ?? 'o1', target: props.target ?? 'customer', phone: props.phone === undefined ? '+5926000000' : props.phone })));
  await settle();
};
const buttons = () => [...host.querySelectorAll('button')].map((b) => `${b.getAttribute('data-testid')}:${b.textContent}`);
const press = async (id: string) => {
  const b = host.querySelector(`button[data-testid="${id}"]`) as HTMLButtonElement;
  await act(async () => { b.click(); });
  await settle();
};

beforeEach(() => {
  Object.assign(fx, {
    native: { TwilioVoiceReactNative: {} }, bridgeOn: false, inAppOn: true, appConfigReads: 0, startError: null, starts: [], bridges: [], dials: [], toasts: [], connects: 0,
    os: 'ios', micGranted: true, configGate: null, connectError: null, lastCall: null, cancels: [],
  });
  resetCallConfigForTests();
  resetInAppConfigForTests({ graceMs: 60 });
  resetInAppVoiceForTests(fakeSdk, flags);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[CALLS-UX] in-app first', () => {
  it('a person who can take it in the app: only "Call in app" (bridge off: no dial button)', async () => {
    await draw();
    expect(buttons()).toEqual(['inapp:Call in app']);
  });

  it('the same with the phone bridge on: no "Call via Swift" beside it (the server rings their phone if the app does not answer)', async () => {
    fx.bridgeOn = true;
    await draw({ phone: null });
    expect(buttons()).toEqual(['inapp:Call in app']);
  });

  it('pressing it starts the in-app call and no backup appears', async () => {
    await draw();
    await press('inapp');
    expect(fx.starts).toEqual([['o1', 'customer', 'ios']]);
    expect(fx.connects).toBe(1);
    expect(buttons()).toEqual(['inapp:End call']);
  });
});

describe('[CALLS-UX] the number as the backup', () => {
  it('they cannot be rung in the app (409 INAPP_NOT_REACHABLE): the dial button appears, with words that point at it, and dials', async () => {
    fx.startError = { status: 409, code: 'INAPP_NOT_REACHABLE', message: "They can't take calls in the Swift app. Message them in chat instead." };
    await draw();
    expect(buttons()).toEqual(['inapp:Call in app']);
    await press('inapp');
    expect(fx.connects).toBe(0);
    // [review S2] Not the server's "message them in chat instead" beside a Call button: the words name that button.
    expect(fx.toasts.at(-1)).toEqual(['error', 'Call not started', "They can't take calls in the Swift app. Tap Call to ring their phone, or message them in chat."]);
    expect(buttons()).toEqual(['backup:Call', 'inapp:Call in app']);
    await press('backup');
    expect(fx.dials).toEqual(['tel:+5926000000']);
  });

  it('[review S2] the bridge on: the words name "Call via Swift", the button that appears', async () => {
    fx.bridgeOn = true;
    fx.startError = { status: 503, code: 'INAPP_CALLS_TROUBLE', message: 'm' };
    await draw({ phone: null });
    await press('inapp');
    expect(fx.toasts.at(-1)).toEqual(['error', 'Call not started', 'Swift calls in the app are having trouble right now. Tap Call via Swift to reach them by phone, or message them in chat.']);
    expect(buttons()).toEqual(['backup:Call via Swift', 'inapp:Call in app']);
  });

  it('[review S2] bridge off and no number for them: no button appears, so the words promise none', async () => {
    fx.startError = { status: 409, code: 'INAPP_NOT_REACHABLE', message: 'm' };
    await draw({ phone: null });
    await press('inapp');
    expect(fx.toasts.at(-1)).toEqual(['error', 'Call not started', "They can't take calls in the Swift app. Message them in chat."]);
    expect(buttons()).toEqual(['inapp:Call in app']);
  });

  it('[review S2] Android, microphone refused: the backup appears and the words match it (dial, then the bridge)', async () => {
    fx.os = 'android';
    fx.micGranted = false;
    await draw();
    await press('inapp');
    expect(fx.starts).toEqual([]);
    expect(fx.toasts.at(-1)).toEqual(['error', 'Microphone needed', 'The microphone is off for Swift, so in-app calls cannot work. You can turn it on in Settings. Tap Call to ring their phone, or message them in chat.']);
    expect(buttons()).toEqual(['backup:Call', 'inapp:Call in app']);

    fx.bridgeOn = true;
    resetCallConfigForTests();
    await act(async () => root.render(h('div')));
    await draw({ orderId: 'o2', phone: null });
    await press('inapp');
    expect(fx.toasts.at(-1)?.[2]).toBe('The microphone is off for Swift, so in-app calls cannot work. You can turn it on in Settings. Tap Call via Swift to reach them by phone, or message them in chat.');
    expect(buttons()).toEqual(['backup:Call via Swift', 'inapp:Call in app']);
  });

  it('the backup stays for that person on that order when the screen opens again, and only for them', async () => {
    fx.startError = { status: 409, code: 'INAPP_NOT_REACHABLE', message: 'm' };
    await draw();
    await press('inapp');
    await act(async () => root.render(h('div')));
    await draw();
    expect(buttons()).toEqual(['backup:Call', 'inapp:Call in app']);
    await draw({ target: 'rider' });
    expect(buttons()).toEqual(['inapp:Call in app']);
    await draw({ orderId: 'o2' });
    expect(buttons()).toEqual(['inapp:Call in app']);
  });

  it('a shared cap is not "in-app impossible": no backup appears (it holds for every Swift call)', async () => {
    fx.startError = { status: 429, code: 'CALL_LIMIT_REACHED', message: 'm' };
    await draw();
    await press('inapp');
    expect(buttons()).toEqual(['inapp:Call in app']);
  });

  it('in-app calls switched off: only today\'s dial button', async () => {
    fx.inAppOn = false;
    await draw();
    expect(buttons()).toEqual(['backup:Call']);
  });

  it('the switch could not be read: the dial button (never no way to call)', async () => {
    fx.inAppOn = null;
    await draw();
    expect(buttons()).toEqual(['backup:Call']);
  });

  it('[review S3] while the switch is being read: no call button at all (no flash of the dial button), then the answer decides', async () => {
    let open!: () => void;
    fx.configGate = new Promise<void>((r) => { open = r; });
    await act(async () => root.render(h(Controls, { orderId: 'o1', target: 'customer', phone: '+5926000000' })));
    expect(buttons()).toEqual([]); // the very first frame: nothing to tap yet
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(buttons()).toEqual([]);
    await act(async () => { open(); });
    await settle();
    expect(buttons()).toEqual(['inapp:Call in app']);
  });

  it('[review S3] the switch read hangs: after a short grace the dial button shows (never no way to call)', async () => {
    fx.configGate = new Promise<void>(() => undefined);
    await act(async () => root.render(h(Controls, { orderId: 'o1', target: 'customer', phone: '+5926000000' })));
    expect(buttons()).toEqual([]);
    await act(async () => { await new Promise((r) => setTimeout(r, 90)); });
    expect(buttons()).toEqual(['backup:Call']);
  });

  it('[review S3] the server accepted but the connect threw: the backup appears, the order is freed, the words name it', async () => {
    fx.connectError = new Error('twilio');
    await draw();
    await press('inapp');
    expect(fx.connects).toBe(1);
    expect(fx.cancels).toEqual(['c1']);
    expect(fx.toasts.at(-1)).toEqual(['error', 'Call not started', "Swift couldn't connect the call in the app. Tap Call to ring their phone, or message them in chat."]);
    expect(buttons()).toEqual(['backup:Call', 'inapp:Call in app']);
  });

  it('[review S3] connected, then the SDK reports connectFailure: the backup appears for this person on this order', async () => {
    await draw();
    await press('inapp');
    expect(buttons()).toEqual(['inapp:End call']);
    await act(async () => { fx.lastCall?.emit('connectFailure'); });
    await settle();
    expect(fx.cancels).toEqual(['c1']);
    expect(fx.toasts.at(-1)).toEqual(['error', 'Call not started', "Swift couldn't connect the call in the app. Tap Call to ring their phone, or message them in chat."]);
    expect(buttons()).toEqual(['backup:Call', 'inapp:Call in app']);
    await act(async () => root.render(h('div')));
    await draw();
    expect(buttons()).toEqual(['backup:Call', 'inapp:Call in app']); // kept for that order (10 minutes)
    await draw({ orderId: 'o2' });
    expect(buttons()).toEqual(['inapp:Call in app']);
  });

  it('[review S3] 503 CALL_PROVIDER_FAILED: the backup appears', async () => {
    fx.startError = { status: 503, code: 'CALL_PROVIDER_FAILED', message: 'm' };
    await draw();
    await press('inapp');
    expect(buttons()).toEqual(['backup:Call', 'inapp:Call in app']);
  });

  it('build 12 (no calling module): only the dial button, and the in-app switch is never even read', async () => {
    fx.native = {};
    await draw();
    expect(buttons()).toEqual(['backup:Call']);
    expect(fx.appConfigReads).toBe(0);
  });

  it('build 12 with the bridge on: "Call via Swift"', async () => {
    fx.native = {};
    fx.bridgeOn = true;
    await draw({ phone: null });
    expect(buttons()).toEqual(['backup:Call via Swift']);
  });
});

describe('[CALLS-UX] the parcel recipient is unchanged', () => {
  it('never "Call in app"; "Call via Swift" while the bridge is on, even with in-app calls on', async () => {
    fx.bridgeOn = true;
    await draw({ target: 'recipient', phone: null });
    expect(buttons()).toEqual(['backup:Call via Swift']);
  });

  it('bridge off: no control at all, as today', async () => {
    await draw({ target: 'recipient', phone: null });
    expect(buttons()).toEqual([]);
  });
});
