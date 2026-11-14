import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { dragontailDriverCheckEnabled, dragontailIntegrationEnabled } from './kitchen-switch';
import type { DragontailClientOptions } from './dragontail/dragontail-client';

type KitchenClientOverrides = Partial<Pick<DragontailClientOptions, 'fetch' | 'sleep' | 'backoffMs'>>;

/**
 * [DT-OVERFLOW · owner 14 Nov 2026] AUTOMATIC DELIVERY OVERFLOW for branches connected to a kitchen system.
 *
 * A connected branch that delivers with its own drivers has its cash deliveries sent to its kitchen system
 * (Dragontail), where its own drivers take them. A busy branch will not stop to switch "Deliver my own orders" off,
 * so Swift decides, ORDER BY ORDER and BEFORE anything is sent, where each such delivery goes:
 *
 *   KITCHEN       the kitchen system, as before (the branch's own drivers); the Swift tablet is not rung;
 *   SWIFT_RIDERS  the normal Swift path, exactly as a branch with "Deliver my own orders" off: the Swift tablet
 *                 rings, and on accept the order is bound to Swift riders. Nothing is ever sent to the kitchen
 *                 system for it.
 *
 * One decision per order (orders.kitchenRoute, written once by compare-and-set inside the claim's transaction), so
 * an order lives in exactly one place. Pickups are never moved (no route is decided for them).
 *
 * The branch's setting (vendor_integrations.overflowMode, off by default):
 *   NONE               every delivery goes to the kitchen system (as before);
 *   BUSY_HOURS         inside the branch's busy hours (weekly windows, Guyana time): Swift riders;
 *   AUTO_DRIVER_CHECK  ask Dragontail for a free driver (GET /PosGetVehicles/{StoreNo}, "(Optional) Retrieve
 *                      unassigned vehicles"): none free → Swift riders; one or more free → the kitchen system;
 *   BOTH               busy hours first (no call is made inside them), then the driver check.
 *
 * [round 2 · review A S2-3] The driver check (AUTO_DRIVER_CHECK, and BOTH's second half) is behind its own switch,
 * DRAGONTAIL_DRIVER_CHECK (kitchen-switch.ts), OFF until Dragontail confirms what PosGetVehicles lists. While off:
 * AUTO_DRIVER_CHECK = every delivery to the kitchen (DRIVER_CHECK_OFF), BOTH = busy hours only, and neither can be set.
 *
 * [round 2 · review A S2-2] The driver check is NEVER made by the hold-release sweep (dispatch queue) or checkout: the
 * kitchen tick (order queue) asks Dragontail for each such branch about every 20 s, all branches at once under one
 * deadline, and stores the answer (vendor_integrations.driverCheck*). The route only READS it: an answer older than
 * 45 s, or none, is a failed check (the kitchen). After a failed check the branch is not asked again for 60 s.
 *
 * SAFE DEFAULTS (never both paths, never neither):
 *   - The driver check has a short budget (DRAGONTAIL_DRIVER_CHECK_MS, 2 s by default, at most 5 s). A timeout, an
 *     error, a 4xx/404 (the endpoint is OPTIONAL in the spec: a store may not have it), or an answer Swift cannot
 *     read → the KITCHEN, as today (DRIVER_CHECK_FAILED). The branch chose its own drivers, and the kitchen system
 *     already queues an order until a driver frees up; diverting on a guess could send riders to a branch whose
 *     drivers were free. Recorded on the order, so operations see how often it happens.
 *   - Before an order is moved to Swift riders, Swift checks that at least one Swift rider is online near the
 *     branch whose cash limit covers this order's cash. None (or the check fails) → the KITCHEN
 *     (NO_SWIFT_RIDER_NEAR / SWIFT_RIDER_CHECK_FAILED): an order moved to Swift with no Swift rider to take it would
 *     wait with nobody, while in the kitchen system the branch's own driver takes it when one frees up.
 *
 * Inert while DRAGONTAIL_INTEGRATION is off: nothing here is called (the claim answers "no" first), the store's
 * settings route refuses changes, and no call leaves Swift.
 */

export const KITCHEN_OVERFLOW_MODES = ['NONE', 'AUTO_DRIVER_CHECK', 'BUSY_HOURS', 'BOTH'] as const;
export type KitchenOverflowModeName = (typeof KITCHEN_OVERFLOW_MODES)[number];

/** [round 3] TABLET: the branch's kitchen link was offline, so the order is on the Swift tablet with its own driver. */
export type KitchenRouteName = 'KITCHEN' | 'SWIFT_RIDERS' | 'TABLET';

/** Every reason a route was chosen, and the route it means. Stored on the order as the code. */
export const KITCHEN_ROUTE_REASONS = {
  /** The branch's overflow is off. */
  OVERFLOW_OFF: 'KITCHEN',
  /** BUSY_HOURS mode, outside the busy hours. */
  OUTSIDE_BUSY_HOURS: 'KITCHEN',
  /** Dragontail listed at least one free vehicle. */
  DRIVER_FREE: 'KITCHEN',
  /** The driver check timed out, failed, or gave an answer Swift could not read: the safe default. */
  DRIVER_CHECK_FAILED: 'KITCHEN',
  /** Moving it was wanted, but no Swift rider near could carry it. */
  NO_SWIFT_RIDER_NEAR: 'KITCHEN',
  /** Moving it was wanted, but Swift's own rider check failed. */
  SWIFT_RIDER_CHECK_FAILED: 'KITCHEN',
  /** The overflow could not be worked out before the claim (a failed read): the safe default. */
  OVERFLOW_CHECK_FAILED: 'KITCHEN',
  /** [round 2] AUTO_DRIVER_CHECK while the driver-check switch is off: as if the overflow were off. */
  DRIVER_CHECK_OFF: 'KITCHEN',
  /** Inside the branch's busy hours. */
  BUSY_HOURS: 'SWIFT_RIDERS',
  /** Dragontail listed no free vehicle. */
  NO_FREE_DRIVER: 'SWIFT_RIDERS',
  /** [round 3 · review B S3-2] The kitchen link was offline and the overflow did not move it: the tablet, own driver. */
  LINK_OFFLINE: 'TABLET',
} as const satisfies Record<string, KitchenRouteName>;
export type KitchenRouteReason = keyof typeof KITCHEN_ROUTE_REASONS;

export interface KitchenRouteDecision {
  orderId: string;
  route: KitchenRouteName;
  reason: KitchenRouteReason;
  /** Operator words for the log (never a person's detail). */
  note: string;
}

// ── Busy hours ───────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HHMM_END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** One weekly window, Guyana time. day: 0 = Sunday … 6 = Saturday (the day the window STARTS). An end at or before
 *  the start runs past midnight into the next day ("22:00"–"02:00"); "24:00" ends at midnight. */
export const busyWindowSchema = z.object({
  day: z.number().int().min(0).max(6),
  start: z.string().regex(HHMM, 'Use a time like 18:30'),
  end: z.string().regex(HHMM_END, 'Use a time like 21:00 (or 24:00 for midnight)'),
}).strict().refine((w) => w.start !== w.end, { message: 'A busy window needs a start and an end that differ' });
export type BusyWindow = z.infer<typeof busyWindowSchema>;

/** At most four windows a day. */
export const busyHoursSchema = z.array(busyWindowSchema).max(28);

/** What the store (owner/manager) and the console may set. */
export const kitchenOverflowSettingSchema = z.object({
  mode: z.enum(KITCHEN_OVERFLOW_MODES),
  busyHours: busyHoursSchema.optional(),
}).strict();

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const WEEK = 7 * 24 * 60;

/** The stored windows, read tolerantly: anything that is not a valid window is ignored (never thrown). */
export function readBusyHours(raw: unknown): BusyWindow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w) => {
    const parsed = busyWindowSchema.safeParse(w);
    return parsed.success ? [parsed.data] : [];
  });
}

const GY_TIME_ZONE = 'America/Guyana';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Minutes since Sunday 00:00, Guyana wall-clock time (read from the zone, never a hard-coded offset). */
export function guyanaWeekMinute(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GY_TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = WEEKDAYS.indexOf(get('weekday'));
  const hour = Number(get('hour')) % 24;
  return (day < 0 ? 0 : day) * 24 * 60 + hour * 60 + Number(get('minute'));
}

/** Is `at` inside one of the windows? A window is [start, end): its end minute is outside it. */
export function inBusyHours(windows: readonly BusyWindow[], at: Date): boolean {
  const now = guyanaWeekMinute(at);
  return windows.some((w) => {
    const start = w.day * 24 * 60 + minutesOf(w.start);
    let end = w.day * 24 * 60 + minutesOf(w.end);
    if (end <= start) end += 24 * 60; // past midnight, into the next day
    // Saturday night into Sunday morning wraps the week.
    return (now >= start && now < end) || (now + WEEK >= start && now + WEEK < end);
  });
}

// ── The decision ─────────────────────────────────────────────────────────────

export type DriverCheck =
  | { kind: 'FREE'; count: number; ms: number }
  | { kind: 'NONE_FREE'; ms: number }
  | { kind: 'FAILED'; problem: string; ms: number };

export type SwiftRiderCheck =
  | { kind: 'NEAR'; count: number }
  | { kind: 'NONE_NEAR' }
  | { kind: 'FAILED'; problem: string };

const decided = (orderId: string, reason: KitchenRouteReason, note: string): KitchenRouteDecision => ({
  orderId, route: KITCHEN_ROUTE_REASONS[reason], reason, note,
});

/**
 * The pure decision, with its two questions injected (so a test can count them): the driver check is asked only
 * when the mode needs it and the busy hours did not already answer; Swift's own rider check only when moving the
 * order is wanted. Never throws: a probe that throws is a failed probe.
 */
export async function decideKitchenRoute(input: {
  orderId: string;
  mode: KitchenOverflowModeName;
  busyHours: readonly BusyWindow[];
  now: Date;
  /** [round 2 · review A S2-3] DRAGONTAIL_DRIVER_CHECK: false = the driver check is never asked. */
  driverCheckOn: boolean;
  driverCheck: () => Promise<DriverCheck>;
  swiftRiders: () => Promise<SwiftRiderCheck>;
}): Promise<KitchenRouteDecision> {
  const { orderId, mode } = input;
  if (mode === 'NONE') return decided(orderId, 'OVERFLOW_OFF', 'overflow is off');
  if (mode === 'AUTO_DRIVER_CHECK' && !input.driverCheckOn) return decided(orderId, 'DRIVER_CHECK_OFF', 'the driver check is switched off: sent to the kitchen system');
  const usesHours = mode === 'BUSY_HOURS' || mode === 'BOTH';
  const usesDriverCheck = (mode === 'AUTO_DRIVER_CHECK' || mode === 'BOTH') && input.driverCheckOn;
  let want: 'BUSY_HOURS' | 'NO_FREE_DRIVER';
  let why: string;
  if (usesHours && inBusyHours(input.busyHours, input.now)) {
    want = 'BUSY_HOURS';
    why = 'inside the busy hours';
  } else if (usesDriverCheck) {
    const check = await input.driverCheck().catch((err: unknown): DriverCheck => ({ kind: 'FAILED', problem: problemOf(err), ms: 0 }));
    if (check.kind === 'FREE') return decided(orderId, 'DRIVER_FREE', `Dragontail listed ${check.count} free vehicle(s) (answer ${check.ms} ms old)`);
    if (check.kind === 'FAILED') {
      return decided(orderId, 'DRIVER_CHECK_FAILED', `driver check failed (${check.problem}): sent to the kitchen system, the safe default`);
    }
    want = 'NO_FREE_DRIVER';
    why = `Dragontail listed no free vehicle (answer ${check.ms} ms old)`;
  } else {
    return decided(orderId, 'OUTSIDE_BUSY_HOURS', 'outside the busy hours');
  }
  const riders = await input.swiftRiders().catch((err: unknown): SwiftRiderCheck => ({ kind: 'FAILED', problem: problemOf(err) }));
  if (riders.kind === 'NONE_NEAR') return decided(orderId, 'NO_SWIFT_RIDER_NEAR', `${why}, but no Swift rider near can carry it: kept with the kitchen system`);
  if (riders.kind === 'FAILED') return decided(orderId, 'SWIFT_RIDER_CHECK_FAILED', `${why}, but the Swift rider check failed (${riders.problem}): kept with the kitchen system`);
  return decided(orderId, want, `${why}; ${riders.count} Swift rider(s) near can carry it`);
}

const problemOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);

// ── The two questions, for real ─────────────────────────────────────────────

/** The driver check's whole budget (login included), ms. Short: it runs before the store is alerted. */
export function driverCheckBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env['DRAGONTAIL_DRIVER_CHECK_MS'] ?? '').trim();
  const value = Number(raw);
  return raw !== '' && Number.isInteger(value) && value >= 300 && value <= 5_000 ? value : 2_000;
}

export interface KitchenRouteDeps {
  now?: () => Date;
  /** Tests: replace a question outright. */
  driverCheck?: (storeNo: number) => Promise<DriverCheck>;
  swiftRiders?: (order: SwiftRiderProbeOrder) => Promise<SwiftRiderCheck>;
}

/** Ask Dragontail for the branch's free vehicles, within the budget. Never throws. Only the kitchen tick calls it
 *  (refreshKitchenDriverChecks): never the hold-release sweep or checkout. */
export async function dragontailDriverCheck(
  integration: { id: string; provider: 'DRAGONTAIL' },
  storeNo: number,
  env: Record<string, string | undefined>,
  client?: KitchenClientOverrides,
): Promise<DriverCheck> {
  const started = Date.now();
  const budget = driverCheckBudgetMs(env);
  const ms = () => Date.now() - started;
  try {
    // Loaded on use: the sender module is heavy, and the claim (imported by the order spine) must stay light.
    const { kitchenProvider } = await import('./kitchen-sync');
    const answer = kitchenProvider({ env, ...(client ? { client } : {}) }, integration);
    if (!answer.ok) return { kind: 'FAILED', problem: answer.problem, ms: ms() };
    const provider = answer.provider;
    if (!provider.freeDriverCount) return { kind: 'FAILED', problem: 'this kitchen system has no driver check', ms: ms() };
    provider.setDeadline(started + budget);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${budget} ms`)), budget + 50); });
    try {
      const count = await Promise.race([provider.freeDriverCount(storeNo), cap]);
      if (count === null) return { kind: 'FAILED', problem: 'an answer Swift could not read', ms: ms() };
      return count > 0 ? { kind: 'FREE', count, ms: ms() } : { kind: 'NONE_FREE', ms: ms() };
    } finally {
      clearTimeout(timer);
      provider.setDeadline(null);
    }
  } catch (err) {
    return { kind: 'FAILED', problem: problemOf(err), ms: ms() };
  }
}

export interface SwiftRiderProbeOrder {
  tenantId: string;
  orderType: string;
  paymentMethod: string;
  subtotalBase: unknown;
  taxAmount: unknown;
  courierPackageSize: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  items: Array<{ quantity: number; bulkUnits: unknown }>;
}

/** Is at least one Swift rider online near the branch whose cash limit covers this order's cash? Never throws. */
export async function swiftRidersNearCheck(prisma: PrismaClient, order: SwiftRiderProbeOrder, env: Record<string, string | undefined>): Promise<SwiftRiderCheck> {
  try {
    if (order.pickupLat == null || order.pickupLng == null) return { kind: 'FAILED', problem: 'the branch has no location on the order' };
    const [{ ridersOnlineNear, CAPACITY_RADIUS_KM }, { riderFloatForOrder }, { DEFAULT_LOAD_BANDS, readOrderSize }] = await Promise.all([
      import('../dispatch/delivery-capacity'),
      import('../dispatch/float.service'),
      import('../../utils/load'),
    ]);
    const cash = riderFloatForOrder({ paymentMethod: order.paymentMethod, subtotalBase: order.subtotalBase as number, taxAmount: order.taxAmount as number });
    const size = readOrderSize(order as Parameters<typeof readOrderSize>[0], DEFAULT_LOAD_BANDS);
    // dispatch's own freshness rule (dispatch.service normalizeDispatchLocationFreshSeconds): at least 90 s.
    const configured = Number(env['DISPATCH_LOCATION_FRESH_SECONDS'] ?? 90);
    const freshSeconds = Number.isFinite(configured) ? Math.max(90, configured) : 90;
    const count = await ridersOnlineNear(prisma, { lat: order.pickupLat, lng: order.pickupLng }, order.tenantId, size.required, freshSeconds, CAPACITY_RADIUS_KM, ['DELIVERY', 'BOTH'], cash);
    return count > 0 ? { kind: 'NEAR', count } : { kind: 'NONE_NEAR' };
  } catch (err) {
    return { kind: 'FAILED', problem: problemOf(err) };
  }
}

// ── The driver check, refreshed by the kitchen tick ─────────────────────────

/** Ask a branch again this long after an answer... */
export const DRIVER_CHECK_EVERY_MS = 20_000;
/** ...and this long after a failed check (a slow or broken endpoint is left alone for a minute). */
export const DRIVER_CHECK_BACKOFF_MS = 60_000;
/** An answer older than this is no answer: the route treats it as a failed check (the kitchen). */
export const DRIVER_CHECK_FRESH_MS = 45_000;

/** What the route reads: the branch's stored answer, if fresh enough. No call. */
export function storedDriverCheck(
  row: { driverCheckAt: Date | null; driverCheckFree: number | null; driverCheckProblem: string | null },
  now: Date,
): DriverCheck {
  let age = row.driverCheckAt ? now.getTime() - row.driverCheckAt.getTime() : Number.POSITIVE_INFINITY;
  // A few seconds "from the future" is another server's clock, not a bad answer.
  if (!row.driverCheckAt || age < -5_000 || age > DRIVER_CHECK_FRESH_MS) {
    return { kind: 'FAILED', problem: `no driver check in the last ${DRIVER_CHECK_FRESH_MS / 1000} s`, ms: 0 };
  }
  age = Math.max(0, age);
  if (row.driverCheckFree == null) return { kind: 'FAILED', problem: row.driverCheckProblem ?? 'the last driver check failed', ms: age };
  return row.driverCheckFree > 0 ? { kind: 'FREE', count: row.driverCheckFree, ms: age } : { kind: 'NONE_FREE', ms: age };
}

/**
 * [round 2 · review A S2-2] The kitchen tick's part: ask Dragontail about every branch whose overflow uses the driver
 * check and is due (20 s after an answer, 60 s after a failure), ALL AT ONCE under one deadline (the check's budget),
 * and store each answer. A failure is stored with its words (the console shows it). Inert unless both switches are
 * on. A BOTH branch inside its busy hours is not asked (the hours already answer). Never throws.
 */
export async function refreshKitchenDriverChecks(
  prisma: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  deps: { now?: () => Date; client?: KitchenClientOverrides } = {},
): Promise<number> {
  if (!dragontailDriverCheckEnabled(env)) return 0;
  const now = deps.now ? deps.now() : new Date();
  const rows = await prisma.vendorIntegration.findMany({
    where: {
      provider: 'DRAGONTAIL', enabled: true, linkOfflineAt: null, externalStoreNo: { not: null },
      overflowMode: { in: ['AUTO_DRIVER_CHECK', 'BOTH'] },
      OR: [
        { driverCheckAt: null },
        { driverCheckFree: { not: null }, driverCheckAt: { lte: new Date(now.getTime() - DRIVER_CHECK_EVERY_MS) } },
        { driverCheckFree: null, driverCheckAt: { lte: new Date(now.getTime() - DRIVER_CHECK_BACKOFF_MS) } },
      ],
    },
    select: { id: true, externalStoreNo: true, overflowMode: true, overflowBusyHours: true },
    // [round 3 · review B S4-7] Longest-waiting first, so no branch is starved.
    // BOTH branches inside their busy hours are read and skipped below; 200 leaves room for them.
    orderBy: { driverCheckAt: { sort: 'asc', nulls: 'first' } },
    take: 200,
  });
  // At most 50 calls per tick, all at once under one budget.
  const due = rows.filter((r) => !(r.overflowMode === 'BOTH' && inBusyHours(readBusyHours(r.overflowBusyHours), now))).slice(0, 50);
  const answers = await Promise.all(due.map(async (r) => ({
    id: r.id,
    check: await dragontailDriverCheck({ id: r.id, provider: 'DRAGONTAIL' }, r.externalStoreNo as number, env, deps.client),
  })));
  let written = 0;
  for (const { id, check } of answers) {
    const at = deps.now ? deps.now() : new Date();
    const ok = await prisma.vendorIntegration.update({
      where: { id },
      data: check.kind === 'FAILED'
        ? { driverCheckAt: at, driverCheckFree: null, driverCheckProblem: `${check.problem} (${check.ms} ms)`.slice(0, 200) }
        : { driverCheckAt: at, driverCheckFree: check.kind === 'FREE' ? check.count : 0, driverCheckProblem: null },
    }).then(() => true, () => false);
    if (check.kind === 'FAILED') log().warn({ integrationId: id, problem: check.problem, ms: check.ms }, '[KITCHEN-OVERFLOW] driver check failed: deliveries go to the kitchen system');
    if (ok) written += 1;
  }
  return written;
}

/**
 * Work out the route for one order BEFORE the claim's transaction (never inside a database transaction). It makes
 * no call to the kitchen system: the driver check is the stored answer (refreshKitchenDriverChecks). Null when the order is not one the overflow decides: not a cash DELIVERY, not a connected
 * own-driver branch, already decided, or the switch is off. The claim re-checks everything on the row and writes the
 * decision once; a decision for an order that changed meanwhile is simply not used.
 */
export async function planKitchenRoute(
  prisma: PrismaClient,
  orderId: string,
  env: Record<string, string | undefined> = process.env,
  deps: KitchenRouteDeps = {},
): Promise<KitchenRouteDecision | null> {
  if (!dragontailIntegrationEnabled(env)) return null;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, tenantId: true, vendorId: true, status: true, orderType: true, fulfillment: true, paymentMethod: true, kitchenRoute: true,
      subtotalBase: true, taxAmount: true, courierPackageSize: true, pickupLat: true, pickupLng: true,
      items: { select: { quantity: true, bulkUnits: true } },
      vendor: { select: { selfDeliveryEnabled: true } },
    },
  });
  if (!order?.vendorId || order.status !== 'PENDING' || order.kitchenRoute) return null;
  if (order.orderType !== 'FOOD_DELIVERY' || order.fulfillment !== 'DELIVERY' || order.paymentMethod !== 'CASH' || !order.vendor?.selfDeliveryEnabled) return null;
  const integration = await prisma.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId: order.vendorId, provider: 'DRAGONTAIL' } },
    select: {
      id: true, enabled: true, externalStoreNo: true, overflowMode: true, overflowBusyHours: true, linkOfflineAt: true,
      driverCheckAt: true, driverCheckFree: true, driverCheckProblem: true,
    },
  });
  if (!integration?.enabled || integration.externalStoreNo == null) return null;
  const storeNo = integration.externalStoreNo;
  const now = deps.now ? deps.now() : new Date();
  // [round 3 · review B S3-2] An OFFLINE link still has its overflow decided: busy hours need nothing from the kitchen
  // system, so a busy-hours delivery still goes to Swift riders. The driver check is not used (the link is down), and
  // anything the kitchen would have taken stays on the tablet with the branch's own driver (LINK_OFFLINE).
  const offline = integration.linkOfflineAt != null;
  const reached = await decideKitchenRoute({
    orderId,
    mode: integration.overflowMode,
    busyHours: readBusyHours(integration.overflowBusyHours),
    now,
    driverCheckOn: !offline && dragontailDriverCheckEnabled(env),
    // [round 2 · review A S2-2] The stored answer: no HTTP call here (this runs in the hold-release sweep).
    driverCheck: () => (deps.driverCheck ? deps.driverCheck(storeNo) : Promise.resolve(storedDriverCheck(integration, now))),
    swiftRiders: () => (deps.swiftRiders ? deps.swiftRiders(order) : swiftRidersNearCheck(prisma, order, env)),
  });
  const decision = offline ? offlineRoute(reached) : reached;
  log().info({ orderId, route: decision.route, reason: decision.reason, note: decision.note }, '[KITCHEN-OVERFLOW] route decided');
  return decision;
}

/** [round 3] The claim's answer for a delivery while the link is offline and no usable plan reached it. */
export function decidedOffline(orderId: string): KitchenRouteDecision {
  return decided(orderId, 'LINK_OFFLINE', 'the kitchen link is offline: on the Swift tablet, own driver');
}

/** [round 3] While the link is offline, a decision for the kitchen means the tablet (own driver); Swift riders stand. */
export function offlineRoute(decision: KitchenRouteDecision): KitchenRouteDecision {
  if (decision.route !== 'KITCHEN') return decision;
  return decided(decision.orderId, 'LINK_OFFLINE', `${decision.note}; the kitchen link is offline: on the Swift tablet, own driver`);
}

/** The claim's answer when no plan reached it (a direct call, or a failed read before the claim): the kitchen. */
export function fallbackKitchenRoute(orderId: string, mode: KitchenOverflowModeName): KitchenRouteDecision {
  return mode === 'NONE'
    ? decided(orderId, 'OVERFLOW_OFF', 'overflow is off')
    : decided(orderId, 'OVERFLOW_CHECK_FAILED', 'the overflow could not be worked out before the claim: sent to the kitchen system, the safe default');
}

/**
 * [round 2 · review A S3-4] An overflow delivery (routed to Swift riders) whose cash no Swift rider may carry was bound
 * to the store's OWN driver at accept. It is on the tablet only, NOT in Dragontail, where this branch dispatches its
 * drivers, and its drivers were busy: operations are told, once per order, so it is not forgotten. Never throws.
 */
export async function noteOverflowKeptWithStore(
  prisma: PrismaClient,
  io: unknown,
  orderId: string,
): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { tenantId: true, orderNumber: true, kitchenRoute: true, kitchenRouteReason: true, fulfillmentMode: true, vendor: { select: { name: true } } },
    });
    if (order?.kitchenRoute !== 'SWIFT_RIDERS' || order.fulfillmentMode !== 'VENDOR_DELIVERY') return;
    const why = SWIFT_REASON_WORDS[order.kitchenRouteReason as KitchenRouteReason] ?? 'the overflow moved it';
    const name = order.vendor?.name ?? 'A branch';
    const { notifyAdmins, NotificationService } = await import('../notification/notification.service');
    await notifyAdmins(prisma, new NotificationService(prisma, io as never), {
      tenantId: order.tenantId,
      title: `Overflow order with the store's own driver: ${name}`,
      body: `Order ${order.orderNumber} was moved to Swift riders (${why}), but no Swift rider could carry its cash, so ${name}'s own driver delivers it. It is on the Swift tablet only, NOT in Dragontail, where the branch dispatches its drivers: call the store so it is not forgotten.`,
      data: { kind: 'kitchen_integration', orderId },
      dedupeKey: `kitchen:overflow-own-driver:${orderId}`,
    });
  } catch (err) {
    log().error({ err, orderId }, '[KITCHEN-OVERFLOW] operations note (own driver after overflow) failed');
  }
}

// ── What the store sees ─────────────────────────────────────────────────────

/** One order's kitchen-sync facts the store's screens and the rider refusal need. A bare state string is accepted. */
export type KitchenSyncFacts = { state: string; maybeInKitchen?: boolean } | string;

const stateOf = (sync: KitchenSyncFacts | null | undefined) => (sync == null ? null : typeof sync === 'string' ? sync : sync.state);

/** Kitchen-sync states in which the kitchen system has (or may have) the order: Swift must not send a rider.
 *  [round 2 · review A S3-3] A FALLBACK the kitchen MAY still have (the switch went off mid-send) counts too. */
export function kitchenHoldsOrder(sync: KitchenSyncFacts | null | undefined): boolean {
  const state = stateOf(sync);
  if (state == null) return false;
  if (state !== 'FALLBACK') return true;
  return typeof sync === 'object' && sync !== null && sync.maybeInKitchen === true;
}

/** The store's kitchen-sync facts for one order (one unique-key read), or null. */
export async function kitchenSyncStateOf(db: Pick<Prisma.TransactionClient, 'orderIntegrationSync'>, orderId: string): Promise<{ state: string; maybeInKitchen: boolean } | null> {
  return db.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } }, select: { state: true, maybeInKitchen: true } });
}

/** [DT-OVERFLOW] "Get a Swift rider" is refused while the kitchen system has the order (switch on or off: the row
 *  decides; an order the integration never touched has no row and passes with one read). */
export async function assertKitchenDoesNotHold(db: Pick<Prisma.TransactionClient, 'orderIntegrationSync'>, orderId: string): Promise<void> {
  if (kitchenHoldsOrder(await kitchenSyncStateOf(db, orderId))) throw new AppError(409, 'KITCHEN_HAS_ORDER', KITCHEN_HAS_ORDER_WORDS);
}

export const KITCHEN_HAS_ORDER_WORDS = 'This order is in Dragontail, and your own driver delivers it there. Swift can’t send a rider for it: Dragontail would not be told, and two drivers could come for one order. Dispatch it from Dragontail.';

const SWIFT_REASON_WORDS: Partial<Record<KitchenRouteReason, string>> = {
  BUSY_HOURS: 'it came in during your busy hours',
  NO_FREE_DRIVER: 'your drivers were all busy',
};

const KITCHEN_REASON_WORDS: Partial<Record<KitchenRouteReason, string>> = {
  DRIVER_FREE: 'one of your drivers was free',
  DRIVER_CHECK_FAILED: 'Swift could not check your drivers, so it went to them as usual',
  NO_SWIFT_RIDER_NEAR: 'no Swift rider near could carry it',
  SWIFT_RIDER_CHECK_FAILED: 'Swift could not check its riders, so it went to your drivers as usual',
  OVERFLOW_CHECK_FAILED: 'Swift could not check your drivers, so it went to them as usual',
};

export interface KitchenStoreView {
  /** The kitchen system has (or may have) this order: no Swift rider may be sent for it. */
  holdsOrder: boolean;
  route: KitchenRouteName | null;
  reason: string | null;
  title: string;
  detail: string;
}

/** The store's words for where a connected branch's order went. Null for an order the integration never touched. */
export function kitchenStoreView(
  order: { kitchenRoute?: string | null; kitchenRouteReason?: string | null; fulfillmentMode?: string | null },
  sync: KitchenSyncFacts | null | undefined,
): KitchenStoreView | null {
  const syncState = stateOf(sync);
  const route = order.kitchenRoute === 'KITCHEN' || order.kitchenRoute === 'SWIFT_RIDERS' || order.kitchenRoute === 'TABLET' ? order.kitchenRoute : null;
  const reason = order.kitchenRouteReason ?? null;
  // [round 3 · review B S3-2] The kitchen link was offline: the truth is "this tablet, your driver, not in Dragontail".
  if (route === 'TABLET') {
    return {
      holdsOrder: false, route, reason, title: 'On this tablet only, not in Dragontail',
      detail: 'Dragontail was not reachable, so this order came to this tablet. Make it from here; your own driver delivers it (Dragontail does not have it).',
    };
  }
  if (route === 'SWIFT_RIDERS') {
    const why = SWIFT_REASON_WORDS[reason as KitchenRouteReason];
    if (order.fulfillmentMode === 'VENDOR_DELIVERY') {
      return { holdsOrder: false, route, reason, title: 'Your driver delivers this one', detail: 'It is on this tablet only, not in Dragontail.' };
    }
    return {
      holdsOrder: false, route, reason,
      title: why ? `Swift rider: ${why}` : 'Swift rider',
      detail: 'Swift sent this order to this tablet and to Swift riders instead of Dragontail. It is not in Dragontail.',
    };
  }
  if (syncState == null) return null;
  if (syncState === 'FALLBACK' && kitchenHoldsOrder(sync)) {
    return {
      holdsOrder: true, route, reason, title: 'On this tablet, and maybe in Dragontail',
      detail: 'Dragontail may also have this order. Check Dragontail before you make it, so it is made once. Swift can’t send a rider for it: a Dragontail driver may come.',
    };
  }
  if (!kitchenHoldsOrder(sync)) {
    return { holdsOrder: false, route, reason, title: 'On this tablet', detail: 'Dragontail could not take this order, so it came to this tablet instead.' };
  }
  // [round 3 · review B S3-3] Only an order Dragontail ACCEPTED is said to be in Dragontail. Every state keeps the rider
  // refusal (holdsOrder), but the words say what Swift actually knows.
  if (syncState === 'QUEUED' || syncState === 'SENDING') {
    return {
      holdsOrder: true, route, reason, title: 'Being sent to Dragontail',
      detail: 'Swift is sending this order to Dragontail, where your own driver delivers it. Don’t make it from this tablet: if Dragontail can’t take it, this tablet rings.',
    };
  }
  if (syncState === 'UNKNOWN' || syncState === 'CANCELLING') {
    return {
      holdsOrder: true, route, reason, title: 'Maybe in Dragontail: check Dragontail',
      detail: 'Swift sent this order but Dragontail did not answer, so it may or may not be there. Check Dragontail before you make it, so it is made once. Swift can’t send a rider for it: a Dragontail driver may come.',
    };
  }
  const why = KITCHEN_REASON_WORDS[reason as KitchenRouteReason];
  return {
    holdsOrder: true, route, reason,
    title: 'In Dragontail: your own driver delivers it',
    detail: why ? `Sent to Dragontail (${why}).` : 'Sent to Dragontail.',
  };
}

// ── The setting (the store's owner or manager, and Swift operations) ─────────

export interface KitchenOverflowSettingView {
  /** The setting applies: the integration is on and this branch is connected and enabled. */
  available: boolean;
  mode: KitchenOverflowModeName;
  busyHours: BusyWindow[];
  updatedAt: Date | null;
  /** [DT-OUTAGE] The branch's kitchen link is offline: orders ring the tablet until it is back. */
  linkOffline: boolean;
  linkOfflineSince: Date | null;
  /** [round 2 · review A S2-3] "When all my drivers are busy" and "Both" may be chosen (DRAGONTAIL_DRIVER_CHECK). */
  driverCheckAvailable: boolean;
}

/** The branch's overflow setting. Not available (and nothing else said) while the switch is off or no connection. */
export async function readKitchenOverflowSetting(
  prisma: Pick<PrismaClient, 'vendorIntegration'>,
  vendorId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<KitchenOverflowSettingView> {
  const off: KitchenOverflowSettingView = { available: false, mode: 'NONE', busyHours: [], updatedAt: null, linkOffline: false, linkOfflineSince: null, driverCheckAvailable: false };
  if (!dragontailIntegrationEnabled(env)) return off;
  const row = await prisma.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } },
    select: { enabled: true, overflowMode: true, overflowBusyHours: true, overflowUpdatedAt: true, linkOfflineAt: true },
  });
  if (!row) return off;
  return {
    available: row.enabled, mode: row.overflowMode, busyHours: readBusyHours(row.overflowBusyHours), updatedAt: row.overflowUpdatedAt,
    linkOffline: row.enabled && row.linkOfflineAt != null, linkOfflineSince: row.enabled ? row.linkOfflineAt : null,
    driverCheckAvailable: dragontailDriverCheckEnabled(env),
  };
}

/** [round 3 · review B S4-3] The store-side change's audit action. */
export const KITCHEN_OVERFLOW_AUDIT_ACTION = 'VENDOR_KITCHEN_OVERFLOW_CHANGED';

export const DRIVER_CHECK_OFF_WORDS = '“When all my drivers are busy” is not available yet: Swift is waiting for Dragontail to confirm its driver check. Use busy hours for now.';

/** [round 2 · review A S4-1 · round 3 review B S4-3] Who changed it and how: the console's or the store's audit row, in
 *  the same transaction. No person data. */
export type KitchenOverflowAudit = (tx: Prisma.TransactionClient, entityId: string, facts: Record<string, string | number | boolean | null>) => Promise<void>;

/** Change the branch's overflow setting. Refused while the switch is off (nothing written) or with no connection. */
export async function writeKitchenOverflowSetting(
  prisma: Pick<PrismaClient, 'vendorIntegration' | '$transaction'>,
  vendorId: string,
  body: unknown,
  env: Record<string, string | undefined> = process.env,
  audit?: KitchenOverflowAudit,
): Promise<KitchenOverflowSettingView> {
  if (!dragontailIntegrationEnabled(env)) {
    throw new AppError(409, 'KITCHEN_SWITCH_OFF', 'The kitchen-system connection is off, so this setting cannot be changed now.');
  }
  const input = kitchenOverflowSettingSchema.parse(body ?? {});
  // [round 2 · review A S2-3] The driver check's two choices stay refused until Dragontail confirms what it lists.
  if ((input.mode === 'AUTO_DRIVER_CHECK' || input.mode === 'BOTH') && !dragontailDriverCheckEnabled(env)) {
    throw new AppError(409, 'DRIVER_CHECK_OFF', DRIVER_CHECK_OFF_WORDS);
  }
  const row = await prisma.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } },
    select: { id: true, overflowMode: true, overflowBusyHours: true },
  });
  if (!row) throw new AppError(404, 'KITCHEN_NOT_SET_UP', 'This branch is not connected to a kitchen system.');
  // [round 3 · review B S4-6] Busy hours with no window (sent empty, or omitted with none stored) would never move a thing.
  const windowsAfter = input.busyHours ?? readBusyHours(row.overflowBusyHours);
  if ((input.mode === 'BUSY_HOURS' || input.mode === 'BOTH') && windowsAfter.length === 0) {
    throw new AppError(400, 'BUSY_HOURS_EMPTY', 'Add at least one busy window, or choose another option.');
  }
  await prisma.$transaction(async (tx) => {
    const written = await tx.vendorIntegration.update({
      where: { id: row.id },
      data: {
        overflowMode: input.mode,
        ...(input.busyHours !== undefined && { overflowBusyHours: input.busyHours }),
        overflowUpdatedAt: new Date(),
      },
      select: { overflowMode: true, overflowBusyHours: true },
    });
    await audit?.(tx, row.id, {
      modeBefore: row.overflowMode, modeAfter: written.overflowMode,
      busyWindowsBefore: readBusyHours(row.overflowBusyHours).length, busyWindowsAfter: readBusyHours(written.overflowBusyHours).length,
    });
  });
  return readKitchenOverflowSetting(prisma, vendorId, env);
}

/** Operations: where this branch's recent deliveries went, and why (newest first). No person data. */
export async function listKitchenRoutes(prisma: Pick<PrismaClient, 'order'>, vendorId: string, query: { limit?: unknown }) {
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  return prisma.order.findMany({
    where: { vendorId, kitchenRoute: { not: null } },
    orderBy: { kitchenRouteAt: 'desc' },
    take: limit,
    select: { id: true, orderNumber: true, status: true, kitchenRoute: true, kitchenRouteReason: true, kitchenRouteAt: true, fulfillmentMode: true, riderId: true },
  });
}
