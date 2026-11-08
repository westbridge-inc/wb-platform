import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

// Permission priming [first-open spec 2.5, SO-5]: no permission dialogs at
// boot — notifications ask at the first moment they're obviously useful,
// with a one-line priming card first. The OS only grants one real prompt,
// so a single durable asked-flag guards it; already-granted users register
// silently at session start (services/push registerIfGranted) and never see
// a card. A denied permission always leaves the app fully working.

export type PrimeMoment = 'customer_order' | 'driver_application' | 'store_created' | 'store_dashboard' | 'mover_dashboard';

/** [STORE-ALERT] The two earner dashboards: their phone must ring for work. */
export type EarnerPrimeMoment = 'store_dashboard' | 'mover_dashboard';

/** One line each, in-voice (F-30/F-31; the store line follows the family). */
export const PRIME_COPY: Record<PrimeMoment, string> = {
  customer_order: "We'll only ping you about your orders",
  driver_application: 'Job offers arrive as notifications — this is how you earn',
  store_created: 'Order alerts arrive as notifications — never miss a sale',
  store_dashboard: 'New orders ring this phone, even when Swift is closed',
  mover_dashboard: 'Job offers arrive as notifications — this is how you earn',
};

const store = new MMKV({ id: 'swift-notification-priming' });
const KEY_ASKED = 'priming.asked';

/** [CALLS-REACH] Android's microphone for in-app calls, asked through this same card slot: one ask at a time. */
export type CallsMicAudience = 'customer' | 'partner';
/** allow: go on to the system prompt. not-now: the person said no. dismissed: closed without an answer (back,
 *  outside, or the wait ran out), never counted as a no. */
export type CallsMicAnswer = 'allow' | 'not-now' | 'dismissed';

interface PrimeState {
  visibleMoment: PrimeMoment | null;
  /** The in-app calls microphone card, while it shows (the notifications card waits behind it). */
  micAsk: CallsMicAudience | null;
  show: (moment: PrimeMoment) => void;
  dismiss: () => void;
}

export const usePrimeStore = create<PrimeState>((set) => ({
  visibleMoment: null,
  micAsk: null,
  show: (moment) => set({ visibleMoment: moment }),
  dismiss: () => set({ visibleMoment: null }),
}));

let micAnswer: ((answer: CallsMicAnswer) => void) | null = null;

/** Is any priming card showing (or waiting to)? Nothing else asks meanwhile. */
export function primeCardShowing(): boolean {
  const s = usePrimeStore.getState();
  return s.visibleMoment != null || s.micAsk != null;
}

/** [CALLS-REACH] Show the microphone card. Null when another card is showing: never two asks at once. */
export function askCallsMicrophone(audience: CallsMicAudience): Promise<CallsMicAnswer> | null {
  if (primeCardShowing() || micAnswer) return null;
  return new Promise<CallsMicAnswer>((resolve) => {
    micAnswer = resolve;
    usePrimeStore.setState({ micAsk: audience });
  });
}

/** The card's answer (or a close / a time-out as `dismissed`). Hides the card; the notifications card may follow. */
export function answerCallsMicrophone(answer: CallsMicAnswer): void {
  const resolve = micAnswer;
  micAnswer = null;
  usePrimeStore.setState({ micAsk: null });
  resolve?.(answer);
}

export function markPrimeAsked(): void {
  store.set(KEY_ASKED, true);
}

/** Call at an in-context moment. Shows the priming card at most once per
 *  install; silently no-ops if the question was ever answered. */
export function maybePrimeNotifications(moment: PrimeMoment): void {
  if (store.getBoolean(KEY_ASKED)) return;
  // A brief beat after the triggering success moment (haptic/toast settle).
  setTimeout(() => usePrimeStore.getState().show(moment), 600);
}

/** [STORE-ALERT 18 Oct 2026] An earner dashboard opened. A store or a mover
 *  whose phone cannot ring loses work, so the once-per-install rule above does
 *  not apply here: while the OS can still ask (undetermined on iOS), the card
 *  shows once per app session per dashboard, "Not now" included. Granted or
 *  refused-for-good phones never see it (the dashboard's PushOffStrip offers
 *  Settings instead). */
const earnerAskedThisSession = new Set<EarnerPrimeMoment>();

export async function maybePrimeEarnerNotifications(
  moment: EarnerPrimeMoment,
  permission: () => Promise<'granted' | 'ask' | 'settings'>,
): Promise<boolean> {
  if (earnerAskedThisSession.has(moment)) return false;
  earnerAskedThisSession.add(moment);
  if ((await permission()) !== 'ask') return false;
  setTimeout(() => usePrimeStore.getState().show(moment), 600);
  return true;
}

/** Test seam. */
export function resetPrimingForTests(): void {
  store.delete(KEY_ASKED);
  earnerAskedThisSession.clear();
  micAnswer = null;
  usePrimeStore.setState({ visibleMoment: null, micAsk: null });
}
