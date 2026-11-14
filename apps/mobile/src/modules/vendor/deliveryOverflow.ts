/**
 * [DT-OVERFLOW · owner 14 Nov 2026] The store's words and rules for automatic delivery overflow (a branch connected
 * to Dragontail): shared by the phone app and the website. Pure: no network, no React.
 *
 * The server decides, order by order and before anything is sent, whether a cash delivery goes to Dragontail (the
 * branch's own drivers) or to the Swift tablet and Swift riders — never both. Pickups always go to Dragontail.
 */

export type OverflowMode = 'NONE' | 'AUTO_DRIVER_CHECK' | 'BUSY_HOURS' | 'BOTH';

/** One weekly window, Guyana time. day: 0 = Sunday … 6 = Saturday. An end at or before the start runs past midnight. */
export interface BusyWindow { day: number; start: string; end: string }

/** GET /api/v1/vendor/kitchen-overflow. `available` false: the branch is not connected (or the connection is off). */
export interface OverflowSetting { available: boolean; mode: OverflowMode; busyHours: BusyWindow[]; linkOffline?: boolean }

/** [DT-OUTAGE] Shown while the branch's link to Dragontail is down: every order rings this tablet until it is back. */
export const LINK_OFFLINE_TITLE = 'Kitchen link offline, orders on tablet';
export const LINK_OFFLINE_DETAIL = 'Dragontail is not answering, so new orders ring here. Swift checks every minute and switches back by itself.';

export const OVERFLOW_TITLE = 'Swift riders when you’re busy';
export const OVERFLOW_NOTE = 'Swift decides order by order, before sending. Each delivery goes to Dragontail or to this tablet with a Swift rider — never both. Pickups always go to Dragontail.';

export const OVERFLOW_MODE_OPTIONS: ReadonlyArray<{ mode: OverflowMode; label: string; detail: string }> = [
  { mode: 'NONE', label: 'Off', detail: 'Every delivery goes to Dragontail and your own drivers.' },
  { mode: 'AUTO_DRIVER_CHECK', label: 'When all my drivers are busy', detail: 'Before each delivery, Swift asks Dragontail for a free driver. None free: a Swift rider takes it. No answer in time: it goes to Dragontail as usual.' },
  { mode: 'BUSY_HOURS', label: 'During my busy hours', detail: 'Deliveries in the hours you set go to Swift riders.' },
  { mode: 'BOTH', label: 'Both', detail: 'Busy hours first. Outside them, when all your drivers are busy.' },
];

export const usesBusyHours = (mode: OverflowMode) => mode === 'BUSY_HOURS' || mode === 'BOTH';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** What is wrong with a window as typed, in the store's words; null when it is fine (the server checks the same). */
export function busyWindowProblem(w: BusyWindow): string | null {
  if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) return 'Choose a day.';
  if (!HHMM.test(w.start)) return 'Start: use a time like 18:30.';
  if (!HHMM_END.test(w.end)) return 'End: use a time like 21:00 (24:00 for midnight).';
  if (w.start === w.end) return 'The start and the end must differ.';
  return null;
}

/** "Friday 22:00 – 02:00 (next day)". */
export function busyWindowWords(w: BusyWindow): string {
  const day = DAY_NAMES[w.day] ?? 'Day';
  const overnight = w.end !== '24:00' && w.end <= w.start;
  return `${day} ${w.start} – ${w.end}${overnight ? ' (next day)' : ''}`;
}

export const NEW_BUSY_WINDOW: BusyWindow = { day: 5, start: '18:00', end: '21:00' };

/** The order screen's kitchen facts (GET /vendor/orders/:id `kitchen`; absent on an older server). */
export interface OrderKitchenView { holdsOrder?: boolean; route?: string | null; title?: string; detail?: string }

/** Dragontail has this order: the store's own driver delivers it there, and no Swift rider may be added. */
export const kitchenHoldsOrder = (kitchen: OrderKitchenView | null | undefined) => kitchen?.holdsOrder === true;

export const KITCHEN_HOLDS_TITLE = 'In Dragontail: your own driver delivers it';
/** The delivery card's words while Dragontail has the order: its own detail, then why no Swift rider. */
export function kitchenHoldsDescription(kitchen: OrderKitchenView | null | undefined): string {
  return `${kitchen?.detail ? `${kitchen.detail} ` : ''}${KITCHEN_HOLDS_DETAIL}`;
}

/** Test id of the line that says where a Dragontail branch's order went (web and phone). */
export const ROUTE_NOTE_TEST_ID = 'route-note';

export const KITCHEN_HOLDS_DETAIL = 'Dispatch it from Dragontail. Swift can’t add a rider to it: Dragontail would not be told, and two drivers could come.';

/** The delivery card's facts (screens/delivery-owner.ts deliveryOwnerView) as far as this file needs them. */
interface DeliveryOwnerCard { canChoosePlatform: boolean; title: string; description: string }

/**
 * [DT-OVERFLOW] The delivery card with the kitchen system's facts applied: while Dragontail has the order, no "Get a
 * Swift rider" and the words say why; otherwise the card unchanged, plus a note of where a Dragontail branch's order
 * went (null for any other order). Kept out of delivery-owner.ts, which the website's first load carries.
 */
export function withKitchenHold<V extends DeliveryOwnerCard>(view: V, kitchen: OrderKitchenView | null | undefined): V & { kitchenNote: { title: string; detail: string } | null } {
  if (kitchenHoldsOrder(kitchen)) {
    return { ...view, canChoosePlatform: false, title: kitchen?.title || KITCHEN_HOLDS_TITLE, description: kitchenHoldsDescription(kitchen), kitchenNote: null };
  }
  return { ...view, kitchenNote: kitchen?.title ? { title: kitchen.title, detail: kitchen.detail ?? '' } : null };
}
