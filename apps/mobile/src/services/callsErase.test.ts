import { beforeEach, describe, expect, it, vi } from 'vitest';
// Types only: erased at run time, so the SDK (which throws at import without its native module) is never loaded.
import type { Voice } from '@twilio/voice-react-native-sdk';

// ---------------------------------------------------------------------------
// [CALLS-ERASE · legal review F1, 9 Nov 2026] Taking the phone out of in-app calls before the account ends, and what
// happens when the session was already ended somewhere else ("sign out other devices", a deletion made on another
// phone, a refused refresh, an expired session): the real services/inAppVoice with a stand-in SDK.
// ---------------------------------------------------------------------------

const rn = vi.hoisted(() => ({ native: { TwilioVoiceReactNative: {} } as Record<string, unknown> }));
const sdkState = vi.hoisted(() => ({ calls: [] as Array<{ m: string; a: unknown[] }> }));
const api = vi.hoisted(() => ({ live: vi.fn(), signOut: vi.fn() }));

vi.mock('react-native', () => ({
  NativeModules: new Proxy({}, { get: (_t, k: string) => rn.native[k] }),
  Platform: { OS: 'ios' },
  PermissionsAndroid: { PERMISSIONS: { RECORD_AUDIO: 'a' }, RESULTS: { GRANTED: 'granted' }, check: vi.fn(async () => true) },
}));
vi.mock('./api', () => ({ inAppUnregisterTokenForLiveSession: api.live, inAppUnregisterToken: api.signOut }));

const disk = new Map<string, boolean>();
const fakeFlags = () => ({
  getBoolean: (k: string) => disk.get(k),
  set: (k: string, v: boolean) => { disk.set(k, v); },
  delete: (k: string) => { disk.delete(k); },
});
const fakeSdk = () => {
  class FakeVoice {
    initializePushRegistry = vi.fn(async () => undefined);
    setIncomingCallContactHandleTemplate = vi.fn(async () => undefined);
    register = vi.fn(async (t: string) => { sdkState.calls.push({ m: 'register', a: [t] }); });
    unregister = vi.fn(async (t: string) => { sdkState.calls.push({ m: 'unregister', a: [t] }); });
    connect = vi.fn();
  }
  return { Voice: FakeVoice };
};

import * as voice from './inAppVoice';
import { unregisterCallsBeforeAccountEnds } from './callsErase';

const session = { userId: 'synthetic-subject', generation: 3, accessToken: 'live-access', refreshToken: 'live-refresh' } as never;
const refused = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });

async function registerThisPhone(): Promise<void> {
  expect(await voice.registerForInAppCalls(async () => 'register-tok', Date.now(), async () => undefined)).toBe(true);
  sdkState.calls = [];
}

beforeEach(() => {
  voice.resetInAppVoiceForTests(fakeSdk, fakeFlags);
  sdkState.calls = []; disk.clear(); api.live.mockReset(); api.signOut.mockReset();
});

describe('[CALLS-ERASE] before a deletion or closure', () => {
  it('asks for the removal token with the LIVE session (refresh-capable client) and hands it to the SDK', async () => {
    await registerThisPhone();
    api.live.mockImplementation(async (_s: unknown, platform: string) => `removal-${platform}`);
    expect(await unregisterCallsBeforeAccountEnds(session)).toBe(true);
    expect(api.live).toHaveBeenCalledWith(session, 'ios');
    expect(sdkState.calls).toEqual([{ m: 'unregister', a: ['removal-ios'] }]);
    expect(voice.mayBeRegistered()).toBe(false);
  });

  it('a phone that never registered sends nothing', async () => {
    expect(await unregisterCallsBeforeAccountEnds(session)).toBe(false);
    expect(api.live).not.toHaveBeenCalled();
    expect(sdkState.calls).toEqual([]);
  });

  it('a refused token fetch never throws and never stops what follows', async () => {
    await registerThisPhone();
    api.live.mockRejectedValue(refused);
    await expect(unregisterCallsBeforeAccountEnds(session)).resolves.toBe(false);
    expect(sdkState.calls).toEqual([]);
  });

  it('a slow network is bounded, so the deletion is never held up for long', async () => {
    vi.useFakeTimers();
    try {
      await registerThisPhone();
      api.live.mockReturnValue(new Promise<string>(() => undefined));
      const pending = unregisterCallsBeforeAccountEnds(session);
      await vi.advanceTimersByTimeAsync(voice.UNREGISTER_TIMEOUT_MS);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('then the sign-out after the deletion sends nothing more (the phone is already out)', async () => {
    await registerThisPhone();
    api.live.mockResolvedValue('removal-ios');
    await unregisterCallsBeforeAccountEnds(session);
    sdkState.calls = [];
    // The sign-out teardown's own fetch (the server has revoked the session by now) is never even asked.
    expect(await voice.unregisterInAppCalls(async () => { throw refused; })).toBe(false);
    expect(sdkState.calls).toEqual([]);
  });
});

describe('[CALLS-ERASE] the session was already ended elsewhere (sign out everywhere, expired, refused)', () => {
  it('the removal token cannot be fetched: no SDK call without a token, the sign-out goes on, the phone stays marked', async () => {
    await registerThisPhone();
    // authStore revokeCapturedSession: the captured session's token fetch is refused (401).
    expect(await voice.unregisterInAppCalls(async () => { throw refused; })).toBe(false);
    expect(sdkState.calls).toEqual([]);
    // Still marked as possibly registered: the iPhone keeps starting its PushKit registry at launch (a VoIP push
    // that does arrive must be reported to CallKit), and the next session's register runs at once.
    expect(voice.mayBeRegistered()).toBe(true);
    expect(await voice.registerForInAppCalls(async () => 'next-session-tok', Date.now(), async () => undefined)).toBe(true);
    expect(sdkState.calls).toEqual([{ m: 'register', a: ['next-session-tok'] }]);
  });
});

// The SDK has NO token-free, local unregister to fall back on (see services/callsErase.ts). If a future SDK adds
// one, this type-check goes red so the fallback is wired in where the token cannot be fetched.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type NoLocalUnregister = [
  Assert<Same<Extract<keyof Voice, `${string}nregister${string}`>, 'unregister'>>,
  Assert<Same<Parameters<Voice['unregister']>, [token: string]>>,
];
