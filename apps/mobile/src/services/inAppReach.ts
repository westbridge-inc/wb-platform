/**
 * [CALLS-REACH · live test 8 Nov 2026] Keeps a phone on a live order able to be rung in the app, whatever
 * screen is showing (lib/inAppReach explains why). One controller for the whole app; the InAppCallReach
 * component feeds it the live-order signal from the reads the app already holds.
 *
 * - On a live order, in-app calls on (server switch), this build has the calling module: register this phone
 *   (registerForInAppCalls keeps its own ten-minute rhythm, REGISTER_EVERY_MS).
 * - Android without the microphone: Swift's own words once, then the system prompt. A "no" is remembered
 *   (per order, and for a week), so it is never a nag; their calls go to the phone bridge as before.
 * - The last live order ended: unregister. Sign-out unregisters through the auth teardown (authStore), and
 *   `reset()` forgets this account's state.
 * - Builds 11/12 (no calling module): nothing at all, not even a read.
 */
import { INAPP_WORDS } from '../lib/inAppCalls';
import {
  mayAskForMic,
  parseMicMemory,
  rememberMicRefusal,
  type ReachAudience,
  type ReachSignal,
} from '../lib/inAppReach';

export type MicAnswer = 'granted' | 'denied' | 'never_ask_again';

/** Everything the controller touches, handed in (the app's real ones are below; tests bring their own). */
export interface ReachDeps {
  /** This build has the calling module (build 13+). */
  available(): boolean;
  /** The server's switch (GET /calls/app/config, cached). */
  enabled(): Promise<boolean>;
  register(): Promise<boolean>;
  unregister(): Promise<boolean>;
  platform(): 'ios' | 'android';
  /** The app is on screen (an explanation is never shown to a phone in a pocket). */
  foreground(): boolean;
  micGranted(): Promise<boolean>;
  /** Swift's own words. Resolves true on "Continue". */
  explain(title: string, body: string): Promise<boolean>;
  requestMic(): Promise<MicAnswer>;
  memory: { get(): string | null; set(value: string): void };
  now(): number;
}

/** A failed register is tried again no sooner than this (the board's 12-second reads never hammer the server). */
export const REACH_RETRY_MS = 60_000;

export type ReachOutcome =
  | 'unavailable' | 'waiting' | 'idle' | 'unregistered' | 'off' | 'throttled'
  | 'mic-off' | 'mic-refused' | 'registered' | 'failed' | 'stale';

export interface InAppReach {
  /** The newest signal. Runs one step at a time; a signal that arrives meanwhile is run next (only the newest). */
  update(signal: ReachSignal): Promise<ReachOutcome | null>;
  /** Sign-out / account switch: forget this account's state (the auth teardown unregisters). */
  reset(): void;
}

export function createInAppReach(deps: ReachDeps): InAppReach {
  let wasLive = false;
  let lastTry = 0;
  let generation = 0;
  let next: ReachSignal | null = null;
  let running: Promise<ReachOutcome | null> | null = null;
  let lastOutcome: ReachOutcome | null = null;

  async function step(signal: ReachSignal, gen: number): Promise<ReachOutcome> {
    if (!deps.available()) return 'unavailable';
    if (signal.state === 'unknown') return 'waiting';
    if (signal.state === 'none') {
      if (!wasLive) return 'idle';
      wasLive = false;
      lastTry = 0;
      await deps.unregister().catch(() => false);
      return 'unregistered';
    }
    if (!(await deps.enabled().catch(() => false))) return 'off';
    if (gen !== generation) return 'stale';
    wasLive = true;
    const now = deps.now();
    if (lastTry > 0 && now - lastTry < REACH_RETRY_MS) return 'throttled';
    if (deps.platform() === 'android' && !(await deps.micGranted().catch(() => false))) {
      let memory: ReturnType<typeof parseMicMemory> = null;
      try { memory = parseMicMemory(deps.memory.get()); } catch { /* unreadable: never asked */ }
      if (!mayAskForMic(memory, signal.orderIds, now)) return 'mic-off';
      if (!deps.foreground()) return 'waiting';
      const refuse = (never = false): ReachOutcome => {
        try { deps.memory.set(JSON.stringify(rememberMicRefusal(memory, signal.orderIds, deps.now(), never))); } catch { /* best effort */ }
        return 'mic-refused';
      };
      if (!(await deps.explain(INAPP_WORDS.reachTitle, whyWords(signal.audience)).catch(() => false))) return refuse();
      const answer = await deps.requestMic().catch((): MicAnswer => 'denied');
      if (answer !== 'granted') return refuse(answer === 'never_ask_again');
      if (gen !== generation) return 'stale';
    }
    lastTry = now;
    const ok = await deps.register().catch(() => false);
    return ok ? 'registered' : 'failed';
  }

  async function drain(): Promise<ReachOutcome | null> {
    while (next) {
      const signal = next;
      next = null;
      try {
        lastOutcome = await step(signal, generation);
      } catch {
        lastOutcome = 'failed';
      }
    }
    return lastOutcome;
  }

  /** One run at a time; a signal that lands while the run is finishing starts the next run. */
  function kick(): Promise<ReachOutcome | null> {
    if (running) return running;
    running = drain().then((outcome) => {
      running = null;
      return next ? kick() : outcome;
    });
    return running;
  }

  return {
    update(signal) {
      next = signal;
      return kick();
    },
    reset() {
      generation += 1;
      wasLive = false;
      lastTry = 0;
      next = null;
    },
  };
}

function whyWords(audience: ReachAudience | null): string {
  return audience === 'partner' ? INAPP_WORDS.reachWhyPartner : INAPP_WORDS.reachWhyCustomer;
}
