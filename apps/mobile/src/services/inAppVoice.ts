/**
 * [INAPP-CALLS · owner 6 Nov 2026, "B"] The phone half of in-app calling: Twilio's
 * Voice React Native SDK (@twilio/voice-react-native-sdk 1.8.x), behind a guard.
 *
 * NATIVE-MODULE TRAP (memory: reference_swift_native_module_crash): the SDK throws
 * AT IMPORT when its native module is missing (src/common.ts: "if (typeof
 * nativeModule === 'undefined') throw"). Builds 11/12 have no such module, and an
 * over-the-air update carrying this file reaches them. So the SDK is never
 * imported statically: it is required only after NativeModules says the module
 * exists, inside a try/catch. On those builds `inAppVoiceAvailable()` is false,
 * "Call in app" never shows, and nothing else changes.
 *
 * What runs where:
 * - At every app start on a build that has the module: iOS initializes the SDK's
 *   PushKit registry (Apple: every VoIP push must be reported to CallKit, or iOS
 *   terminates the app; the SDK's registry does that), and both platforms set the
 *   call-screen template so an incoming call shows the server's role line
 *   ("Swift: your rider is calling about your order"), never a number.
 * - When the switch is on and the person is on a live order: register this phone
 *   with a short server token so it can be rung in the app.
 * - "Call in app": microphone permission (plain words first), then the server
 *   starts the call (party + cap checks) and the SDK connects with its call id.
 * Incoming calls are answered on the system's own call screen (CallKit on iPhone,
 * the call notification on Android); no JavaScript runs for that.
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { CALL_SCREEN_TEMPLATE, OUTGOING_HANDLE } from '../lib/inAppCalls';
import type { CallTarget } from '../lib/callBridge';
import { phaseOf, pickRoute, type InCallSnapshot } from '../lib/inCallBar';

/**
 * The few SDK members Swift uses (structural, so this file loads without the SDK; inAppVoice.sdkShape.test.ts
 * proves at type-check time that the installed SDK's own classes fit these shapes and event names).
 * [CALLS-UX] The in-call members are optional: a call object or SDK without them simply shows no such control.
 */
export interface SdkCall {
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
  mute?(mute: boolean): Promise<boolean>;
  isMuted?(): boolean | undefined;
  getState?(): string;
  getSid?(): string | undefined;
  getInitialConnectedTimestamp?(): Date | undefined;
}
export interface SdkAudioDevice {
  type: string;
  select(): Promise<void>;
}
export interface SdkCallInvite {
  on(event: string, listener: (...args: never[]) => void): unknown;
}
export interface SdkVoice {
  initializePushRegistry(): Promise<void>;
  setIncomingCallContactHandleTemplate(template?: string): Promise<void>;
  register(token: string): Promise<void>;
  unregister(token: string): Promise<void>;
  connect(token: string, options?: { params?: Record<string, string>; contactHandle?: string; notificationDisplayName?: string }): Promise<SdkCall>;
  on?(event: string, listener: (...args: never[]) => void): unknown;
  getCalls?(): Promise<ReadonlyMap<string, SdkCall>>;
  getCallInvites?(): Promise<ReadonlyMap<string, SdkCallInvite>>;
  getAudioDevices?(): Promise<{ audioDevices: SdkAudioDevice[]; selectedDevice?: SdkAudioDevice }>;
  showAvRoutePickerView?(): Promise<void>;
}
interface SdkModule {
  Voice: new () => SdkVoice;
}

/** The SDK's own event names Swift listens to (checked against the SDK's enums in inAppVoice.sdkShape.test.ts). */
export const SDK_EVENTS = {
  callConnected: 'connected',
  callRinging: 'ringing',
  callReconnecting: 'reconnecting',
  callReconnected: 'reconnected',
  callDisconnected: 'disconnected',
  callConnectFailure: 'connectFailure',
  voiceCallInvite: 'callInvite',
  voiceAudioDevicesUpdated: 'audioDevicesUpdated',
  inviteAccepted: 'accepted',
  inviteRejected: 'rejected',
  inviteCancelled: 'cancelled',
} as const;

const NATIVE_NAME = 'TwilioVoiceReactNative';

/** The app always loads the real package; tests hand in their own (a Metro `require` is not a vitest module). */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const defaultLoad = (): unknown => require('@twilio/voice-react-native-sdk');
let load: () => unknown = defaultLoad;

let sdk: SdkModule | null | undefined;
function loadSdk(): SdkModule | null {
  if (sdk !== undefined) return sdk;
  sdk = null;
  try {
    // Never evaluated on a binary without the native module (the SDK throws at import there).
    if (!(NativeModules as Record<string, unknown>)[NATIVE_NAME]) return sdk;
    const mod = load() as SdkModule | null | undefined;
    sdk = typeof mod?.Voice === 'function' ? mod : null;
  } catch {
    sdk = null;
  }
  return sdk;
}

let voice: SdkVoice | null = null;
function getVoice(): SdkVoice | null {
  if (voice) return voice;
  const mod = loadSdk();
  if (!mod) return null;
  try {
    voice = new mod.Voice();
  } catch {
    voice = null;
  }
  return voice;
}

/** Does this phone's app have in-app calling at all (build 13 and later)? */
export function inAppVoiceAvailable(): boolean {
  return getVoice() !== null;
}

/**
 * [native review 5] "This phone has registered to be rung in the app" survives restarts (a plain flag, nothing
 * personal). Until a phone first registers, Twilio has no binding for it and Apple no VoIP token, so no VoIP push
 * can ever reach it: the SDK (CallKit, audio, PushKit) is not started at all. Once it has registered, the PushKit
 * registry starts at EVERY launch, before any network answer, because a VoIP push may be what launched the app
 * and iOS ends an app that does not report it to CallKit at once. The flag clears after a successful unregister.
 */
const FLAG_KEY = 'registeredOnce';
export interface FlagStore { getBoolean(k: string): boolean | undefined; set(k: string, v: boolean): void; delete(k: string): void }
/** A plain (not encrypted) MMKV file: readable at once at launch, before the Keychain is open. Loaded lazily, so
 *  screens that import this file do not load the storage module at import. */
const defaultFlags = (): FlagStore => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MMKV } = require('react-native-mmkv') as { MMKV: new (o: { id: string }) => FlagStore };
  return new MMKV({ id: 'swift-inapp-calls' });
};
let makeFlags: () => FlagStore = defaultFlags;
let flagStore: FlagStore | null | undefined;
function flags() {
  if (flagStore !== undefined) return flagStore;
  try { flagStore = makeFlags(); } catch { flagStore = null; }
  return flagStore;
}
function registeredOnce(): boolean {
  try { return flags()?.getBoolean(FLAG_KEY) === true; } catch { return false; }
}
function setRegisteredOnce(on: boolean): void {
  try { if (on) flags()?.set(FLAG_KEY, true); else flags()?.delete(FLAG_KEY); } catch { /* best effort */ }
}

/** App start: the calling SDK only on a phone that has registered for in-app calls before (see above). */
export async function startInAppVoiceIfRegistered(): Promise<void> {
  if (!registeredOnce()) return;
  await startInAppVoice();
}

let started = false;
let startedAt = 0;
let seeded = false;
/** The PushKit registry (iPhone) and the call-screen template. Never throws. */
export async function startInAppVoice(): Promise<void> {
  if (started) return;
  const v = getVoice();
  if (!v) return;
  started = true;
  startedAt = Date.now();
  try {
    if (Platform.OS === 'ios') await v.initializePushRegistry();
  } catch { /* the next start tries again */ }
  try {
    await v.setIncomingCallContactHandleTemplate(CALL_SCREEN_TEMPLATE);
  } catch { /* the default handle is Swift's client name, never a number */ }
  watchVoice(v);
}

/** Platform name the server picks the push credential by. */
export function voicePlatform(): 'ios' | 'android' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

const REGISTER_EVERY_MS = 10 * 60_000;
/** iPhone: PushKit hands the VoIP token over shortly after the registry starts; one retry after this wait. */
export const FIRST_REGISTER_RETRY_MS = 2_000;
let registeredAt = 0;

export type VoiceTokenFetch = (platform: 'ios' | 'android', purpose: 'register' | 'unregister') => Promise<string>;

/** Android: may the SDK ring this phone? It silently drops a ring without the microphone (Android 11+). Never asks. */
async function canBeRung(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iPhone: CallKit rings; the system asks for the microphone on Answer
  try { return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO); } catch { return false; }
}

/** What a register attempt came to. `not-live`: the server refused it because the person is on no live order
 *  (403 INAPP_NO_LIVE_ORDER), the one positive answer that this phone should no longer be rung. */
export type RegisterResult = 'registered' | 'throttled' | 'unavailable' | 'no-mic' | 'not-live' | 'failed' | 'stale';

const errorCode = (e: unknown): string | null =>
  (e as { response?: { data?: { error?: { code?: unknown } } } })?.response?.data?.error?.code as string | null ?? null;

/**
 * [CALLS-REACH S3-1] Sign-out / account-switch boundary. Every unregister moves it on; a register that STARTED before
 * the move never saves its throttle or the launch flag (it would mark the next account, or hold its register back for
 * ten minutes). `marks` counts saved registrations: an unregister that finishes after a newer registration leaves
 * that registration's flag and throttle alone.
 */
let voiceGeneration = 0;
let marks = 0;

/** Could this phone still hold an in-app binding (registered this run, or in an earlier one)? */
export function mayBeRegistered(): boolean {
  return registeredAt > 0 || registeredOnce();
}

/**
 * Let this phone be rung in the app. `fetchToken` asks the server (only people on a live order get one; the
 * server rings only phones that registered). At most every ten minutes unless `force` (a check with the server
 * after the app's own reads stopped showing a live order); a failure is quiet (the phone bridge still reaches them).
 * [native review S2] Android without the microphone: never registers (and removes an earlier registration), so
 * the server sends their calls to the phone bridge instead of a ring the SDK would drop.
 */
export async function registerForInAppCallsResult(
  fetchToken: VoiceTokenFetch,
  opts: { force?: boolean; now?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<RegisterResult> {
  const now = opts.now ?? Date.now();
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const v = getVoice();
  if (!v) return 'unavailable';
  if (!opts.force && now - registeredAt < REGISTER_EVERY_MS) return 'throttled';
  if (!(await canBeRung())) {
    if (mayBeRegistered()) await unregisterInAppCalls((platform) => fetchToken(platform, 'unregister'));
    return 'no-mic';
  }
  const gen = voiceGeneration;
  const firstStart = !started;
  await startInAppVoice();
  const attempt = async () => { await v.register(await fetchToken(voicePlatform(), 'register')); };
  try {
    try {
      await attempt();
    } catch (err) {
      if (errorCode(err) === 'INAPP_NO_LIVE_ORDER' || !(firstStart && Platform.OS === 'ios')) throw err;
      await wait(FIRST_REGISTER_RETRY_MS);
      await attempt();
    }
  } catch (err) {
    return errorCode(err) === 'INAPP_NO_LIVE_ORDER' ? 'not-live' : 'failed';
  }
  if (gen !== voiceGeneration) return 'stale';
  registeredAt = now;
  marks += 1;
  setRegisteredOnce(true);
  return 'registered';
}

/** The yes/no form (the "Call in app" control's own registration). */
export async function registerForInAppCalls(fetchToken: VoiceTokenFetch, now = Date.now(), wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<boolean> {
  return (await registerForInAppCallsResult(fetchToken, { now, wait })) === 'registered';
}

/** Bound so a slow network never holds up a sign-out. */
export const UNREGISTER_TIMEOUT_MS = 5_000;

/**
 * [SECURITY REVIEW, MEDIUM] Sign-out, account switch or a refused session: remove this phone's in-app call
 * binding BEFORE the session is torn down. `fetchToken` must ask the server with the OLD session's own
 * credentials (the token names that session's identity and no other). The throttle is reset whatever
 * happens, so the next account registers at once under its own identity. If this fails (offline, the session
 * already refused), the server still never rings the old identity: it is per session and the session is gone.
 * Also used when the phone should no longer be rung (no live order, the microphone taken away).
 */
export async function unregisterInAppCalls(fetchToken: (platform: 'ios' | 'android') => Promise<string>): Promise<boolean> {
  const wasRegistered = mayBeRegistered();
  voiceGeneration += 1;
  const mine = marks;
  registeredAt = 0;
  const v = getVoice();
  // [native review 4] Never registered on this phone (in-app calls off, or never offered): nothing to remove,
  // no request at all, sign-out goes straight on.
  if (!v || !wasRegistered) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      await v.unregister(await fetchToken(voicePlatform()));
      if (marks === mine) setRegisteredOnce(false);
      return true;
    })();
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), UNREGISTER_TIMEOUT_MS); });
    return await Promise.race([work, timeout]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (marks === mine) registeredAt = 0;
  }
}

/**
 * Microphone, asked at the moment it is needed. Android: Swift's own words first (the system prompt has none).
 * iPhone: the system asks on the first call with the purpose string from app.config.ts.
 */
export async function ensureMicrophone(explain: () => Promise<boolean>): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const mic = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(mic)) return true;
  if (!(await explain())) return false;
  return (await PermissionsAndroid.request(mic)) === PermissionsAndroid.RESULTS.GRANTED;
}

// ---------------------------------------------------------------------------
// [CALLS-UX · owner 8 Nov 2026, "B"] The call that is on now (placed here, or answered here), for the in-call
// bar: its state and time, Mute, Speaker and Hang up. One at a time: the newest call is the one shown.
// ---------------------------------------------------------------------------

let current: { call: SdkCall; snap: InCallSnapshot; onEnded?: () => void; off: () => void } | null = null;
const inCallListeners = new Set<() => void>();
/**
 * [CALLS-UX review S4] SIDs of calls this phone stopped following (ended, hung up, failed): a read of the SDK's
 * calls that still lists one (the SDK may not have dropped it yet) never brings it back onto the bar.
 */
const endedSids = new Set<string>();
const sidOf = (call: SdkCall): string | undefined => { try { return call.getSid?.() ?? undefined; } catch { return undefined; } };

/**
 * Stop following the call on the bar: its listeners come off, a Mute/Speaker change still on its way for it no
 * longer holds the buttons (review A2: a native answer that never comes must not leave them dead), and it is never
 * picked up again. `sameCallFollows`: the SDK handed over another object for this SAME call (review A1), so its SID
 * stays live (CallKit's Mute is still read back for it).
 */
function release(entry: NonNullable<typeof current>, sameCallFollows = false): void {
  entry.off();
  muteInFlight = null;
  speakerInFlight = null;
  const sid = sidOf(entry.call);
  if (sid && !sameCallFollows) {
    endedSids.add(sid);
    if (endedSids.size > 20) endedSids.delete(endedSids.values().next().value as string);
  }
}
const emitInCall = () => { for (const l of [...inCallListeners]) { try { l(); } catch { /* one listener never stops the rest */ } } };

/** The bar's view of the call that is on now, or null. A new object on every change (React's external store). */
export function inCallSnapshot(): InCallSnapshot | null {
  return current?.snap ?? null;
}

export function subscribeInCall(listener: () => void): () => void {
  inCallListeners.add(listener);
  return () => { inCallListeners.delete(listener); };
}

function patch(call: SdkCall, next: Partial<InCallSnapshot>): void {
  if (!current || current.call !== call) return;
  current = { ...current, snap: { ...current.snap, ...next } };
  emitInCall();
}

const connectedAtOf = (call: SdkCall): number | null => {
  try { return call.getInitialConnectedTimestamp?.()?.getTime() ?? null; } catch { return null; }
};

/** Read the route the phone is on now (the SDK's getAudioDevices); nothing is selected here. */
async function readRoute(call: SdkCall): Promise<void> {
  const v = getVoice();
  if (!v?.getAudioDevices) return;
  try {
    const { audioDevices, selectedDevice } = await v.getAudioDevices();
    patch(call, {
      speaker: selectedDevice?.type === 'speaker',
      routePicker: Platform.OS === 'ios' && audioDevices.some((d) => d.type === 'bluetooth') && typeof v.showAvRoutePickerView === 'function',
    });
  } catch { /* the bar keeps what it last knew */ }
}

/**
 * Show this call on the bar and follow it until it ends. `onFailed`: the SDK reported connectFailure while this
 * phone still followed the call (not after Hang up here).
 * [CALLS-UX review S4] The listeners added here are removed when the bar stops following the call (ended, hung up,
 * or replaced by a newer call), so a call object the bar dropped holds nothing of Swift's.
 */
function trackCall(call: SdkCall, onEnded?: () => void, onFailed?: () => void): void {
  if (current?.call === call) return;
  let phase: InCallSnapshot['phase'] = 'connecting';
  try { phase = phaseOf(call.getState?.()) ?? 'connecting'; } catch { /* connecting */ }
  let muted = false;
  try { muted = call.isMuted?.() === true; } catch { /* not muted */ }
  const connectedAt = connectedAtOf(call) ?? (phase === 'connected' ? Date.now() : null);
  const ended = () => {
    if (current?.call !== call) return;
    const done = current.onEnded;
    release(current);
    current = null;
    emitInCall();
    done?.();
  };
  const failed = () => {
    const mine = current?.call === call;
    ended();
    if (mine) onFailed?.();
  };
  const connected = () => {
    const at = current?.call === call ? current.snap.connectedAt : null;
    patch(call, { phase: 'connected', connectedAt: at ?? connectedAtOf(call) ?? Date.now() });
    void readRoute(call);
  };
  const listeners: Array<[string, () => void]> = [
    [SDK_EVENTS.callConnected, connected],
    [SDK_EVENTS.callReconnected, connected],
    [SDK_EVENTS.callRinging, () => patch(call, { phase: 'ringing' })],
    [SDK_EVENTS.callReconnecting, () => patch(call, { phase: 'reconnecting' })],
    [SDK_EVENTS.callDisconnected, ended],
    [SDK_EVENTS.callConnectFailure, failed],
  ];
  const added: typeof listeners = [];
  const off = () => {
    for (const [event, listener] of added.splice(0)) {
      try { call.removeListener?.(event, listener); } catch { /* best effort */ }
    }
  };
  // One call on the bar at a time: the newest. The same call under a new object (a sync found it before the
  // answer's own object arrived) only moves the listeners over.
  if (current) { const sid = sidOf(call); release(current, !!sid && sidOf(current.call) === sid); }
  current = { call, onEnded, off, snap: { phase, connectedAt, muted, speaker: false, routePicker: false } };
  try {
    for (const pair of listeners) { call.on(pair[0], pair[1]); added.push(pair); }
  } catch { /* the call still runs; Hang up and the system's own screen still end it */ }
  emitInCall();
  void readRoute(call);
}

let watched: SdkVoice | null = null;
/** Answered calls (the system's call screen or notification) and route changes (CallKit's own Speaker too). */
function watchVoice(v: SdkVoice): void {
  if (watched === v || typeof v.on !== 'function') return;
  watched = v;
  try {
    v.on(SDK_EVENTS.voiceCallInvite, followInvite);
    v.on(SDK_EVENTS.voiceAudioDevicesUpdated, (devices: SdkAudioDevice[], selected?: SdkAudioDevice) => {
      if (!current) return;
      patch(current.call, {
        speaker: selected?.type === 'speaker',
        routePicker: Platform.OS === 'ios' && (devices ?? []).some((d) => d.type === 'bluetooth') && typeof v.showAvRoutePickerView === 'function',
      });
    });
  } catch { /* no listener: the bar still shows calls placed here */ }
  void seedFromSdk(v);
}

/** [OTA-CATCH-UP · REVIEW-1 S3-2 on #2431] Ringing until answered, rejected or cancelled (or the longest ring). */
function followInvite(invite: SdkCallInvite): void {
  if (ringing.has(invite)) return;
  ringing.add(invite);
  const settled = () => { ringing.delete(invite); };
  setTimeout(settled, INVITE_RING_MAX_MS);
  try {
    invite.on(SDK_EVENTS.inviteAccepted, (call: SdkCall) => { settled(); trackCall(call); });
    invite.on(SDK_EVENTS.inviteRejected, settled);
    invite.on(SDK_EVENTS.inviteCancelled, settled);
  } catch { settled(); /* the sync on return to the app finds an answered call */ }
}

/**
 * [OTA-CATCH-UP · REVIEW-2 S2-1 on #2431] A call can ring (or be answered on the system's screen) before Swift's
 * listener exists: the invite that WOKE a closed app arrives while the push registry starts. Ask the SDK for the
 * invites and calls it already holds; until that answer is in, the phone counts as ringing.
 */
async function seedFromSdk(v: SdkVoice): Promise<void> {
  try {
    const invites = await v.getCallInvites?.();
    for (const invite of invites?.values() ?? []) followInvite(invite);
  } catch { /* the events still arrive */ }
  try { await syncInAppCalls(); } catch { /* the next return asks again */ }
  seeded = true;
}

/**
 * A call answered while the app's JavaScript was not running (the answer launched the app), or Mute pressed on
 * CallKit's own screen: ask the SDK for the calls it holds. Runs at start and whenever the app comes back.
 * [CALLS-UX review S4] Deduped by call SID: the call the bar already follows is kept (only its Mute is read back),
 * never a second copy. Every getCalls() makes NEW call objects, and the SDK subscribes each one to its native call
 * events in the Call constructor with no public way to undo it, so Swift asks only when it can matter: with no call
 * on the bar (one may have been answered), or on iPhone (CallKit's own Mute). Android with a call on the bar has no
 * other place to change it, so only the audio route is read there.
 */
export async function syncInAppCalls(): Promise<void> {
  const v = getVoice();
  if (!v?.getCalls) return;
  if (current && Platform.OS !== 'ios') { await readRoute(current.call); return; }
  let calls: SdkCall[];
  try { calls = [...(await v.getCalls()).values()]; } catch { return; }
  const live = calls.filter((c) => {
    try { return phaseOf(c.getState?.()) !== null && !endedSids.has(sidOf(c) ?? ''); } catch { return false; }
  });
  const tracked = current; // read again: a call may have been answered or ended while the SDK answered
  if (!tracked) {
    const call = live[live.length - 1];
    if (call) trackCall(call);
    return;
  }
  const sid = sidOf(tracked.call);
  const same = sid ? live.find((c) => sidOf(c) === sid) : undefined;
  if (same) {
    let muted: boolean | undefined;
    try { muted = same.isMuted?.(); } catch { muted = undefined; }
    if (typeof muted === 'boolean') patch(tracked.call, { muted });
  }
  await readRoute(tracked.call);
}

/** [CALLS-UX review S4] A Mute or Speaker change on its way to the SDK: a second quick tap is ignored until it lands
 *  (the bar's button still shows the old state, so that tap would send the same value again). */
let muteInFlight: SdkCall | null = null;
let speakerInFlight: SdkCall | null = null;

/** Mute or unmute this side of the call (the SDK's call.mute). Resolves with the muted state the SDK reports, or
 *  null when nothing was sent (no call, no SDK member, or a change already on its way). */
export async function setInCallMuted(muted: boolean): Promise<boolean | null> {
  const c = current;
  if (!c?.call.mute || muteInFlight === c.call) return null;
  muteInFlight = c.call;
  try {
    const now = await c.call.mute(muted);
    patch(c.call, { muted: now === true });
    return now === true;
  } catch {
    return null;
  } finally {
    if (muteInFlight === c.call) muteInFlight = null;
  }
}

/**
 * Speaker on / off with the SDK's own audio devices (getAudioDevices, then AudioDevice.select). Never stored and
 * put back later: the bar only follows the route the phone reports, so CallKit's own Speaker and this one agree.
 * iPhone with a Bluetooth device: the system's route picker (the SDK's iOS route API) lets the person choose.
 */
export async function setInCallSpeaker(on: boolean): Promise<boolean> {
  const c = current;
  const v = getVoice();
  if (!c || !v?.getAudioDevices || speakerInFlight === c.call) return false;
  speakerInFlight = c.call;
  try {
    const { audioDevices } = await v.getAudioDevices();
    if (Platform.OS === 'ios' && v.showAvRoutePickerView && audioDevices.some((d) => d.type === 'bluetooth')) {
      await v.showAvRoutePickerView();
      return true;
    }
    const device = pickRoute(audioDevices, on);
    if (!device) return false;
    await device.select();
    patch(c.call, { speaker: on });
    return true;
  } catch {
    await readRoute(c.call);
    return false;
  } finally {
    if (speakerInFlight === c.call) speakerInFlight = null;
  }
}

/** Is an in-app call (placed or answered here) still on? */
export function inAppCallActive(): boolean {
  return current !== null;
}

/** [OTA-CATCH-UP · REVIEW-1 S3-2 on #2431] The longest an unanswered invite counts as ringing (an invite the SDK never
 *  settles must not hold the app for ever; a real ring ends well before). */
export const INVITE_RING_MAX_MS = 90_000;
const ringing = new Set<SdkCallInvite>();
/** [REVIEW-2 S2-1 on #2431] The longest the voice start counts as "may be ringing" before the SDK has said what it
 *  holds (a start that never finishes must not hold the app for ever). */
export const SEED_MAX_MS = 15_000;
/** Is an in-app call ringing on this phone (an invite not yet answered, rejected or cancelled), or may one be: the
 *  calling SDK started and has not yet said which invites and calls it already holds? */
export function inAppCallRinging(now: number = Date.now()): boolean {
  if (ringing.size > 0) return true;
  return started && !seeded && now - startedAt < SEED_MAX_MS;
}

export interface PlaceDeps {
  start: (orderId: string, target: CallTarget, platform: 'ios' | 'android') => Promise<{ callId: string; token: string }>;
  cancel: (callId: string) => Promise<unknown>;
  onEnded?: () => void;
  /** [CALLS-UX review S3] The server accepted, then the SDK reported connectFailure (never after Hang up here). */
  onConnectFailure?: () => void;
}

/** Free the server's call row Twilio never took, at once rather than in a minute. Never throws. */
const cancelQuietly = (deps: PlaceDeps, callId: string): Promise<void> =>
  Promise.resolve().then(() => deps.cancel(callId)).then(() => undefined, () => undefined);

/**
 * Start an in-app call. Throws (with a server code when there is one) when it could not start; when the server
 * accepted but this phone's connect threw, the code is INAPP_CONNECT_FAILED (the SDK's own error is the cause).
 */
export async function placeInAppCall(orderId: string, target: CallTarget, deps: PlaceDeps): Promise<void> {
  const v = getVoice();
  if (!v) throw Object.assign(new Error('in-app calling not available'), { code: 'INAPP_UNAVAILABLE' });
  await startInAppVoice(); // CallKit / the call-screen template, if this phone has not started them yet
  const { callId, token } = await deps.start(orderId, target, voicePlatform());
  let call: SdkCall;
  try {
    call = await v.connect(token, { params: { callId }, contactHandle: OUTGOING_HANDLE, notificationDisplayName: OUTGOING_HANDLE });
  } catch (err) {
    await cancelQuietly(deps, callId);
    throw Object.assign(new Error('in-app call did not connect'), { code: 'INAPP_CONNECT_FAILED', cause: err });
  }
  trackCall(call, deps.onEnded, () => {
    void cancelQuietly(deps, callId);
    deps.onConnectFailure?.();
  });
}

/** End the call that is on (Hang up, or "End call" on the order screen; the system call screen also ends it). */
export async function endInAppCall(): Promise<void> {
  const c = current;
  current = null;
  if (c) { release(c); emitInCall(); }
  await c?.call.disconnect().catch(() => undefined);
}

/** Tests only: forget everything; `loader` stands in for the package (default: the real one). */
export function resetInAppVoiceForTests(loader: () => unknown = defaultLoad, flagsFactory: () => FlagStore = defaultFlags): void {
  sdk = undefined; voice = null; started = false; startedAt = 0; seeded = false; registeredAt = 0; current = null; watched = null; load = loader;
  inCallListeners.clear(); endedSids.clear(); ringing.clear(); muteInFlight = null; speakerInFlight = null;
  voiceGeneration = 0; marks = 0;
  flagStore = undefined; makeFlags = flagsFactory;
}
