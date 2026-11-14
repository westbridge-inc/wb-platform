import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { dragontailIntegrationEnabled } from './kitchen-switch';
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

export type KitchenRouteName = 'KITCHEN' | 'SWIFT_RIDERS';

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
  /** Inside the branch's busy hours. */
  BUSY_HOURS: 'SWIFT_RIDERS',
  /** Dragontail listed no free vehicle. */
  NO_FREE_DRIVER: 'SWIFT_RIDERS',
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
  driverCheck: () => Promise<DriverCheck>;
  swiftRiders: () => Promise<SwiftRiderCheck>;
}): Promise<KitchenRouteDecision> {
  const { orderId, mode } = input;
  if (mode === 'NONE') return decided(orderId, 'OVERFLOW_OFF', 'overflow is off');
  const usesHours = mode === 'BUSY_HOURS' || mode === 'BOTH';
  const usesDriverCheck = mode === 'AUTO_DRIVER_CHECK' || mode === 'BOTH';
  let want: 'BUSY_HOURS' | 'NO_FREE_DRIVER';
  let why: string;
  if (usesHours && inBusyHours(input.busyHours, input.now)) {
    want = 'BUSY_HOURS';
    why = 'inside the busy hours';
  } else if (usesDriverCheck) {
    const check = await input.driverCheck().catch((err: unknown): DriverCheck => ({ kind: 'FAILED', problem: problemOf(err), ms: 0 }));
    if (check.kind === 'FREE') return decided(orderId, 'DRIVER_FREE', `Dragontail listed ${check.count} free vehicle(s) (${check.ms} ms)`);
    if (check.kind === 'FAILED') {
      return decided(orderId, 'DRIVER_CHECK_FAILED', `driver check failed (${check.problem}; ${check.ms} ms): sent to the kitchen system, the safe default`);
    }
    want = 'NO_FREE_DRIVER';
    why = `Dragontail listed no free vehicle (${check.ms} ms)`;
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
  /** Tests: the HTTP layer of the kitchen client. */
  client?: KitchenClientOverrides;
  /** Tests: replace a question outright. */
  driverCheck?: (storeNo: number) => Promise<DriverCheck>;
  swiftRiders?: (order: SwiftRiderProbeOrder) => Promise<SwiftRiderCheck>;
}

/** Ask Dragontail for the branch's free vehicles, within the budget. Never throws. */
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

/**
 * Work out the route for one order BEFORE the claim's transaction (the driver check is an HTTP call: never inside a
 * database transaction). Null when the order is not one the overflow decides: not a cash DELIVERY, not a connected
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
    select: { id: true, enabled: true, externalStoreNo: true, overflowMode: true, overflowBusyHours: true, linkOfflineAt: true },
  });
  // [DT-OUTAGE] An offline kitchen link claims nothing (the claim answers no): no route, no driver check.
  if (!integration?.enabled || integration.externalStoreNo == null || integration.linkOfflineAt) return null;
  const storeNo = integration.externalStoreNo;
  const decision = await decideKitchenRoute({
    orderId,
    mode: integration.overflowMode,
    busyHours: readBusyHours(integration.overflowBusyHours),
    now: deps.now ? deps.now() : new Date(),
    driverCheck: () => (deps.driverCheck ? deps.driverCheck(storeNo) : dragontailDriverCheck({ id: integration.id, provider: 'DRAGONTAIL' }, storeNo, env, deps.client)),
    swiftRiders: () => (deps.swiftRiders ? deps.swiftRiders(order) : swiftRidersNearCheck(prisma, order, env)),
  });
  log().info({ orderId, route: decision.route, reason: decision.reason, note: decision.note }, '[KITCHEN-OVERFLOW] route decided');
  return decision;
}

/** The claim's answer when no plan reached it (a direct call, or a failed read before the claim): the kitchen. */
export function fallbackKitchenRoute(orderId: string, mode: KitchenOverflowModeName): KitchenRouteDecision {
  return mode === 'NONE'
    ? decided(orderId, 'OVERFLOW_OFF', 'overflow is off')
    : decided(orderId, 'OVERFLOW_CHECK_FAILED', 'the overflow could not be worked out before the claim: sent to the kitchen system, the safe default');
}

// ── What the store sees ─────────────────────────────────────────────────────

/** Kitchen-sync states in which the kitchen system has (or may have) the order: Swift must not send a rider. */
export function kitchenHoldsOrder(syncState: string | null | undefined): boolean {
  return syncState != null && syncState !== 'FALLBACK';
}

/** The store's kitchen-sync state for one order (one unique-key read), or null. */
export async function kitchenSyncStateOf(db: Pick<Prisma.TransactionClient, 'orderIntegrationSync'>, orderId: string): Promise<string | null> {
  const sync = await db.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } }, select: { state: true } });
  return sync?.state ?? null;
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
  DRIVER_CHECK_FAILED: 'Dragontail did not answer the driver check in time, so it went to your drivers as usual',
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
  syncState: string | null | undefined,
): KitchenStoreView | null {
  const route = order.kitchenRoute === 'KITCHEN' || order.kitchenRoute === 'SWIFT_RIDERS' ? order.kitchenRoute : null;
  const reason = order.kitchenRouteReason ?? null;
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
  if (!kitchenHoldsOrder(syncState)) {
    return { holdsOrder: false, route, reason, title: 'On this tablet', detail: 'Dragontail could not take this order, so it came to this tablet instead.' };
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
}

/** The branch's overflow setting. Not available (and nothing else said) while the switch is off or no connection. */
export async function readKitchenOverflowSetting(
  prisma: Pick<PrismaClient, 'vendorIntegration'>,
  vendorId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<KitchenOverflowSettingView> {
  const off: KitchenOverflowSettingView = { available: false, mode: 'NONE', busyHours: [], updatedAt: null, linkOffline: false, linkOfflineSince: null };
  if (!dragontailIntegrationEnabled(env)) return off;
  const row = await prisma.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } },
    select: { enabled: true, overflowMode: true, overflowBusyHours: true, overflowUpdatedAt: true, linkOfflineAt: true },
  });
  if (!row) return off;
  return {
    available: row.enabled, mode: row.overflowMode, busyHours: readBusyHours(row.overflowBusyHours), updatedAt: row.overflowUpdatedAt,
    linkOffline: row.enabled && row.linkOfflineAt != null, linkOfflineSince: row.enabled ? row.linkOfflineAt : null,
  };
}

/** Change the branch's overflow setting. Refused while the switch is off (nothing written) or with no connection. */
export async function writeKitchenOverflowSetting(
  prisma: Pick<PrismaClient, 'vendorIntegration'>,
  vendorId: string,
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<KitchenOverflowSettingView> {
  if (!dragontailIntegrationEnabled(env)) {
    throw new AppError(409, 'KITCHEN_SWITCH_OFF', 'The kitchen-system connection is off, so this setting cannot be changed now.');
  }
  const input = kitchenOverflowSettingSchema.parse(body ?? {});
  const row = await prisma.vendorIntegration.findUnique({ where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } }, select: { id: true } });
  if (!row) throw new AppError(404, 'KITCHEN_NOT_SET_UP', 'This branch is not connected to a kitchen system.');
  if ((input.mode === 'BUSY_HOURS' || input.mode === 'BOTH') && input.busyHours !== undefined && input.busyHours.length === 0) {
    throw new AppError(400, 'BUSY_HOURS_EMPTY', 'Add at least one busy window, or choose another option.');
  }
  await prisma.vendorIntegration.update({
    where: { id: row.id },
    data: {
      overflowMode: input.mode,
      ...(input.busyHours !== undefined && { overflowBusyHours: input.busyHours }),
      overflowUpdatedAt: new Date(),
    },
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
