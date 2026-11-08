import { describe, expect, it, vi } from 'vitest';
import { INCALL_WORDS, callTimer, inCallStatus, phaseOf, pickRoute } from './inCallBar';

// [CALLS-UX · owner 8 Nov 2026, "B"] The bar's pure parts: which device Speaker picks, the state words, the timer.

const dev = (type: string) => ({ type, select: vi.fn(async () => undefined) });

describe('[CALLS-UX] pickRoute', () => {
  it('Speaker on: the loudspeaker, or nothing when the phone reports none', () => {
    expect(pickRoute([dev('earpiece'), dev('speaker')], true)?.type).toBe('speaker');
    expect(pickRoute([dev('earpiece')], true)).toBeNull();
  });

  it('Speaker off: a Bluetooth headset first, then the earpiece, then anything but the speaker', () => {
    expect(pickRoute([dev('speaker'), dev('earpiece'), dev('bluetooth')], false)?.type).toBe('bluetooth');
    expect(pickRoute([dev('speaker'), dev('earpiece')], false)?.type).toBe('earpiece');
    expect(pickRoute([dev('speaker'), dev('unknown')], false)?.type).toBe('unknown');
    expect(pickRoute([dev('speaker')], false)).toBeNull();
  });
});

describe('[CALLS-UX] state and time', () => {
  it('reads the SDK call states; disconnected and unknown are no call', () => {
    expect(phaseOf('connecting')).toBe('connecting');
    expect(phaseOf('ringing')).toBe('ringing');
    expect(phaseOf('connected')).toBe('connected');
    expect(phaseOf('reconnecting')).toBe('reconnecting');
    expect(phaseOf('disconnected')).toBeNull();
    expect(phaseOf(undefined)).toBeNull();
  });

  it('formats the timer as a phone does', () => {
    expect(callTimer(0)).toBe('0:00');
    expect(callTimer(7_400)).toBe('0:07');
    expect(callTimer(754_000)).toBe('12:34');
    expect(callTimer(3_723_000)).toBe('1:02:03');
    expect(callTimer(-5)).toBe('0:00');
  });

  it('says the state until connected, then the time since it connected', () => {
    expect(inCallStatus({ phase: 'connecting', connectedAt: null }, 0)).toBe(INCALL_WORDS.connecting);
    expect(inCallStatus({ phase: 'ringing', connectedAt: null }, 0)).toBe(INCALL_WORDS.ringing);
    expect(inCallStatus({ phase: 'reconnecting', connectedAt: 1 }, 0)).toBe(INCALL_WORDS.reconnecting);
    expect(inCallStatus({ phase: 'connected', connectedAt: 1_000 }, 66_000)).toBe('1:05');
  });
});
