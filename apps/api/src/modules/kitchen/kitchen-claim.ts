import type { Prisma, PrismaClient } from '@prisma/client';
import { dragontailIntegrationEnabled, dragontailSettings } from './kitchen-switch';

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
 *
 * 2. DEFER — must the store's alert ladder hold its re-alert because the kitchen system is being given the order
 *    right now? Only while the send is in flight (or, in KITCHEN_ACTION mode, waiting for the kitchen's first
 *    action within its time). A sync that fell back never defers: the store is rung as for any store.
 *
 * While the switch is off both answers are "no" without touching the database.
 */

export type KitchenClaimDb = Pick<Prisma.TransactionClient, 'order' | 'vendorIntegration' | 'orderIntegrationSync'>;

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
export async function claimForKitchenInTransaction(tx: KitchenClaimDb, orderId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!dragontailIntegrationEnabled(env)) return false;
  const existing = await tx.orderIntegrationSync.findUnique({
    where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } },
    select: { state: true },
  });
  if (existing) return existing.state !== 'FALLBACK';
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      vendorId: true, status: true, orderType: true, fulfillment: true, paymentMethod: true,
      vendor: { select: { selfDeliveryEnabled: true } },
    },
  });
  if (!order?.vendorId || order.status !== 'PENDING') return false;
  const integration = await tx.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId: order.vendorId, provider: 'DRAGONTAIL' } },
    select: { id: true, enabled: true, externalStoreNo: true },
  });
  if (!integration?.enabled || integration.externalStoreNo == null) return false;
  const eligible = kitchenEligibility({
    orderType: order.orderType, fulfillment: order.fulfillment, paymentMethod: order.paymentMethod,
    vendorSelfDelivers: order.vendor?.selfDeliveryEnabled ?? false,
  });
  if (!eligible.ok) return false;
  // The store's next number, taken atomically on the connection row: two claims never share one.
  const bumped = await tx.vendorIntegration.update({
    where: { id: integration.id },
    data: { nextExternalOrderNo: { increment: 1 } },
    select: { nextExternalOrderNo: true },
  });
  const sequence = bumped.nextExternalOrderNo - 1;
  const { orderIdBase } = dragontailSettings(env);
  await tx.orderIntegrationSync.create({
    data: {
      orderId,
      vendorIntegrationId: integration.id,
      provider: 'DRAGONTAIL',
      externalOrderId: orderIdBase + sequence,
      // "if it's long, send only the last 4 digits" (spec, dailyNo)
      dailyNo: sequence % 10_000,
      state: 'QUEUED',
    },
  });
  return true;
}

/** The same claim in its own transaction (checkout's post-commit tail, where no transaction is open). */
export async function claimForKitchen(prisma: PrismaClient, orderId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!dragontailIntegrationEnabled(env)) return false;
  return prisma.$transaction((tx) => claimForKitchenInTransaction(tx, orderId, env));
}

/** Should the store's alert ladder hold its re-alert for this order right now? */
export async function kitchenDefersStoreAlert(
  prisma: Pick<PrismaClient, 'orderIntegrationSync'>,
  orderId: string,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (!dragontailIntegrationEnabled(env)) return false;
  const sync = await prisma.orderIntegrationSync.findUnique({
    where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } },
    select: { state: true, sentAt: true, fallbackAt: true },
  });
  if (!sync || sync.fallbackAt) return false;
  if (sync.state === 'QUEUED' || sync.state === 'SENDING') return true;
  if (sync.state === 'SENT') {
    const { acceptOn, ackTimeoutMs } = dragontailSettings(env);
    return acceptOn === 'KITCHEN_ACTION' && !!sync.sentAt && now.getTime() - sync.sentAt.getTime() < ackTimeoutMs;
  }
  return false;
}
