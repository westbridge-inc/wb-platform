/**
 * [CALLS-REACH · live test 8 Nov 2026] Keeps a phone on a live order able to be rung in the app, whatever
 * screen is showing (lib/inAppReach explains why). One controller for the whole app; the InAppCallReach
 * component feeds it the live-order signal from the reads the app already holds.
 *
 * - On a live order, in-app calls on (server switch), this build has the calling module: register this phone
 *   (the voice service keeps its own ten-minute rhythm, REGISTER_EVERY_MS).
 * - [review S2-1] Never unregistered on the app's own reads alone (a read can be missing, evicted, or show one
 *   branch of several). When the reads stop showing a live order, and once per run on a phone that registered
 *   before, Swift ASKS THE SERVER (a register token): only its 403 INAPP_NO_LIVE_ORDER unregisters.
 * - [review S2-2] Android without the microphone: asked only at a moment that fits (an order-tracking, active-job
 *   or store-board screen, drawn and in front, not right after launch, no sign-in / terms / update gate, no other
 *   card showing), through the one priming card slot. "Not now" / the system's "no" is remembered per order and for
 *   a week; a card closed without an answer is only "not now" for this run; Android's "don't ask again" is for good.
 *   A phone that lost the microphone is unregistered (its calls go to the phone bridge, as before).
 * - Sign-out unregisters through the auth teardown (authStore); `reset()` forgets this account's state.
 * - Builds 11/12 (no calling module): nothing at all, not even a read.
 */
import type { CallsMicAnswer } from './notification-priming';
import type { RegisterResult } from './inAppVoice';
import { mayAskForMic, parseMicMemory, rememberMicRefusal, type ReachAudience, type ReachSignal } from '../lib/inAppReach';

export type MicAnswer = 'granted' | 'denied' | 'never_ask_again';

/** Everything the controller touches, handed in (the app's real ones are in components/InAppCallReach). */
export interface ReachDeps {
  /** This build has the calling module (build 13+). */
  available(): boolean;
  /** The server's switch (GET /calls/app/config, cached). */
  enabled(): Promise<boolean>;
  /** `force`: past the ten-minute rhythm (a check with the server). */
  register(force: boolean): Promise<RegisterResult>;
  unregister(): Promise<boolean>;
  /** This phone may still hold a binding (registered this run or an earlier one). */
  mayBeRegistered(): boolean;
  platform(): 'ios' | 'android';
  micGranted(): Promise<boolean>;
  /** A fitting moment to ask (see above). */
  askMoment(): boolean;
  /** Swift's card through the priming slot; null if another card is showing. */
  ask(audience: ReachAudience): Promise<CallsMicAnswer> | null;
  /** Close the card (the wait ran out). */
  cancelAsk(): void;
  requestMic(): Promise<MicAnswer>;
  memory: { get(): string | null; set(value: string): void };
  now(): number;
  /** Resolves after `ms` (the bound on a card or prompt nobody answers). */
  sleep(ms: number): Promise<void>;
}

/** A failed register is tried again no sooner than this (the board's 12-second reads never hammer the server). */
export const REACH_RETRY_MS = 60_000;
/** [review S3-6] A card or system prompt left unanswered this long counts as closed: the runner never stalls. */
export const MIC_ASK_TIMEOUT_MS = 2 * 60_000;

export type ReachOutcome =
  | 'unavailable' | 'waiting' | 'idle' | 'off' | 'throttled'
  | 'mic-off' | 'mic-later' | 'mic-refused' | 'registered' | 'kept' | 'unregistered' | 'failed' | 'stale';

export interface InAppReach {
  /** The newest signal. Runs one step at a time; a signal that arrives meanwhile is run next (only the newest). */
  update(signal: ReachSignal): Promise<ReachOutcome | null>;
  /** Sign-out / account switch: forget this account's state (the auth teardown unregisters the phone). */
  reset(): void;
}

const TIMED_OUT = 'timed-out' as const;

export function createInAppReach(deps: ReachDeps): InAppReach {
  let wasLive = false;
  /** The server is to be asked whether this person is still on a live order. */
  let pendingCheck = false;
  let checkedThisRun = false;
  let lastTry = 0;
  let lastCheck = 0;
  let generation = 0;
  /** Orders whose card was closed without an answer this run: not asked again until the next start. */
  const laterThisRun = new Set<string>();
  let laterWithoutIds = false;
  let next: ReachSignal | null = null;
  let running: Promise<ReachOutcome | null> | null = null;
  let lastOutcome: ReachOutcome | null = null;

  const within = async <T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> =>
    Promise.race<T | typeof TIMED_OUT>([work, deps.sleep(MIC_ASK_TIMEOUT_MS).then((): typeof TIMED_OUT => TIMED_OUT)]);

  /** The server decides: a register token for a person on no live order is refused (403 INAPP_NO_LIVE_ORDER). */
  async function checkWithServer(gen: number): Promise<ReachOutcome> {
    const now = deps.now();
    if (lastCheck > 0 && now - lastCheck < REACH_RETRY_MS) return 'throttled';
    if (!(await deps.enabled().catch(() => false))) return 'off';
    if (gen !== generation) return 'stale';
    lastCheck = now;
    const result = await deps.register(true).catch((): RegisterResult => 'failed');
    if (gen !== generation) return 'stale';
    if (result === 'not-live') {
      await deps.unregister().catch(() => false);
      return 'unregistered';
    }
    if (result === 'no-mic') return 'mic-off'; // the voice service already removed the binding
    return result === 'registered' ? 'kept' : 'failed';
  }

  async function askForMic(signal: ReachSignal, gen: number): Promise<ReachOutcome | null> {
    if (deps.mayBeRegistered()) await deps.unregister().catch(() => false); // [S3-2] it can no longer ring
    let memory: ReturnType<typeof parseMicMemory> = null;
    try { memory = parseMicMemory(deps.memory.get()); } catch { /* unreadable: never asked */ }
    if (!mayAskForMic(memory, signal.orderIds, deps.now())) return 'mic-off';
    if (signal.orderIds.length > 0 && signal.orderIds.every((id) => laterThisRun.has(id))) return 'mic-off';
    // [follow-up 3] Live rows without ids cannot be remembered per order: one closed card is enough for this run.
    if (signal.orderIds.length === 0 && laterWithoutIds) return 'mic-off';
    if (!deps.askMoment()) return 'waiting';
    const card = deps.ask(signal.audience ?? 'customer');
    if (!card) return 'waiting'; // another card is showing: asked when it is gone
    // [follow-up 1] An answer that lands after a sign-out (the card left over a forced logout) belongs to the old
    // account: it is never stored.
    const refuse = (never = false): ReachOutcome => {
      if (gen !== generation) return 'stale';
      try { deps.memory.set(JSON.stringify(rememberMicRefusal(memory, signal.orderIds, deps.now(), never))); } catch { /* best effort */ }
      return 'mic-refused';
    };
    const later = (): ReachOutcome => {
      if (gen !== generation) return 'stale';
      for (const id of signal.orderIds) laterThisRun.add(id);
      if (signal.orderIds.length === 0) laterWithoutIds = true;
      return 'mic-later';
    };
    const answer = await within(card.catch((): CallsMicAnswer => 'dismissed'));
    if (answer === TIMED_OUT) { deps.cancelAsk(); return later(); }
    if (answer === 'dismissed') return later();
    if (answer === 'not-now') return refuse();
    const system = await within(deps.requestMic().catch((): MicAnswer => 'denied'));
    if (system === TIMED_OUT) return later();
    if (system === 'never_ask_again') return refuse(true);
    if (system !== 'granted') return refuse();
    return gen === generation ? null : 'stale';
  }

  async function step(signal: ReachSignal, gen: number): Promise<ReachOutcome> {
    if (!deps.available()) return 'unavailable';
    if (signal.state !== 'live') {
      // Positive evidence only: the reads stopped showing a live order (or, once per run, a phone that registered
      // before starts with every read loaded and empty) -> ask the server; its "no live order" alone unregisters.
      if (wasLive) pendingCheck = true;
      if (!checkedThisRun && signal.state === 'none') {
        checkedThisRun = true;
        if (deps.mayBeRegistered()) pendingCheck = true;
      }
      wasLive = false;
      lastTry = 0;
      if (!pendingCheck) return signal.state === 'unknown' ? 'waiting' : 'idle';
      const outcome = await checkWithServer(gen);
      // Not answered yet (too soon, offline): asked again with the next reading.
      if (outcome !== 'throttled' && outcome !== 'failed') pendingCheck = false;
      return outcome;
    }
    checkedThisRun = true;
    pendingCheck = false;
    if (!(await deps.enabled().catch(() => false))) return 'off';
    if (gen !== generation) return 'stale';
    wasLive = true;
    const now = deps.now();
    if (lastTry > 0 && now - lastTry < REACH_RETRY_MS) return 'throttled';
    if (deps.platform() === 'android' && !(await deps.micGranted().catch(() => false))) {
      const asked = await askForMic(signal, gen);
      if (asked) return asked;
    }
    lastTry = now;
    const result = await deps.register(false).catch((): RegisterResult => 'failed');
    if (gen !== generation) return 'stale';
    if (result === 'not-live') {
      // The reads were behind: the server says there is no live order.
      wasLive = false;
      await deps.unregister().catch(() => false);
      return 'unregistered';
    }
    if (result === 'no-mic') return 'mic-off';
    return result === 'registered' || result === 'throttled' ? 'registered' : result === 'stale' ? 'stale' : 'failed';
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
      pendingCheck = false;
      checkedThisRun = false;
      lastTry = 0;
      lastCheck = 0;
      next = null;
      laterThisRun.clear();
      laterWithoutIds = false;
      // [follow-up 1] A card still showing for the old account is closed (its answer is dropped above).
      deps.cancelAsk();
    },
  };
}

// ---------------------------------------------------------------------------
// [review S2-2] The moment to ask: an order-tracking, active-job or store-board screen, drawn and in front.
// Screens open it with hooks/useCallsAskMoment; the controller only reads it.
// ---------------------------------------------------------------------------

/** Never in the first seconds after launch (the app is still settling: sign-in, gates, other cards). */
export const LAUNCH_QUIET_MS = 10_000;
const launchedAt = Date.now();
export const sinceLaunch = (now = Date.now()) => now - launchedAt;

let momentSeq = 0;
const openMoments = new Set<number>();
const momentListeners = new Set<() => void>();

/** A fitting screen is drawn and in front. Returns the token to close it with. */
export function openCallsAskMoment(): number {
  const token = ++momentSeq;
  openMoments.add(token);
  momentListeners.forEach((listener) => listener());
  return token;
}

export function closeCallsAskMoment(token: number): void {
  openMoments.delete(token);
}

export function callsAskMomentOpen(): boolean {
  return openMoments.size > 0;
}

/** The app-wide layer re-runs when a moment opens. */
export function onCallsAskMoment(listener: () => void): () => void {
  momentListeners.add(listener);
  return () => { momentListeners.delete(listener); };
}

/** Tests only. */
export function resetCallsAskMomentsForTests(): void {
  openMoments.clear();
  momentListeners.clear();
}
