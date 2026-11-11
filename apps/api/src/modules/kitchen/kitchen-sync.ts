import type { OrderStatus, PrismaClient, VendorIntegration } from '@prisma/client';
import type { Server } from 'socket.io';
import { runWithTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { isTerminalOrderStatus, ORDER_TRANSITIONS } from '../order/order-status';
import { emitToOrderRoom, emitToStoreRoom } from '../order/order-room-emission.service';
import { kitchenLoginFor } from './kitchen-credentials';
import {
  KitchenPermanentError,
  type KitchenEvent,
  type KitchenIntegrationProvider,
  type KitchenOrder,
} from './kitchen-provider';
import { dragontailApiUrl, dragontailIntegrationEnabled, dragontailSettings } from './kitchen-switch';
import { DragontailAdapter } from './dragontail/dragontail-adapter';
import type { DragontailClientOptions } from './dragontail/dragontail-client';
import type { OrderService as OrderServiceType } from '../order/order.service';

/**
 * [KITCHEN-INTEGRATION · owner 11 Nov 2026] The sender, the receiver and the sweeps.
 *
 * OUTBOUND. A claimed order (kitchen-claim.ts) is a QUEUED row. The drainer leases it (QUEUED → SENDING by
 * compare-and-set, so two workers never send one order), builds the KitchenOrder and inserts it. Success → SENT,
 * and (INSERT_OK mode) the order is accepted on the store's behalf: PENDING → ACCEPTED → PREPARING in one commit,
 * as the store's own Accept does, with the delivery bound to the store's own driver (VENDOR_DELIVERY) in the same
 * commit — never Swift rider dispatch. ANY failure — an unmapped line, no credentials, a refusal, the network after
 * the spec's 3 retries — → FALLBACK: the store's tablet is rung exactly as a store without an integration is, and
 * operations are told. A row leaves SENDING exactly once, so an order is never both sent and fallen back by two
 * workers, and never sent twice.
 *
 * INBOUND. Webhook or poll, every kitchen event goes through applyKitchenEvent, which only ever asks the order
 * state machine for an edge it declares (ORDER_TRANSITIONS); an event that does not fit the order's current status
 * (late, repeated, out of order) changes nothing and is logged. Nothing here throws on a bad event.
 */

/** The status log's actor for the kitchen system's steps (the same system actor instant bookings use). */
export const KITCHEN_CHANGED_BY = 'system';
export const KITCHEN_LEASE_MS = 120_000;
const MAX_CANCEL_ATTEMPTS = 5;

export interface KitchenDeps {
  prisma: PrismaClient;
  io: Server;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Tests: the HTTP layer (fetch, sleep, backoff). */
  client?: Partial<Pick<DragontailClientOptions, 'fetch' | 'sleep' | 'backoffMs'>>;
}

const nowOf = (deps: KitchenDeps) => (deps.now ? deps.now() : new Date());
const envOf = (deps: KitchenDeps) => deps.env ?? process.env;

/** The provider for one connection, or null when its login does not resolve. */
export function kitchenProviderFor(
  deps: KitchenDeps,
  integration: Pick<VendorIntegration, 'provider' | 'secretRef'>,
  orderNumberOf: (order: KitchenOrder) => string = () => '',
): KitchenIntegrationProvider | null {
  const env = envOf(deps);
  const login = kitchenLoginFor(integration.secretRef, env);
  if (!login) return null;
  const settings = dragontailSettings(env);
  return new DragontailAdapter(
    { baseUrl: dragontailApiUrl(env), login, userLevel: settings.userLevel, timeoutMs: settings.timeoutMs, ...deps.client },
    settings,
    orderNumberOf,
  );
}

/** Operator words for a failure: never a credential, a body or a customer detail (messages are built that way). */
const problemOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

// ---------------------------------------------------------------------------
// Building the KitchenOrder
// ---------------------------------------------------------------------------

type BuildResult = { ok: true; order: KitchenOrder; orderNumber: string } | { ok: false; reason: string };

/** The order as the kitchen needs it, or why it cannot be sent (an unmapped line names how many, not which). */
export async function buildKitchenOrder(
  prisma: PrismaClient,
  sync: { orderId: string; externalOrderId: number; dailyNo: number },
  storeNo: number,
): Promise<BuildResult> {
  const order = await prisma.order.findUnique({
    where: { id: sync.orderId },
    select: {
      orderNumber: true, placedAt: true, fulfillment: true, paymentMethod: true,
      totalAmount: true, subtotalCustomer: true,
      deliveryAddress: true, deliveryLat: true, deliveryLng: true, deliveryInstructions: true,
      customer: { select: { firstName: true, lastName: true, phone: true } },
      items: {
        select: {
          itemId: true, name: true, quantity: true, specialInstructions: true, subStatus: true,
          selectedOptions: { select: { optionGroupName: true, optionName: true } },
        },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!order) return { ok: false, reason: 'the order is gone' };
  const lines = order.items.filter((l) => l.subStatus !== 'REMOVED');
  if (lines.length === 0) return { ok: false, reason: 'the order has no lines' };
  const catalogue = await prisma.item.findMany({
    where: { id: { in: lines.map((l) => l.itemId) } },
    select: {
      id: true, externalItemNo: true,
      optionGroups: { select: { name: true, options: { select: { name: true, externalItemNo: true } } } },
    },
  });
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  let unmapped = 0;
  const kitchenLines = lines.map((line) => {
    const item = byId.get(line.itemId);
    const itemNo = item?.externalItemNo?.trim() ?? '';
    if (!itemNo) unmapped += 1;
    const choices = line.selectedOptions.map((choice) => {
      const option = item?.optionGroups.find((g) => g.name === choice.optionGroupName)?.options.find((o) => o.name === choice.optionName);
      const no = option?.externalItemNo?.trim() ?? '';
      if (!no) unmapped += 1;
      return { itemNo: no, name: choice.optionName };
    });
    return { itemNo, name: line.name, quantity: line.quantity, choices, note: line.specialInstructions?.trim() || null };
  });
  if (unmapped > 0) return { ok: false, reason: `${unmapped} line(s) or choice(s) have no kitchen item number` };
  const delivery = order.fulfillment === 'DELIVERY';
  const total = Number(order.totalAmount);
  return {
    ok: true,
    orderNumber: order.orderNumber,
    order: {
      swiftOrderId: sync.orderId,
      storeNo,
      externalOrderId: sync.externalOrderId,
      dailyNo: sync.dailyNo,
      placedAt: order.placedAt,
      saleType: delivery ? 'DELIVERY' : 'TAKEAWAY',
      payment: order.paymentMethod === 'CASH' ? 'CASH' : 'MMG',
      orderTotal: total,
      netSales: Number(order.subtotalCustomer),
      // A Swift tip is paid with the order, at the door: never prepaid.
      prepaidTips: 0,
      cashToCollect: order.paymentMethod === 'CASH' ? total : 0,
      // Cash is paid when the customer receives the order (door or counter).
      isPaid: false,
      customer: delivery
        ? {
          firstName: order.customer.firstName, lastName: order.customer.lastName, phone: order.customer.phone,
          address: order.deliveryAddress, lat: order.deliveryLat, lng: order.deliveryLng,
        }
        : { firstName: order.customer.firstName, lastName: null, phone: null, address: null, lat: null, lng: null },
      driverNote: delivery ? order.deliveryInstructions : null,
      cookNote: null,
      lines: kitchenLines,
    },
  };
}

// ---------------------------------------------------------------------------
// The store's ring and operations' page
// ---------------------------------------------------------------------------

/** Ring the store's tablet for an order still waiting for its answer — the release's own alert, word for word. */
export async function ringStoreForOrder(deps: KitchenDeps, orderId: string): Promise<boolean> {
  const { prisma, io } = deps;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { select: { id: true } }, vendor: { select: { ownerId: true } } },
  });
  if (!order?.vendorId || !order.vendor || order.status !== 'PENDING') return false;
  await emitToStoreRoom(prisma, io, order.vendorId, 'order:new', { orderId: order.id, vendorId: order.vendorId, orderNumber: order.orderNumber }, { onlyWhileActive: true });
  try {
    const { NotificationService } = await import('../notification/notification.service');
    const { vendorRespondBy, vendorResponseSlaMinutes } = await import('../order/response-sla');
    const { holdWindowMs } = await import('../order/order.service');
    const owner = await prisma.vendorOwner.findUnique({ where: { id: order.vendor.ownerId } });
    if (owner) {
      const slaMinutes = await vendorResponseSlaMinutes(prisma);
      await new NotificationService(prisma, io).newOrderForVendor(
        owner.userId, order.orderNumber, order.items.length, Number(order.totalAmount), order.id,
        vendorRespondBy(order, { slaMinutes, holdMs: holdWindowMs() ?? 0 }),
      );
    }
  } catch (err) {
    log().error({ err, orderId }, '[KITCHEN] tablet ring after a kitchen fallback failed — the board and the alert ladder still show the order');
  }
  return true;
}

/** Tell operations once per (order, problem). Never throws. */
async function pageOperations(deps: KitchenDeps, input: { orderId: string; tenantId: string | null; key: string; title: string; body: string }) {
  try {
    const { notifyAdmins, NotificationService } = await import('../notification/notification.service');
    await notifyAdmins(deps.prisma, new NotificationService(deps.prisma, deps.io), {
      tenantId: input.tenantId,
      title: input.title,
      body: input.body,
      data: { kind: 'kitchen_integration', orderId: input.orderId },
      dedupeKey: `kitchen:${input.key}`,
    });
  } catch (err) {
    log().error({ err, orderId: input.orderId }, '[KITCHEN] operations page failed');
  }
}

async function noteIntegrationError(deps: KitchenDeps, integrationId: string, problem: string) {
  await deps.prisma.vendorIntegration.update({
    where: { id: integrationId },
    data: { lastError: problem.slice(0, 300), lastErrorAt: nowOf(deps) },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// OUTBOUND
// ---------------------------------------------------------------------------

/**
 * The sync could not (or must not) be sent: ring the store, tell operations. Leaves SENDING exactly once.
 * `ring=false` when the order no longer waits for the store (it was cancelled before the send).
 */
async function fallBack(deps: KitchenDeps, sync: { id: string; orderId: string; tenantId: string; vendorIntegrationId: string }, reason: string) {
  const moved = await deps.prisma.orderIntegrationSync.updateMany({
    where: { id: sync.id, state: { in: ['QUEUED', 'SENDING'] } },
    data: { state: 'FALLBACK', fallbackAt: nowOf(deps), lastError: reason.slice(0, 300), leaseUntil: null },
  });
  if (moved.count === 0) return;
  await noteIntegrationError(deps, sync.vendorIntegrationId, reason);
  const rang = await ringStoreForOrder(deps, sync.orderId);
  log().warn({ orderId: sync.orderId, reason }, '[KITCHEN] order not sent to the kitchen system — the store tablet was rung instead');
  const order = await deps.prisma.order.findUnique({ where: { id: sync.orderId }, select: { orderNumber: true } });
  await pageOperations(deps, {
    orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:fallback`,
    title: 'Kitchen system: order rang the tablet instead',
    body: `Order ${order?.orderNumber ?? sync.orderId} could not go to the store's kitchen system (${reason}). ${rang ? "The store's Swift tablet was rung; check the store answers it." : 'The order no longer waits for the store.'}`,
  });
}

/** Accept the order on the store's behalf: PENDING → ACCEPTED → PREPARING, own delivery bound in the same commit. */
export async function acceptForKitchen(deps: KitchenDeps, orderId: string, promiseSeconds: number | null): Promise<boolean> {
  const { OrderService, preparationMayStart, releaseLapsedHoldInTransaction } = await import('../order/order.service');
  const orders = new OrderService(deps.prisma, deps.io);
  try {
    await orders.updateStatus(orderId, 'ACCEPTED', KITCHEN_CHANGED_BY, "Accepted by the store's kitchen system", {
      allowedFrom: ['PENDING'],
      continueTo: { target: 'PREPARING', note: "Preparing: the store's kitchen system has the order", when: preparationMayStart },
      withinTransaction: async (tx, locked) => {
        await releaseLapsedHoldInTransaction(tx, orderId);
        const data: { fulfillmentMode?: 'VENDOR_DELIVERY'; fulfillmentModeVersion?: { increment: number }; estimatedPrepTime?: number } = {};
        // [KITCHEN-INTEGRATION] A connected store's delivery is its own driver's: bound here, in the accept's
        // commit, so no Swift rider is ever sought for it.
        if (locked.fulfillment === 'DELIVERY' && locked.fulfillmentMode !== 'VENDOR_DELIVERY' && !locked.riderId) {
          data.fulfillmentMode = 'VENDOR_DELIVERY';
          data.fulfillmentModeVersion = { increment: 1 };
        }
        if (promiseSeconds) data.estimatedPrepTime = Math.max(1, Math.round(promiseSeconds / 60));
        if (Object.keys(data).length > 0) await tx.order.update({ where: { id: orderId }, data });
      },
    });
    return true;
  } catch (err) {
    log().warn({ err, orderId }, '[KITCHEN] accept on the kitchen system answer refused — the order stays as it is');
    return false;
  }
}

/** Send one leased row. */
async function sendOne(deps: KitchenDeps, syncId: string): Promise<void> {
  const sync = await deps.prisma.orderIntegrationSync.findUnique({ where: { id: syncId }, include: { vendorIntegration: true } });
  if (!sync || sync.state !== 'SENDING') return;
  const order = await deps.prisma.order.findUnique({ where: { id: sync.orderId }, select: { status: true } });
  if (!order || order.status !== 'PENDING') {
    // Cancelled (or answered on the tablet) before it was sent: nothing goes to the kitchen.
    await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'SENDING' },
      data: { state: order?.status === 'CANCELLED' ? 'DONE' : 'FALLBACK', leaseUntil: null, lastError: `not sent: the order was ${order?.status ?? 'gone'} first` },
    });
    return;
  }
  const integration = sync.vendorIntegration;
  if (!integration.enabled || integration.externalStoreNo == null) {
    await fallBack(deps, sync, 'the connection was switched off');
    return;
  }
  const built = await buildKitchenOrder(deps.prisma, sync, integration.externalStoreNo);
  if (!built.ok) {
    await fallBack(deps, sync, built.reason);
    return;
  }
  const provider = kitchenProviderFor(deps, integration, () => built.orderNumber);
  if (!provider) {
    await fallBack(deps, sync, 'the store login is not in the credentials secret');
    return;
  }
  try {
    const answer = await provider.insertOrder(built.order);
    const sent = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'SENDING' },
      data: {
        state: 'SENT', sentAt: nowOf(deps), leaseUntil: null, lastError: null,
        updateStamp: answer.updateStamp, promiseSeconds: answer.promiseSeconds,
      },
    });
    if (sent.count === 0) return;
    await deps.prisma.vendorIntegration.update({ where: { id: integration.id }, data: { lastHealthyAt: nowOf(deps) } }).catch(() => undefined);
    if (dragontailSettings(envOf(deps)).acceptOn === 'INSERT_OK') {
      await runWithTenant(sync.tenantId, () => acceptForKitchen(deps, sync.orderId, answer.promiseSeconds));
    }
  } catch (err) {
    await fallBack(deps, sync, problemOf(err));
  }
}

/**
 * Drain QUEUED rows (and SENDING rows whose lease lapsed: a crashed sender). Each row is leased by compare-and-set
 * before anything is sent. Returns the ids sent or fallen back.
 */
export async function drainKitchenSyncs(deps: KitchenDeps, opts: { orderIds?: string[]; batch?: number } = {}): Promise<string[]> {
  if (!dragontailIntegrationEnabled(envOf(deps))) return [];
  const now = nowOf(deps);
  const due = await deps.prisma.orderIntegrationSync.findMany({
    where: {
      ...(opts.orderIds ? { orderId: { in: opts.orderIds } } : {}),
      OR: [{ state: 'QUEUED' }, { state: 'SENDING', leaseUntil: { lt: now } }],
    },
    select: { id: true, state: true, leaseUntil: true, tenantId: true },
    orderBy: { createdAt: 'asc' },
    take: opts.batch ?? 50,
  });
  const handled: string[] = [];
  for (const row of due) {
    const leased = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: row.id, state: row.state, leaseUntil: row.leaseUntil },
      data: { state: 'SENDING', leaseUntil: new Date(now.getTime() + KITCHEN_LEASE_MS), attempts: { increment: 1 } },
    });
    if (leased.count === 0) continue;
    if (row.state === 'SENDING') {
      // A sender died holding this row: whether the kitchen got it is unknown, so it is never re-sent blind.
      // The tablet rings (the store sees the order either way) and operations check the kitchen screen.
      const sync = await deps.prisma.orderIntegrationSync.findUniqueOrThrow({ where: { id: row.id } });
      await fallBack(deps, sync, 'a sender stopped mid-send; the kitchen may or may not have the order');
      handled.push(row.id);
      continue;
    }
    try {
      await sendOne(deps, row.id);
    } catch (err) {
      log().error({ err, syncId: row.id }, '[KITCHEN] send failed unexpectedly');
      const sync = await deps.prisma.orderIntegrationSync.findUnique({ where: { id: row.id } });
      if (sync) await fallBack(deps, sync, problemOf(err));
    }
    handled.push(row.id);
  }
  return handled;
}

/** A sent order the Swift side cancelled: tell the kitchen. Retried each tick; operations told when it keeps failing. */
export async function propagateKitchenCancellations(deps: KitchenDeps, batch = 50): Promise<number> {
  if (!dragontailIntegrationEnabled(envOf(deps))) return 0;
  await deps.prisma.orderIntegrationSync.updateMany({
    where: { state: 'SENT', order: { status: { in: ['CANCELLED', 'REFUNDED'] } } },
    data: { state: 'CANCEL_QUEUED', attempts: 0 },
  });
  // Finished orders owe the kitchen nothing more.
  await deps.prisma.orderIntegrationSync.updateMany({
    where: { state: 'SENT', order: { status: { in: ['DELIVERED', 'COMPLETED', 'FAILED', 'RETURNED'] } } },
    data: { state: 'DONE' },
  });
  const due = await deps.prisma.orderIntegrationSync.findMany({
    where: { state: 'CANCEL_QUEUED', attempts: { lt: MAX_CANCEL_ATTEMPTS } },
    include: { vendorIntegration: true },
    take: batch,
  });
  let told = 0;
  for (const sync of due) {
    const leased = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'CANCEL_QUEUED', attempts: sync.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (leased.count === 0) continue;
    const storeNo = sync.vendorIntegration.externalStoreNo;
    const built = storeNo == null ? null : await buildKitchenOrder(deps.prisma, sync, storeNo);
    const provider = built?.ok ? kitchenProviderFor(deps, sync.vendorIntegration, () => built.orderNumber) : null;
    try {
      if (!built?.ok || !provider) throw new KitchenPermanentError(built && !built.ok ? built.reason : 'the store login is not in the credentials secret');
      await provider.cancelOrder(built.order);
      await deps.prisma.orderIntegrationSync.updateMany({
        where: { id: sync.id, state: 'CANCEL_QUEUED' },
        data: { state: 'CANCELLED', cancelledAt: nowOf(deps), lastError: null },
      });
      told += 1;
    } catch (err) {
      const problem = problemOf(err);
      await deps.prisma.orderIntegrationSync.update({ where: { id: sync.id }, data: { lastError: problem } });
      if (sync.attempts + 1 >= MAX_CANCEL_ATTEMPTS) {
        const order = await deps.prisma.order.findUnique({ where: { id: sync.orderId }, select: { orderNumber: true } });
        await pageOperations(deps, {
          orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:cancel`,
          title: 'Kitchen system: a cancellation did not reach the kitchen',
          body: `Order ${order?.orderNumber ?? sync.orderId} was cancelled on Swift but the store's kitchen system was not told (${problem}). Call the store so it does not make or send it.`,
        });
      }
    }
  }
  return told;
}

/** KITCHEN_ACTION mode: a sent order the kitchen never acted on within its time rings the tablet after all. */
export async function ringUnacknowledgedKitchenOrders(deps: KitchenDeps): Promise<number> {
  const env = envOf(deps);
  if (!dragontailIntegrationEnabled(env)) return 0;
  const { acceptOn, ackTimeoutMs } = dragontailSettings(env);
  if (acceptOn !== 'KITCHEN_ACTION') return 0;
  const stale = await deps.prisma.orderIntegrationSync.findMany({
    where: { state: 'SENT', fallbackAt: null, sentAt: { lt: new Date(nowOf(deps).getTime() - ackTimeoutMs) }, order: { status: 'PENDING' } },
    take: 50,
  });
  for (const sync of stale) {
    const marked = await deps.prisma.orderIntegrationSync.updateMany({ where: { id: sync.id, fallbackAt: null }, data: { fallbackAt: nowOf(deps), lastError: 'the kitchen did not act on the order in time' } });
    if (marked.count === 0) continue;
    await ringStoreForOrder(deps, sync.orderId);
    await pageOperations(deps, {
      orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:unacknowledged`,
      title: 'Kitchen system: order not picked up by the kitchen',
      body: "An order sent to the store's kitchen system had no kitchen action in time. The store's Swift tablet was rung; check the store's kitchen screen.",
    });
  }
  return stale.length;
}

// ---------------------------------------------------------------------------
// INBOUND
// ---------------------------------------------------------------------------

export type KitchenEventOutcome = 'applied' | 'unchanged' | 'unknown-order' | 'ignored';

/** Move the order one declared edge, as the kitchen system; false when the edge does not fit right now. */
async function step(deps: KitchenDeps, orderId: string, target: OrderStatus, note: string, extra?: Parameters<OrderServiceType['updateStatus']>[4]): Promise<boolean> {
  const { OrderService } = await import('../order/order.service');
  try {
    await new OrderService(deps.prisma, deps.io).updateStatus(orderId, target, KITCHEN_CHANGED_BY, note, extra);
    return true;
  } catch (err) {
    log().info({ orderId, target, err: problemOf(err) }, '[KITCHEN] kitchen step does not fit the order now — unchanged');
    return false;
  }
}

/** Walk an order forward to `target` through declared edges only (ACCEPTED → PREPARING → READY_FOR_PICKUP). */
async function walkTo(deps: KitchenDeps, orderId: string, target: 'PREPARING' | 'READY_FOR_PICKUP', promiseSeconds: number | null): Promise<OrderStatus | null> {
  const ladder: OrderStatus[] = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];
  for (let i = 0; i < 4; i += 1) {
    const order = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!order) return null;
    const at = ladder.indexOf(order.status);
    if (at < 0 || at >= ladder.indexOf(target)) return order.status;
    if (order.status === 'PENDING') {
      if (!(await acceptForKitchen(deps, orderId, promiseSeconds))) return order.status;
      continue;
    }
    const next = ladder[at + 1]!;
    if (!ORDER_TRANSITIONS[next].includes(order.status)) return order.status;
    const note = next === 'PREPARING' ? "Preparing in the store's kitchen" : "Packed by the store's kitchen";
    if (!(await step(deps, orderId, next, note))) return order.status;
  }
  return (await deps.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } }))?.status ?? null;
}

/** Apply one kitchen event to its order. Never throws. */
export async function applyKitchenEvent(deps: KitchenDeps, integration: Pick<VendorIntegration, 'id' | 'externalStoreNo' | 'tenantId'>, event: KitchenEvent): Promise<KitchenEventOutcome> {
  try {
    if (integration.externalStoreNo == null || event.storeNo !== integration.externalStoreNo) return 'unknown-order';
    const sync = await deps.prisma.orderIntegrationSync.findUnique({
      where: { vendorIntegrationId_externalOrderId: { vendorIntegrationId: integration.id, externalOrderId: event.externalOrderId } },
    });
    if (!sync) {
      log().info({ storeNo: event.storeNo, action: event.action }, '[KITCHEN] event for an order Swift did not send — ignored');
      return 'unknown-order';
    }
    if (event.kind === 'IGNORED') {
      log().info({ orderId: sync.orderId, action: event.action }, '[KITCHEN] kitchen action Swift does not act on — logged');
      return 'ignored';
    }
    // A sync that fell back was never the kitchen's: the store runs it on the tablet.
    if (sync.state === 'FALLBACK' || sync.state === 'QUEUED') return 'unchanged';
    return await runWithTenant(sync.tenantId, async () => {
      const order = await deps.prisma.order.findUnique({
        where: { id: sync.orderId },
        select: { id: true, status: true, fulfillment: true, fulfillmentMode: true, customerId: true, orderNumber: true, vendorId: true, promisedAt: true },
      });
      if (!order) return 'unknown-order' as const;
      await deps.prisma.orderIntegrationSync.update({
        where: { id: sync.id },
        data: { lastAction: event.action, lastActionAt: event.at ?? nowOf(deps) },
      });
      const delivery = order.fulfillment === 'DELIVERY';
      const before = order.status;
      if (isTerminalOrderStatus(before)) return 'unchanged' as const;
      switch (event.kind) {
        case 'MAKE_LINE':
        case 'PREPARED':
        case 'COOKED': {
          const after = await walkTo(deps, order.id, 'PREPARING', sync.promiseSeconds);
          return after !== before ? 'applied' as const : 'unchanged' as const;
        }
        case 'PACKED': {
          const after = await walkTo(deps, order.id, 'READY_FOR_PICKUP', sync.promiseSeconds);
          return after !== before ? 'applied' as const : 'unchanged' as const;
        }
        case 'DISPATCHED': {
          if (!delivery) return 'unchanged' as const;
          await walkTo(deps, order.id, 'READY_FOR_PICKUP', sync.promiseSeconds);
          const first = await deps.prisma.orderIntegrationSync.updateMany({ where: { id: sync.id, dispatchedAt: null }, data: { dispatchedAt: event.at ?? nowOf(deps) } });
          if (first.count === 0) return 'unchanged' as const;
          await emitToOrderRoom(deps.prisma, deps.io, order.id, 'order:kitchen_update', { orderId: order.id, stage: 'DISPATCHED' });
          if (order.vendorId) await emitToStoreRoom(deps.prisma, deps.io, order.vendorId, 'order:kitchen_update', { orderId: order.id, stage: 'DISPATCHED' });
          const { NotificationService } = await import('../notification/notification.service');
          await new NotificationService(deps.prisma, deps.io).send({
            userId: order.customerId,
            type: 'ORDER_UPDATE',
            title: 'Your order is on its way',
            body: `Order ${order.orderNumber} is on its way with the store's own driver.`,
            data: { orderId: order.id, orderNumber: order.orderNumber, kind: 'kitchen_dispatched' },
          }).catch((err: unknown) => log().warn({ err, orderId: order.id }, '[KITCHEN] on-its-way push failed'));
          return 'applied' as const;
        }
        case 'ETA': {
          if (!delivery || event.etaSeconds == null) return 'unchanged' as const;
          const minutes = Math.max(1, Math.round(event.etaSeconds / 60));
          await deps.prisma.order.update({ where: { id: order.id }, data: { estimatedDeliveryTime: minutes } });
          await emitToOrderRoom(deps.prisma, deps.io, order.id, 'order:eta', { orderId: order.id, etaMinutes: minutes, source: 'store_driver' });
          const arrives = new Date(nowOf(deps).getTime() + event.etaSeconds * 1000);
          if (order.promisedAt && arrives > order.promisedAt) {
            const { revisePromise } = await import('../eta/promise');
            const { NotificationService } = await import('../notification/notification.service');
            await revisePromise({ prisma: deps.prisma, io: deps.io, notifications: new NotificationService(deps.prisma, deps.io) }, {
              orderId: order.id, newPromisedAt: arrives, source: 'VENDOR', reason: "the store's driver's route estimate",
            }).catch((err: unknown) => log().warn({ err, orderId: order.id }, '[KITCHEN] promise revision failed'));
          }
          return 'applied' as const;
        }
        case 'DELIVERED': {
          if (!delivery || order.fulfillmentMode !== 'VENDOR_DELIVERY') return 'unchanged' as const;
          const ready = await walkTo(deps, order.id, 'READY_FOR_PICKUP', sync.promiseSeconds);
          if (ready !== 'READY_FOR_PICKUP') return 'unchanged' as const;
          const done = await step(deps, order.id, 'DELIVERED', "Delivered by the store's own driver", {
            allowedFrom: ['READY_FOR_PICKUP'],
            expectedFulfillment: 'DELIVERY',
            expectedFulfillmentMode: 'VENDOR_DELIVERY',
            expectedRiderId: null,
            expectedDriverId: null,
          });
          if (done) await deps.prisma.orderIntegrationSync.updateMany({ where: { id: sync.id, state: 'SENT' }, data: { state: 'DONE' } });
          return done ? 'applied' as const : 'unchanged' as const;
        }
        case 'UNASSIGNED':
        case 'UNDELIVERED': {
          await pageOperations(deps, {
            orderId: order.id, tenantId: sync.tenantId, key: `${sync.id}:${event.kind}`,
            title: event.kind === 'UNDELIVERED' ? "Kitchen system: the store's driver could not deliver" : "Kitchen system: order taken off the store's driver",
            body: `Order ${order.orderNumber}: the store's kitchen system reported "${event.action}". Call the store, then the customer if the order is late.`,
          });
          return 'applied' as const;
        }
        default:
          return 'ignored' as const;
      }
    });
  } catch (err) {
    log().error({ err, action: event.action }, '[KITCHEN] applying a kitchen event failed — unchanged');
    return 'unchanged';
  }
}

/** Apply events in the order they happened (unknown times last, in arrival order). */
export async function applyKitchenEvents(deps: KitchenDeps, integration: Pick<VendorIntegration, 'id' | 'externalStoreNo' | 'tenantId'>, events: KitchenEvent[]): Promise<KitchenEventOutcome[]> {
  const ordered = events.map((e, i) => ({ e, i })).sort((a, b) => {
    const ta = a.e.at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const tb = b.e.at?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return ta - tb || a.i - b.i;
  });
  const out: KitchenEventOutcome[] = [];
  for (const { e } of ordered) out.push(await applyKitchenEvent(deps, integration, e));
  return out;
}

/** Poll every enabled connection whose interval passed: GetPosNotification + the updateStamp catch-up. */
export async function pollKitchenIntegrations(deps: KitchenDeps): Promise<number> {
  const env = envOf(deps);
  if (!dragontailIntegrationEnabled(env)) return 0;
  const { pollSeconds } = dragontailSettings(env);
  if (pollSeconds === 0) return 0;
  const now = nowOf(deps);
  const due = await deps.prisma.vendorIntegration.findMany({
    where: {
      enabled: true, externalStoreNo: { not: null },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(now.getTime() - pollSeconds * 1000) } }],
    },
    take: 50,
  });
  let polled = 0;
  for (const integration of due) {
    const claimed = await deps.prisma.vendorIntegration.updateMany({
      where: { id: integration.id, lastPolledAt: integration.lastPolledAt },
      data: { lastPolledAt: now },
    });
    if (claimed.count === 0) continue;
    const provider = kitchenProviderFor(deps, integration);
    if (!provider) {
      await noteIntegrationError(deps, integration.id, 'the store login is not in the credentials secret');
      continue;
    }
    try {
      const result = await provider.pollNotifications(integration.externalStoreNo!, integration.pollUpdateStamp);
      await applyKitchenEvents(deps, integration, result.events);
      await deps.prisma.vendorIntegration.update({
        where: { id: integration.id },
        data: { lastHealthyAt: nowOf(deps), ...(result.nextCursor !== null ? { pollUpdateStamp: result.nextCursor } : {}) },
      });
      polled += 1;
    } catch (err) {
      await noteIntegrationError(deps, integration.id, problemOf(err));
    }
  }
  return polled;
}

/** The worker's tick: send, propagate cancels, re-ring unacknowledged, poll. Each part runs on its own. */
export async function runKitchenTick(deps: KitchenDeps): Promise<void> {
  if (!dragontailIntegrationEnabled(envOf(deps))) return;
  for (const [name, run] of [
    ['drain', () => drainKitchenSyncs(deps)],
    ['cancel', () => propagateKitchenCancellations(deps)],
    ['unacknowledged', () => ringUnacknowledgedKitchenOrders(deps)],
    ['poll', () => pollKitchenIntegrations(deps)],
  ] as const) {
    try {
      await run();
    } catch (err) {
      log().error({ err, part: name }, '[KITCHEN] tick part failed; the others still ran');
    }
  }
}
