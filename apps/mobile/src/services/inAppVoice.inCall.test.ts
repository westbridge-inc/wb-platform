import { beforeEach, describe, expect, it, vi } from 'vitest';

// [CALLS-UX · owner 8 Nov 2026, "B"] The in-call controls under the bar: the call that is on (placed here, or
// answered from the system's screen), Mute through the SDK's call.mute, Speaker through the SDK's own audio
// devices (getAudioDevices, then AudioDevice.select), Hang up through call.disconnect. The SDK stand-in below
// follows the installed SDK's shapes (inAppVoice.sdkShape.test.ts proves the shapes against its types).

const rn = vi.hoisted(() => ({ native: {} as Record<string, unknown>, os: 'android' as 'ios' | 'android' }));
vi.mock('react-native', () => ({
  NativeModules: new Proxy({}, { get: (_t, k: string) => rn.native[k] }),
  Platform: { get OS() { return rn.os; } },
  PermissionsAndroid: { PERMISSIONS: { RECORD_AUDIO: 'mic' }, RESULTS: { GRANTED: 'granted' }, check: async () => true, request: async () => 'granted' },
}));

type Listener = (...args: unknown[]) => void;
class Emitter {
  private handlers = new Map<string, Listener[]>();
  on(event: string, listener: Listener) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]); return this; }
  emit(event: string, ...args: unknown[]) { for (const l of this.handlers.get(event) ?? []) l(...args); }
  count(event: string) { return this.handlers.get(event)?.length ?? 0; }
}

class FakeCall extends Emitter {
  state = 'connecting';
  muted = false;
  constructor(public sid: string | undefined = 'CA1', public connectedAt?: Date) { super(); }
  mute = vi.fn(async (m: boolean) => { this.muted = m; return m; });
  isMuted() { return this.muted; }
  getState() { return this.state; }
  getSid() { return this.sid; }
  getInitialConnectedTimestamp() { return this.connectedAt; }
  disconnect = vi.fn(async () => { this.state = 'disconnected'; this.emit('disconnected'); });
}

const device = (type: string) => ({ type, name: type, select: vi.fn(async () => { sdk.selected = type; }) });

const sdk = vi.hoisted(() => ({
  voice: null as unknown as InstanceType<ReturnType<typeof makeSdk>['Voice']>,
  nextCall: null as FakeCall | null,
  devices: [] as Array<ReturnType<typeof device>>,
  selected: 'earpiece',
  held: [] as FakeCall[],
}));

function makeSdk() {
  class Voice extends Emitter {
    initializePushRegistry = vi.fn(async () => undefined);
    setIncomingCallContactHandleTemplate = vi.fn(async () => undefined);
    register = vi.fn(async () => undefined);
    unregister = vi.fn(async () => undefined);
    connect = vi.fn(async () => sdk.nextCall ?? new FakeCall());
    getAudioDevices = vi.fn(async () => ({ audioDevices: sdk.devices, selectedDevice: sdk.devices.find((d) => d.type === sdk.selected) }));
    getCalls = vi.fn(async () => new Map(sdk.held.map((c, i) => [`u${i}`, c])));
    showAvRoutePickerView = vi.fn(async () => undefined);
    constructor() { super(); sdk.voice = this; }
  }
  return { Voice };
}

import * as voice from './inAppVoice';

const flags = () => {
  const m = new Map<string, boolean>();
  return { getBoolean: (k: string) => m.get(k), set: (k: string, v: boolean) => { m.set(k, v); }, delete: (k: string) => { m.delete(k); } };
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const deps = () => ({ start: vi.fn(async () => ({ callId: 'c1', token: 'tok' })), cancel: vi.fn(async () => undefined) });

beforeEach(() => {
  voice.resetInAppVoiceForTests(makeSdk, flags);
  rn.native = { TwilioVoiceReactNative: {} };
  rn.os = 'android';
  sdk.nextCall = null;
  sdk.devices = [device('earpiece'), device('speaker')];
  sdk.selected = 'earpiece';
  sdk.held = [];
});

describe('[CALLS-UX] no call, no bar', () => {
  it('build 12 (no module): nothing is ever on, every control is a quiet no-op', async () => {
    rn.native = {};
    expect(voice.inCallSnapshot()).toBeNull();
    expect(await voice.setInCallSpeaker(true)).toBe(false);
    expect(await voice.setInCallMuted(true)).toBeNull();
    await voice.syncInAppCalls();
    expect(voice.inCallSnapshot()).toBeNull();
  });

  it('build 13 with no call: nothing on', () => {
    expect(voice.inAppVoiceAvailable()).toBe(true);
    expect(voice.inCallSnapshot()).toBeNull();
    expect(voice.inAppCallActive()).toBe(false);
  });
});

describe('[CALLS-UX] a call placed here', () => {
  it('shows from the start, follows the SDK states, and the timer starts when it connects', async () => {
    const call = new FakeCall();
    sdk.nextCall = call;
    const seen: Array<string | null> = [];
    const off = voice.subscribeInCall(() => seen.push(voice.inCallSnapshot()?.phase ?? null));
    await voice.placeInAppCall('o1', 'rider', deps());
    expect(voice.inCallSnapshot()).toMatchObject({ phase: 'connecting', connectedAt: null, muted: false });
    call.emit('ringing');
    expect(voice.inCallSnapshot()?.phase).toBe('ringing');
    call.emit('connected');
    const snap = voice.inCallSnapshot();
    expect(snap?.phase).toBe('connected');
    expect(typeof snap?.connectedAt).toBe('number');
    call.emit('reconnecting');
    expect(voice.inCallSnapshot()?.phase).toBe('reconnecting');
    call.emit('reconnected');
    expect(voice.inCallSnapshot()).toMatchObject({ phase: 'connected', connectedAt: snap?.connectedAt });
    expect(seen).toContain('ringing');
    off();
  });

  it('the far end hangs up (or the connect fails): the bar goes', async () => {
    const call = new FakeCall();
    sdk.nextCall = call;
    await voice.placeInAppCall('o1', 'rider', deps());
    call.emit('disconnected');
    expect(voice.inCallSnapshot()).toBeNull();
    const failed = new FakeCall('CA2');
    sdk.nextCall = failed;
    await voice.placeInAppCall('o1', 'rider', deps());
    failed.emit('connectFailure');
    expect(voice.inCallSnapshot()).toBeNull();
  });

  it('Mute toggles through the SDK call.mute and shows what the SDK says', async () => {
    const call = new FakeCall();
    sdk.nextCall = call;
    await voice.placeInAppCall('o1', 'rider', deps());
    expect(await voice.setInCallMuted(true)).toBe(true);
    expect(call.mute).toHaveBeenLastCalledWith(true);
    expect(voice.inCallSnapshot()?.muted).toBe(true);
    expect(await voice.setInCallMuted(false)).toBe(false);
    expect(call.mute).toHaveBeenLastCalledWith(false);
    expect(voice.inCallSnapshot()?.muted).toBe(false);
  });

  it('Speaker on selects the SDK speaker device; off goes back to the earpiece', async () => {
    sdk.nextCall = new FakeCall();
    await voice.placeInAppCall('o1', 'rider', deps());
    const [earpiece, speaker] = sdk.devices;
    expect(await voice.setInCallSpeaker(true)).toBe(true);
    expect(speaker?.select).toHaveBeenCalledTimes(1);
    expect(earpiece?.select).not.toHaveBeenCalled();
    expect(voice.inCallSnapshot()?.speaker).toBe(true);
    expect(await voice.setInCallSpeaker(false)).toBe(true);
    expect(earpiece?.select).toHaveBeenCalledTimes(1);
    expect(voice.inCallSnapshot()?.speaker).toBe(false);
  });

  it('Speaker off with a Bluetooth headset on Android goes to the headset', async () => {
    sdk.devices = [device('earpiece'), device('speaker'), device('bluetooth')];
    sdk.selected = 'speaker';
    sdk.nextCall = new FakeCall();
    await voice.placeInAppCall('o1', 'rider', deps());
    await voice.setInCallSpeaker(false);
    expect(sdk.devices[2]?.select).toHaveBeenCalledTimes(1);
    expect(sdk.devices[0]?.select).not.toHaveBeenCalled();
  });

  it('iPhone: the bar follows the route CallKit reports (its own Speaker) and never puts a choice back', async () => {
    rn.os = 'ios';
    sdk.nextCall = new FakeCall();
    await voice.placeInAppCall('o1', 'rider', deps());
    await flush();
    expect(voice.inCallSnapshot()?.speaker).toBe(false);
    // The person taps Speaker on CallKit's own screen: the SDK reports the new route.
    sdk.voice.emit('audioDevicesUpdated', sdk.devices, sdk.devices[1]);
    expect(voice.inCallSnapshot()?.speaker).toBe(true);
    sdk.voice.emit('audioDevicesUpdated', sdk.devices, sdk.devices[0]);
    expect(voice.inCallSnapshot()?.speaker).toBe(false);
    for (const d of sdk.devices) expect(d.select).not.toHaveBeenCalled();
  });

  it('iPhone with a Bluetooth device: the SDK route picker, not a guess', async () => {
    rn.os = 'ios';
    sdk.devices = [device('earpiece'), device('speaker'), device('bluetooth')];
    sdk.nextCall = new FakeCall();
    await voice.placeInAppCall('o1', 'rider', deps());
    await flush();
    expect(voice.inCallSnapshot()?.routePicker).toBe(true);
    expect(await voice.setInCallSpeaker(true)).toBe(true);
    expect(sdk.voice.showAvRoutePickerView).toHaveBeenCalledTimes(1);
    for (const d of sdk.devices) expect(d.select).not.toHaveBeenCalled();
  });

  it('Hang up ends the call through the SDK and the bar goes at once', async () => {
    const call = new FakeCall();
    sdk.nextCall = call;
    await voice.placeInAppCall('o1', 'rider', deps());
    await voice.endInAppCall();
    expect(call.disconnect).toHaveBeenCalledTimes(1);
    expect(voice.inCallSnapshot()).toBeNull();
    expect(voice.inAppCallActive()).toBe(false);
  });
});

describe('[CALLS-UX] a call answered here (Android has no in-call screen for it)', () => {
  it('answered from the call notification while the app runs: the bar shows it', async () => {
    await voice.startInAppVoice();
    const invite = new Emitter();
    sdk.voice.emit('callInvite', invite);
    const call = new FakeCall('CA9');
    invite.emit('accepted', call);
    expect(voice.inCallSnapshot()?.phase).toBe('connecting');
    call.emit('connected');
    expect(voice.inCallSnapshot()?.phase).toBe('connected');
    await voice.setInCallSpeaker(true);
    expect(sdk.devices[1]?.select).toHaveBeenCalledTimes(1);
    call.emit('disconnected');
    expect(voice.inCallSnapshot()).toBeNull();
  });

  it('answered while the app was closed: found when the app comes back, with its real start time', async () => {
    const started = new Date(Date.now() - 65_000);
    const held = new FakeCall('CA5', started);
    held.state = 'connected';
    held.muted = true;
    const ended = new FakeCall('CA4');
    ended.state = 'disconnected';
    sdk.held = [ended, held];
    await voice.syncInAppCalls();
    expect(voice.inCallSnapshot()).toMatchObject({ phase: 'connected', connectedAt: started.getTime(), muted: true });
  });

  it('Mute pressed on CallKit\'s own screen is read back when the app comes back', async () => {
    const call = new FakeCall('CA7');
    sdk.nextCall = call;
    await voice.placeInAppCall('o1', 'rider', deps());
    const sameCallFromSdk = new FakeCall('CA7');
    sameCallFromSdk.state = 'connected';
    sameCallFromSdk.muted = true;
    sdk.held = [sameCallFromSdk];
    await voice.syncInAppCalls();
    expect(voice.inCallSnapshot()?.muted).toBe(true);
  });

  it('listens once, however often the voice starts', async () => {
    await voice.startInAppVoice();
    await voice.startInAppVoice();
    expect(sdk.voice.count('callInvite')).toBe(1);
    expect(sdk.voice.count('audioDevicesUpdated')).toBe(1);
  });
});
