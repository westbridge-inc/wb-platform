import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ NativeModules: {}, Platform: { OS: 'android' }, PermissionsAndroid: {} }));
// Types only: erased at run time, so the SDK (which throws at import without its native module) is never loaded.
import type { AudioDevice, Call, CallInvite, Voice } from '@twilio/voice-react-native-sdk';
import { SDK_EVENTS, type SdkAudioDevice, type SdkCall, type SdkCallInvite, type SdkVoice } from './inAppVoice';

// [CALLS-UX · owner 8 Nov 2026] "Never guess the API." services/inAppVoice.ts talks to the Twilio Voice SDK through
// small structural shapes so it can load on builds without the module. These checks run in the app's type-check
// (tsc covers src/**, tests included): if the installed SDK (@twilio/voice-react-native-sdk, pinned in package.json)
// renamed or retyped a member or an event Swift uses, the type-check goes red here.

type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export type SdkShapeChecks = [
  Assert<Fits<Voice, SdkVoice>>,
  Assert<Fits<Call, SdkCall>>,
  Assert<Fits<CallInvite, SdkCallInvite>>,
  Assert<Fits<AudioDevice, SdkAudioDevice>>,
  // The members the in-call bar needs are really there (not only allowed by the optional shapes).
  Assert<Fits<Voice['getAudioDevices'], () => Promise<{ audioDevices: AudioDevice[]; selectedDevice?: AudioDevice }>>>,
  Assert<Fits<Voice['getCalls'], () => Promise<ReadonlyMap<string, Call>>>>,
  Assert<Fits<Voice['getCallInvites'], () => Promise<ReadonlyMap<string, CallInvite>>>>,
  Assert<Fits<Voice['showAvRoutePickerView'], () => Promise<void>>>,
  Assert<Fits<Call['mute'], (mute: boolean) => Promise<boolean>>>,
  // [CALLS-UX review S4] The bar takes its listeners off a call it stops following.
  Assert<Fits<Call, Required<Pick<SdkCall, 'removeListener'>>>>,
  Assert<Fits<Call['isMuted'], () => boolean | undefined>>,
  Assert<Fits<Call['getState'], () => `${Call.State}`>>,
  Assert<Fits<AudioDevice['select'], () => Promise<void>>>,
  // Event and device names are the SDK's own enum values.
  Assert<Same<typeof SDK_EVENTS.callConnected, `${Call.Event.Connected}`>>,
  Assert<Same<typeof SDK_EVENTS.callRinging, `${Call.Event.Ringing}`>>,
  Assert<Same<typeof SDK_EVENTS.callReconnecting, `${Call.Event.Reconnecting}`>>,
  Assert<Same<typeof SDK_EVENTS.callReconnected, `${Call.Event.Reconnected}`>>,
  Assert<Same<typeof SDK_EVENTS.callDisconnected, `${Call.Event.Disconnected}`>>,
  Assert<Same<typeof SDK_EVENTS.callConnectFailure, `${Call.Event.ConnectFailure}`>>,
  Assert<Same<typeof SDK_EVENTS.voiceCallInvite, `${Voice.Event.CallInvite}`>>,
  Assert<Same<typeof SDK_EVENTS.voiceAudioDevicesUpdated, `${Voice.Event.AudioDevicesUpdated}`>>,
  Assert<Same<typeof SDK_EVENTS.inviteAccepted, `${CallInvite.Event.Accepted}`>>,
  Assert<Same<typeof SDK_EVENTS.inviteRejected, `${CallInvite.Event.Rejected}`>>,
  Assert<Same<typeof SDK_EVENTS.inviteCancelled, `${CallInvite.Event.Cancelled}`>>,
  Assert<Same<'speaker' | 'earpiece' | 'bluetooth' | 'unknown', `${AudioDevice.Type}`>>,
  Assert<Same<'connecting' | 'ringing' | 'connected' | 'reconnecting' | 'disconnected', `${Call.State}`>>,
];

describe('[CALLS-UX] the SDK members and events Swift uses', () => {
  it('are spelled as the SDK spells them (the type-check proves them against the installed SDK)', () => {
    expect(SDK_EVENTS).toEqual({
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
    });
  });
});
