import type { Prisma, PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';
import { dragontailIntegrationEnabled, dragontailSettings, KITCHEN_STUCK_MS } from './kitchen-switch';
import { fallbackKitchenRoute, planKitchenRoute, type KitchenRouteDecision, type KitchenRouteDeps } from './kitchen-overflow';

/**
 * [KITCHEN-INTEGRATION] The two questions the order spine asks, kept light (no service imports) so order.service
 * and the alert ladder can depend on it without a cycle.
 *
 * 1. CLAIM — at the exact point a store would first be alerted of an order (the hold release, or checkout for an
 *    order born unheld), does this store's kitchen system take the order instead of the tablet ring? Yes only when
 *    the switch is on, the store has an ENABLED connection, and the order is one the integration carries:
 *      - a FOOD order (a kitchen makes it), DELIVERY or PICKUP;
 *      - paid in CASH. An MMG order is NOT sent: Swift's payment-first law starts preparation only after the store
 *        confirms the money ("Paid by MMG"), which only the tablet can do; it rings as before;
 *      - a DELIVERY only when the store delivers itself (selfDeliveryEnabled): a connected store's orders go with
 *        its own drivers and never enter Swift rider dispatch.
 *    The claim is ONE row in order_integration_syncs (unique per order and provider), written inside the caller's
 *    transaction, which IS the outbox: the sender drains it, and any failure rings the tablet instead.
 *    [DT-OVERFLOW · owner 14 Nov 2026] A DELIVERY first gets its ROUTE (kitchen-overflow.ts), decided before the
 *    transaction and written once on the order by compare-and-set inside it: KITCHEN → claimed as above; SWIFT_RIDERS
 *    → NOT claimed (no sync row, no number, nothing sent): the caller rings the tablet and the order goes to Swift
 *    riders. A second claim of the same order answers from the recorded route, so it lives in exactly one place.
 *
 * 2. THE LADDER — the store's alert ladder is the tablet backstop for every claim: it WAITS while a send is in
 *    flight (bounded), RINGS the tablet for a claim that is stuck, unaccepted or left behind by the switch being
 *    turned off, and otherwise carries on as for any store.
 *
 * While the switch is off the claim answers "no" without touching the database; the ladder makes one unique-key
 * read per rung so a claim stranded by the switch is still rung.
 */

export type KitchenClaimDb = Pick<Prisma.TransactionClient, 'order' | 'vendorIntegration' | 'orderIntegrationSync' | '$queryRaw'>;

/** Why an order is (not) carried. Exported for the contract tests and the admin view. */
export function kitchenEligibility(order: {
  orderType: string;
  fulfillment: string;
  paymentMethod: string;
  vendorSelfDelivers: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (order.orderType !== 'FOOD_DELIVERY') return { ok: false, reason: 'not a food order' };
  if (order.fulfillment !== 'DELIVERY' && order.fulfillment !== 'PICKUP') return { ok: false, reason: 'not a delivery or pickup' };
  if (order.paymentMethod !== 'CASH') return { ok: false, reason: 'not a cash order (MMG is confirmed on the tablet first)' };
  if (order.fulfillment === 'DELIVERY' && !order.vendorSelfDelivers) return { ok: false, reason: 'the store does not deliver itself' };
  return { ok: true };
}

/**
 * Claim the order for its store's kitchen system, inside the caller's transaction. Returns true when the kitchen
 * system takes it (the caller then does NOT ring the tablet). Idempotent: a second call finds the row and answers
 * from it (true unless that sync already fell back).
 */
export async function claimForKitchenInTransaction(
  tx: KitchenClaimDb,
  orderId: string,
  env: Record<string, string | undefined> = process.env,
  /** [DT-OVERFLOW] The route worked out before this transaction (planKitchenRoute); absent → the kitchen (as before). */
  plan: KitchenRouteDecision | null = null,
): Promise<boolean> {
  if (!dragontailIntegrationEnabled(env)) return false;
  const existing = await tx.orderIntegrationSync.findUnique({
    where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } },
    select: { state: true },
  });
  if (existing) return existing.state !== 'FALLBACK';
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      vendorId: true, status: true, orderType: true, fulfillment: true, paymentMethod: true, kitchenRoute: true,
      vendor: { select: { selfDeliveryEnabled: true } },
    },
  });
  // [DT-OVERFLOW] Already routed to the Swift tablet and Swift riders: never claimed afterwards.
  if (order?.kitchenRoute === 'SWIFT_RIDERS') return false;
  if (!order?.vendorId || order.status !== 'PENDING') return false;
  const integration = await tx.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId: order.vendorId, provider: 'DRAGONTAIL' } },
    select: { id: true, enabled: true, externalStoreNo: true, overflowMode: true, linkOfflineAt: true },
  });
  if (!integration?.enabled || integration.externalStoreNo == null) return false;
  // [DT-OUTAGE] The branch's kitchen link is OFFLINE (kitchen-link.ts): nothing is claimed; the order rings the tablet
  // as for any store (pickups and deliveries), and no route is recorded.
  if (integration.linkOfflineAt) return false;
  const eligible = kitchenEligibility({
    orderType: order.orderType, fulfillment: order.fulfillment, paymentMethod: order.paymentMethod,
    vendorSelfDelivers: order.vendor?.selfDeliveryEnabled ?? false,
  });
  if (!eligible.ok) return false;
  if (order.fulfillment === 'DELIVERY') {
    // [DT-OVERFLOW] The ONE route of this delivery, written once (compare-and-set on a still-unrouted order). A
    // concurrent claim that routed it first wins: its commit is seen here, and this claim answers from it.
    const decision = plan && plan.orderId === orderId ? plan : fallbackKitchenRoute(orderId, integration.overflowMode);
    const routed = await tx.order.updateMany({
      where: { id: orderId, kitchenRoute: null },
      data: { kitchenRoute: decision.route, kitchenRouteReason: decision.reason, kitchenRouteAt: new Date() },
    });
    if (routed.count !== 1) {
      const now = await tx.order.findUnique({ where: { id: orderId }, select: { kitchenRoute: true } });
      if (now?.kitchenRoute !== 'KITCHEN') return false;
      const sync = await tx.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } }, select: { state: true } });
      return sync != null && sync.state !== 'FALLBACK';
    }
    // Swift riders: nothing is claimed, numbered or sent. The caller rings the tablet as for any store.
    if (decision.route === 'SWIFT_RIDERS') return false;
  }
  // [review A S2-1 · B S4-1] The store's next number, taken atomically on the counter of (provider, store number):
  // never the connection's, so a recreated or renumbered connection never reuses an id; and the base is the one
  // frozen when that counter was born, so a changed DRAGONTAIL_ORDER_ID_BASE never collides with ids already used.
  const { orderIdBase } = dragontailSettings(env);
  const [counter] = await tx.$queryRaw<Array<{ seq: number; base: number }>>`
    INSERT INTO "kitchen_order_counters" ("provider", "externalStoreNo", "orderIdBase", "next", "updatedAt")
    VALUES ('DRAGONTAIL'::"KitchenProvider", ${integration.externalStoreNo}, ${orderIdBase}, 2, now())
    ON CONFLICT ("provider", "externalStoreNo")
      DO UPDATE SET "next" = "kitchen_order_counters"."next" + 1, "updatedAt" = now()
    RETURNING ("next" - 1) AS seq, "orderIdBase" AS base`;
  if (!counter) throw new Error('kitchen order counter returned no row');
  const sequence = Number(counter.seq);
  await tx.orderIntegrationSync.create({
    data: {
      orderId,
      vendorIntegrationId: integration.id,
      provider: 'DRAGONTAIL',
      externalOrderId: Number(counter.base) + sequence,
      externalStoreNo: integration.externalStoreNo,
      // "if it's long, send only the last 4 digits" (spec, dailyNo): 1..9999, never 0
      dailyNo: ((sequence - 1) % 9_999) + 1,
      state: 'QUEUED',
    },
  });
  return true;
}

async function skipKitchenNumber(prisma: PrismaClient, orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { vendorId: true } });
  if (!order?.vendorId) return;
  const integration = await prisma.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId: order.vendorId, provider: 'DRAGONTAIL' } },
    select: { externalStoreNo: true },
  });
  if (integration?.externalStoreNo == null) return;
  await prisma.kitchenOrderCounter.update({
    where: { provider_externalStoreNo: { provider: 'DRAGONTAIL', externalStoreNo: integration.externalStoreNo } },
    data: { next: { increment: 1 } },
  });
}

/**
 * The claim in its OWN transaction, after the caller's commit (the hold release and checkout's tail). [review A
 * S2-1 · B S3-8] It never runs inside the release transaction: a failing claim must never roll back a release or
 * stop the sweep for other orders and stores. Any error answers false, so the caller rings the tablet as usual.
 */
export async function claimForKitchen(
  prisma: PrismaClient,
  orderId: string,
  env: Record<string, string | undefined> = process.env,
  routeDeps: KitchenRouteDeps = {},
): Promise<boolean> {
  if (!dragontailIntegrationEnabled(env)) return false;
  // [DT-OVERFLOW] The delivery's route, worked out OUTSIDE any transaction (the driver check is a short HTTP call).
  // A failed plan is no plan: the claim then routes the order to the kitchen, as before (the safe default).
  const plan = await planKitchenRoute(prisma, orderId, env, routeDeps).catch((err: unknown) => {
    log().error({ err, orderId }, '[KITCHEN-OVERFLOW] the route could not be worked out; the kitchen keeps the order');
    return null;
  });
  try {
    return await prisma.$transaction((tx) => claimForKitchenInTransaction(tx, orderId, env, plan));
  } catch (err) {
    // [delta review S4-2] A commit whose answer was lost: the claim may be there after all. Ringing it too would
    // have the store make it twice, so the row decides.
    const there = await prisma.orderIntegrationSync.findUnique({
      where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } },
      select: { state: true },
    }).catch(() => null);
    if (there && there.state !== 'FALLBACK') return true;
    log().error({ err, orderId }, '[KITCHEN] claim failed; the store is rung as usual');
    // A (provider, store number, order id) already taken — Dragontail's own key; only a row written by hand, or a
    // counter row deleted by hand, can do that — rolled the counter back with the claim: step past it, so the
    // store's next order is not refused on the same number forever.
    if ((err as { code?: string }).code === 'P2002') await skipKitchenNumber(prisma, orderId).catch(() => undefined);
    return false;
  }
}

/** A sent order still waiting for the store this long after the send was not accepted for it: ring the tablet. */
export const KITCHEN_ACCEPT_GRACE_MS = 30_000;

export type KitchenLadderDecision =
  /** No kitchen claim (or it already fell back): the ladder rings as for any store. */
  | 'GO'
  /** The kitchen system is being given the order right now: the ladder waits a rung. */
  | 'WAIT'
  /** [review B S2-1] A claim is stuck (the switch was turned off, the sender is not running, the accept failed, or
   *  the kitchen never acted): ring the tablet NOW, then the ladder carries on as for any store. */
  | 'RING';

/**
 * What the store's alert ladder does for this order. With the switch ON and no claim, or a claim that fell back:
 * GO. A claim being sent: WAIT, but never longer than KITCHEN_STUCK_MS. With the switch OFF the ladder still looks
 * (one unique-key read): a claim left waiting when the switch was turned off is RUNG, never left to auto-cancel.
 */
export async function kitchenLadderDecision(
  prisma: Pick<PrismaClient, 'orderIntegrationSync' | 'order'>,
  orderId: string,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<KitchenLadderDecision> {
  const sync = await prisma.orderIntegrationSync.findUnique({
    where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } },
    select: { state: true, sentAt: true, fallbackAt: true, createdAt: true },
  });
  if (!sync || sync.fallbackAt || sync.state === 'FALLBACK') return 'GO';
  const on = dragontailIntegrationEnabled(env);
  if (sync.state === 'QUEUED' || sync.state === 'SENDING') {
    if (!on) return 'RING';
    return now.getTime() - sync.createdAt.getTime() >= KITCHEN_STUCK_MS ? 'RING' : 'WAIT';
  }
  if (sync.state === 'UNKNOWN' || sync.state === 'CANCELLING') {
    // [review B S3-3] The kitchen MAY have it: while the switch is on the ladder waits (no double-make) and the tick
    // settles it (confirmed, or cancelled there and then rung). [delta review S2-1] With the switch OFF nothing will
    // settle it: the tablet rings (the store is back on the tablet) and operations are told to call the store so it
    // is made once.
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (order?.status !== 'PENDING') return 'GO';
    return on ? 'WAIT' : 'RING';
  }
  if (sync.state === 'SENT') {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (order?.status !== 'PENDING') return 'GO';
    const age = sync.sentAt ? now.getTime() - sync.sentAt.getTime() : Number.MAX_SAFE_INTEGER;
    const { acceptOn, ackTimeoutMs } = dragontailSettings(env);
    const allowed = on && acceptOn === 'KITCHEN_ACTION' ? ackTimeoutMs : KITCHEN_ACCEPT_GRACE_MS;
    return age < allowed ? 'WAIT' : 'RING';
  }
  return 'GO';
}

/** Should the store's alert ladder hold its re-alert for this order right now? */
export async function kitchenDefersStoreAlert(
  prisma: Pick<PrismaClient, 'orderIntegrationSync' | 'order'>,
  orderId: string,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return (await kitchenLadderDecision(prisma, orderId, now, env)) === 'WAIT';
}
