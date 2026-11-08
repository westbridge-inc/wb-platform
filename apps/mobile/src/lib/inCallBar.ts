/**
 * [CALLS-UX · owner 8 Nov 2026, "B"] The bar Swift shows while an in-app call is on: the call's state and
 * time, Mute, Speaker and Hang up. Android has no call screen of its own for an answered in-app call (only a
 * notification), so this is how a rider puts a call on the speaker. iPhone keeps CallKit's screen; the bar
 * mirrors the route the phone reports and never puts back a choice of its own, so it never fights CallKit.
 *
 * Pure: no React, no native module. The device and call objects are the Twilio Voice SDK's own
 * (AudioDevice.Type values "earpiece" | "speaker" | "bluetooth" | "unknown"; Call.State values).
 */

export type InCallPhase = 'connecting' | 'ringing' | 'connected' | 'reconnecting';

export interface InCallSnapshot {
  phase: InCallPhase;
  /** When the call first connected (ms), for the timer; null until it has. */
  connectedAt: number | null;
  muted: boolean;
  /** The phone says the sound is on the loudspeaker now. */
  speaker: boolean;
  /** iPhone with a Bluetooth device: the system's own route picker (the SDK's iOS route API) instead of a toggle. */
  routePicker: boolean;
}

/** The SDK's Call.State, as Swift's bar reads it. Disconnected (or anything unknown) is "no call". */
export function phaseOf(state: string | null | undefined): InCallPhase | null {
  switch (state) {
    case 'connecting':
    case 'ringing':
    case 'connected':
    case 'reconnecting':
      return state;
    default:
      return null;
  }
}

/** The structural slice of the SDK's AudioDevice the bar uses. */
export interface RouteDevice {
  type: string;
  select(): Promise<void>;
}

/**
 * The device to select for Speaker on / off. On: the loudspeaker. Off: a Bluetooth headset if one is
 * connected (the person brought it for a reason), else the earpiece, else anything that is not the speaker.
 */
export function pickRoute<D extends RouteDevice>(devices: readonly D[], speakerOn: boolean): D | null {
  if (speakerOn) return devices.find((d) => d.type === 'speaker') ?? null;
  return devices.find((d) => d.type === 'bluetooth')
    ?? devices.find((d) => d.type === 'earpiece')
    ?? devices.find((d) => d.type !== 'speaker')
    ?? null;
}

/** "0:07", "12:34", "1:02:03". */
export function callTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The plain words people read on the bar. */
export const INCALL_WORDS = {
  title: 'Swift call',
  connecting: 'Connecting',
  ringing: 'Ringing',
  reconnecting: 'Reconnecting',
  mute: 'Mute',
  unmute: 'Unmute',
  speaker: 'Speaker',
  /** iPhone with a headset: opens the phone's own audio picker. */
  audio: 'Audio',
  hangUp: 'Hang up',
  muteHint: 'The other person cannot hear you while you are muted.',
  speakerHint: 'Plays the call out loud on this phone.',
  audioHint: 'Choose the speaker, the phone or your headset.',
  hangUpHint: 'Ends the call.',
} as const;

/** The state line: "Ringing", or the time once connected. */
export function inCallStatus(snap: Pick<InCallSnapshot, 'phase' | 'connectedAt'>, now: number): string {
  switch (snap.phase) {
    case 'connecting': return INCALL_WORDS.connecting;
    case 'ringing': return INCALL_WORDS.ringing;
    case 'reconnecting': return INCALL_WORDS.reconnecting;
    case 'connected': return snap.connectedAt === null ? callTimer(0) : callTimer(now - snap.connectedAt);
  }
}
