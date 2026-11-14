import { randomUUID } from 'node:crypto';
import type { OrderStatus, PrismaClient, VendorIntegration } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import { runWithTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { isTerminalOrderStatus, ORDER_TRANSITIONS } from '../order/order-status';
import { kitchenModifiers } from '../order/kitchen-modifiers';
import { emitToOrderRoom, emitToStoreRoom } from '../order/order-room-emission.service';
import { vendorOperateRefusal, type StoreRoleVerifier } from '../vendor/vendor-operate';
import { kitchenLoginFor } from './kitchen-credentials';
import { KITCHEN_ACCEPT_GRACE_MS, kitchenLadderDecision } from './kitchen-claim';
import { kitchenBreakerSettings, recordLinkFailure, recordLinkSuccess } from './kitchen-link';
import {
  KitchenPermanentError,
  KitchenTransientError,
  type KitchenEvent,
  type KitchenInsertResult,
  type KitchenIntegrationProvider,
  type KitchenOrder,
} from './kitchen-provider';
import {
  dragontailApiUrl,
  dragontailApiUrlProblem,
  dragontailIntegrationEnabled,
  dragontailSettings,
  KITCHEN_LEASE_MS,
  KITCHEN_SEND_BUDGET_MS,
  KITCHEN_CANCEL_BUDGET_MS,
  KITCHEN_STUCK_MS,
  KITCHEN_TICK_BUDGET_MS,
  KITCHEN_UNKNOWN_RETRY_MS,
  KITCHEN_VERIFY_MS,
} from './kitchen-switch';
import { DragontailAdapter } from './dragontail/dragontail-adapter';
import type { DragontailClientOptions } from './dragontail/dragontail-client';
import type { OrderService as OrderServiceType } from '../order/order.service';

/**
 * [KITCHEN-INTEGRATION · owner 11 Nov 2026] The sender, the receiver and the sweeps.
 *
 * OUTBOUND. A claimed order (kitchen-claim.ts) is a QUEUED row. The drainer leases it (QUEUED → SENDING by
 * compare-and-set, the lease counted from that moment, longer than the one deadline a whole send has), checks the
 * store may take new work (the store's own Accept gate), builds the KitchenOrder and inserts it. Success → SENT, and
 * (INSERT_OK mode) the order is accepted on the store's behalf: PENDING → ACCEPTED → PREPARING in one commit, as the
 * store's own Accept does, with the delivery bound to the store's own driver (VENDOR_DELIVERY) in the same commit —
 * never Swift rider dispatch. If that accept is refused, the tablet rings. ANY failure before the kitchen has the
 * order — an unmapped line, no credentials, a refusal, the store held, the spec's retries spent — → FALLBACK: the
 * store's tablet is rung exactly as a store without an integration is, and operations are told. An insert that
 * TIMED OUT may have landed: a best-effort cancel is sent before the tablet rings, and operations are told the
 * kitchen may have it. A row leaves SENDING exactly once, so an order is never sent twice.
 *
 * INBOUND. Webhook or poll, every kitchen event goes through applyKitchenEvent, which first asks the store's own
 * gate (in-flight work) and then only the order state machine for an edge it declares (ORDER_TRANSITIONS); an event
 * that does not fit (late, repeated, out of order, a held store) changes nothing and is logged. Nothing throws.
 *
 * ONE TICK at a time (a Redis lock), with a wall-time budget, so kitchen work never fills the order workers that
 * also run auto-cancel and auto-complete.
 */

/** The status log's actor for the kitchen system's steps (the same system actor instant bookings use). */
export const KITCHEN_CHANGED_BY = 'system';
export { KITCHEN_LEASE_MS };
const MAX_CANCEL_ATTEMPTS = 5;
export const KITCHEN_TICK_LOCK = 'kitchen:tick:lock';

export interface KitchenDeps {
  prisma: PrismaClient;
  io: Server;
  /** The app/job Redis: the offer store every OrderService is built with, the tick lock and the ETA slip gate. */
  redis: Redis;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Tests: the HTTP layer (fetch, sleep, backoff). */
  client?: Partial<Pick<DragontailClientOptions, 'fetch' | 'sleep' | 'backoffMs'>>;
}

const nowOf = (deps: KitchenDeps) => (deps.now ? deps.now() : new Date());
const envOf = (deps: KitchenDeps) => deps.env ?? process.env;

/** [review A S4-4 · B S3-4] One token per connection and login, reused until Dragontail answers 403. In memory only. */
const tokenCache = new Map<string, string>();
const tokenKey = (integrationId: string, userName: string) => `${integrationId}\u0000${userName}`;
/** Tests. */
export function forgetKitchenTokens(): void {
  tokenCache.clear();
}

export type KitchenProviderAnswer = { ok: true; provider: KitchenIntegrationProvider } | { ok: false; problem: string };

/** The provider for one connection, or why there is none (no login under its key, or an address that is refused). */
export function kitchenProvider(
  deps: Pick<KitchenDeps, 'env' | 'client'>,
  integration: Pick<VendorIntegration, 'id' | 'provider'>,
  orderNumberOf: (order: KitchenOrder) => string = () => '',
  opts: { freshToken?: boolean } = {},
): KitchenProviderAnswer {
  const env = deps.env ?? process.env;
  const login = kitchenLoginFor(integration, env);
  if (!login) return { ok: false, problem: 'the store login is not in the credentials secret' };
  const baseUrl = dragontailApiUrl(env);
  const urlProblem = dragontailApiUrlProblem(baseUrl, env);
  if (urlProblem) return { ok: false, problem: urlProblem };
  const settings = dragontailSettings(env);
  const key = tokenKey(integration.id, login.userName);
  return {
    ok: true,
    provider: new DragontailAdapter(
      {
        baseUrl, login, userLevel: settings.userLevel, timeoutMs: settings.timeoutMs,
        token: opts.freshToken ? null : tokenCache.get(key) ?? null,
        onToken: (token) => { if (token) tokenCache.set(key, token); else tokenCache.delete(key); },
        ...deps.client,
      },
      settings,
      orderNumberOf,
    ),
  };
}

/** Back-compat: the provider, or null. */
export function kitchenProviderFor(
  deps: Pick<KitchenDeps, 'env' | 'client'>,
  integration: Pick<VendorIntegration, 'id' | 'provider'>,
  orderNumberOf: (order: KitchenOrder) => string = () => '',
): KitchenIntegrationProvider | null {
  const answer = kitchenProvider(deps, integration, orderNumberOf);
  return answer.ok ? answer.provider : null;
}

/** Operator words for a failure: never a credential, a body or a customer detail (messages are built that way). */
const problemOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

let verifier: StoreRoleVerifier | undefined;
async function storeVerifier(deps: KitchenDeps): Promise<StoreRoleVerifier> {
  if (!verifier) {
    const [{ VerificationService }, { getKycProvider }, { NotificationService }] = await Promise.all([
      import('../verification/verification.service'),
      import('../../providers/kyc/kyc-provider'),
      import('../notification/notification.service'),
    ]);
    verifier = new VerificationService(deps.prisma, new NotificationService(deps.prisma, deps.io), getKycProvider());
  }
  return verifier;
}

/** [review A S2-3] The store's own gate (vendor-operate.ts, THE predicate): words for a refusal, or null. */
async function storeRefusal(deps: KitchenDeps, vendorId: string, work: 'NEW' | 'IN_FLIGHT'): Promise<string | null> {
  const refusal = await vendorOperateRefusal(deps.prisma, await storeVerifier(deps), vendorId, work);
  return refusal ? `the store may not ${work === 'NEW' ? 'take new orders' : 'move orders'} now (${refusal.why})` : null;
}

// ---------------------------------------------------------------------------
// Building the KitchenOrder
// ---------------------------------------------------------------------------

type BuildResult = { ok: true; order: KitchenOrder; orderNumber: string } | { ok: false; reason: string };

/** [MENU-OPTIONS · delta review S3-N2] The menu option an order's choice came from, for its kitchen number: by the
 *  snapshot's option id (stable across library edits and renames), else by its plain group and choice names, else by
 *  the order's words (rows written before the snapshot kept ids). Never by display words alone: "Pepperoni (left half)"
 *  or "Cheese (Stuffed crust)" name no menu option, and a mapped half or follow-up would be refused as unmapped. */
export function kitchenOptionFor<O extends { id: string; name: string }>(
  groups: ReadonlyArray<{ name: string; options: readonly O[] }>,
  choice: { optionId?: string | null; optionGroupName: string; optionName: string; plainGroupName?: string | null; plainOptionName?: string | null },
): O | undefined {
  if (choice.optionId) {
    for (const g of groups) {
      const hit = g.options.find((o) => o.id === choice.optionId);
      if (hit) return hit;
    }
  }
  const byWords = (group: string, name: string) => groups.find((g) => g.name === group)?.options.find((o) => o.name === name);
  if (choice.plainGroupName && choice.plainOptionName) {
    const hit = byWords(choice.plainGroupName, choice.plainOptionName);
    if (hit) return hit;
  }
  return byWords(choice.optionGroupName, choice.optionName);
}

/** The order as the kitchen needs it, or why it cannot be sent (an unmapped line names how many, not which). */
export async function buildKitchenOrder(
  prisma: PrismaClient,
  sync: { orderId: string; externalOrderId: number; dailyNo: number },
  storeNo: number,
  /** A cancel names every line the kitchen was given: no line is left out and an open question blocks nothing. */
  opts: { forCancel?: boolean } = {},
): Promise<BuildResult> {
  const order = await prisma.order.findUnique({
    where: { id: sync.orderId },
    select: {
      orderNumber: true, placedAt: true, fulfillment: true, paymentMethod: true,
      totalAmount: true, subtotalCustomer: true,
      deliveryAddress: true, deliveryLat: true, deliveryLng: true, deliveryInstructions: true,
      customer: { select: { firstName: true, phone: true } },
      items: {
        select: {
          itemId: true, name: true, quantity: true, specialInstructions: true, subStatus: true,
          // [MENU-OPTIONS · delta review S3-N2] The snapshot's stable keys: the menu option it came from, its plain words
          // (the display words carry "(left half)" / the opener) and where it sits on the item.
          selectedOptions: { select: {
            optionId: true, optionGroupName: true, optionName: true, plainGroupName: true, plainOptionName: true,
            placement: true, parentOptionName: true, setsPrice: true,
          } },
        },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!order) return { ok: false, reason: 'the order is gone' };
  // An open out-of-stock question waits for the customer on the tablet; a refunded or refused line is not made.
  if (!opts.forCancel && order.items.some((l) => l.subStatus === 'PENDING')) return { ok: false, reason: 'an out-of-stock question is open' };
  const lines = opts.forCancel ? order.items : order.items.filter((l) => l.subStatus !== 'REFUNDED' && l.subStatus !== 'REJECTED');
  if (lines.length === 0) return { ok: false, reason: 'the order has no lines' };
  const catalogue = await prisma.item.findMany({
    where: { id: { in: lines.map((l) => l.itemId) } },
    select: {
      id: true, externalItemNo: true,
      optionGroups: { select: { name: true, options: { select: { id: true, name: true, externalItemNo: true } } } },
    },
  });
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  let unmapped = 0;
  const kitchenLines = lines.map((line) => {
    const item = byId.get(line.itemId);
    const itemNo = item?.externalItemNo?.trim() ?? '';
    if (!itemNo) unmapped += 1;
    const modifiers = kitchenModifiers(line.selectedOptions);
    const choices = line.selectedOptions.map((choice, k) => {
      const option = kitchenOptionFor(item?.optionGroups ?? [], choice);
      const no = option?.externalItemNo?.trim() ?? '';
      if (!no) unmapped += 1;
      return { itemNo: no, name: choice.optionName, placement: modifiers[k]!.placement };
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
          // [review A S2-2 · OWNER RULING 12 Nov 2026] A delivery carries the first name (never the last name), the
          // customer's phone and the address/location: the store's own driver must reach the customer. A deliberate
          // exception to the O-1 counterpart-phone masking (calls/counterpart-phone.ts), for this kitchen path only,
          // cash orders only (MMG keeps ringing the tablet). A pickup carries the first name only.
          firstName: order.customer.firstName,
          phone: order.customer.phone,
          address: order.deliveryAddress, lat: order.deliveryLat, lng: order.deliveryLng,
        }
        : { firstName: order.customer.firstName, phone: null, address: null, lat: null, lng: null },
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
export async function ringStoreForOrder(deps: Pick<KitchenDeps, 'prisma' | 'io'>, orderId: string): Promise<boolean> {
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
      // [delta review S3-3 · #2487] The store's goods amount, exactly as the release path passes it: never the
      // customer's whole total.
      const { loadStoreMoney } = await import('../billing/store-money');
      const storeMoney = (await loadStoreMoney(prisma, order.id).catch(() => null)) ?? Number(order.subtotalCustomer);
      await new NotificationService(prisma, io).newOrderForVendor(
        owner.userId, order.orderNumber, order.items.length, storeMoney, order.id,
        vendorRespondBy(order, { slaMinutes, holdMs: holdWindowMs() ?? 0 }),
      );
    }
  } catch (err) {
    log().error({ err, orderId }, '[KITCHEN] tablet ring after a kitchen fallback failed — the board and the alert ladder still show the order');
  }
  return true;
}

/** Tell operations once per (order, problem). Never throws. */
async function pageOperations(deps: Pick<KitchenDeps, 'prisma' | 'io'>, input: { orderId: string; tenantId: string | null; key: string; title: string; body: string }) {
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

async function noteIntegrationError(deps: Pick<KitchenDeps, 'prisma'>, integrationId: string, problem: string) {
  await deps.prisma.vendorIntegration.update({
    where: { id: integrationId },
    data: { lastError: problem.slice(0, 300), lastErrorAt: new Date() },
  }).catch(() => undefined);
}

const orderNumberOf = async (deps: Pick<KitchenDeps, 'prisma'>, orderId: string) =>
  (await deps.prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } }))?.orderNumber ?? orderId;

// ---------------------------------------------------------------------------
// OUTBOUND
// ---------------------------------------------------------------------------

type SyncRef = { id: string; orderId: string; tenantId: string; vendorIntegrationId: string };

/** Only rows still waiting for a sender (or one whose lease lapsed) may be moved by a sweeper; a sender moves its
 *  own SENDING row. The compare-and-set is on the state the caller READ, so a sweeper never takes a row a sender
 *  leased a moment later (the kitchen would have it AND the tablet would ring). */
type FromState =
  | { from: 'QUEUED' }
  | { from: 'SENDING'; lapsedOnly?: boolean }
  | { from: 'UNKNOWN' }
  | { from: 'CANCELLING'; lapsedOnly?: boolean };

const fromWhere = (from: FromState, now: Date) => ({
  state: from.from,
  ...((from.from === 'SENDING' || from.from === 'CANCELLING') && from.lapsedOnly ? { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] } : {}),
});

/**
 * The kitchen does NOT have the order (never sent, refused, or — from UNKNOWN — told to cancel it): ring the store's
 * tablet, tell operations. Leaves the expected state exactly once; false when another hand moved the row first.
 */
/** What the operations page says: the kitchen does not have it (default), it was cancelled there after an
 *  unanswered send, or — the switch being off — it MAY also be in the kitchen. */
type FallbackPage = 'default' | 'cancelled-there' | 'maybe-in-kitchen-switch-off'
  /** [DT-OUTAGE] The branch's LINK failed (certainly not received) or is offline: no page per order; the breaker
   *  sends one alert per outage, and the console shows the connection's last error. */
  | 'link';

async function fallBack(
  deps: Pick<KitchenDeps, 'prisma' | 'io'>,
  sync: SyncRef,
  reason: string,
  from: FromState,
  page: FallbackPage = 'default',
): Promise<boolean> {
  const now = new Date();
  const moved = await deps.prisma.orderIntegrationSync.updateMany({
    where: { id: sync.id, ...fromWhere(from, now) },
    data: { state: 'FALLBACK', fallbackAt: now, lastError: reason.slice(0, 300), leaseUntil: null },
  });
  if (moved.count === 0) return false;
  await noteIntegrationError(deps, sync.vendorIntegrationId, reason);
  const rang = await ringStoreForOrder(deps, sync.orderId);
  log().warn({ orderId: sync.orderId, reason }, '[KITCHEN] order not given to the kitchen system — the store tablet was rung instead');
  if (page === 'link') return true;
  const number = await orderNumberOf(deps, sync.orderId);
  await pageOperations(deps, {
    orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:fallback`,
    title: page === 'cancelled-there' ? 'Kitchen system: order cancelled there, rang the tablet'
      : page === 'maybe-in-kitchen-switch-off' ? 'Kitchen system OFF: CALL THE STORE — order on the tablet, may also be in the kitchen'
        : 'Kitchen system: order rang the tablet instead',
    body: page === 'cancelled-there'
      ? `Order ${number}: the kitchen system showed no sign of it after its send got no answer, and it was told to cancel it (${reason}). ${rang ? "The store's Swift tablet was rung; check the store makes it once." : 'The order no longer waits for the store.'}`
      : page === 'maybe-in-kitchen-switch-off'
        ? `Order ${number}: the kitchen-system switch is off and this order's send got no answer (${reason}), so the store's kitchen system MAY also have it. ${rang ? "It is now on the store's Swift tablet." : 'The order no longer waits for the store.'} Call the store so it is made once: if the kitchen has it, make it there and accept it on the tablet; if not, make it from the tablet.`
        : `Order ${number} could not go to the store's kitchen system (${reason}). ${rang ? "The store's Swift tablet was rung; check the store answers it." : 'The order no longer waits for the store.'}`,
  });
  return true;
}

/**
 * [review B S3-3 · A S3-1] A send whose answer never came (a write that timed out, or a sender that died holding the
 * row): the kitchen MAY have the order. It is never re-sent and the tablet is NOT rung (the store would make it
 * twice). Operations are paged now; the kitchen's own events or its order-updates row confirm it (-> SENT), a Swift
 * cancel reaches the kitchen (-> CANCEL_QUEUED), and past KITCHEN_VERIFY_MS with no sign of it Swift cancels it
 * there and, once that goes through, rings the tablet (resolveUnknownKitchenSyncs).
 */
async function markUnknown(deps: Pick<KitchenDeps, 'prisma' | 'io'>, sync: SyncRef, reason: string, from: FromState): Promise<boolean> {
  const now = new Date();
  const moved = await deps.prisma.orderIntegrationSync.updateMany({
    where: { id: sync.id, ...fromWhere(from, now) },
    data: { state: 'UNKNOWN', leaseUntil: new Date(now.getTime() + KITCHEN_VERIFY_MS), attempts: 0, lastError: reason.slice(0, 300) },
  });
  if (moved.count === 0) return false;
  await noteIntegrationError(deps, sync.vendorIntegrationId, reason);
  log().warn({ orderId: sync.orderId, reason }, '[KITCHEN] the kitchen system may have the order — not re-sent, not rung; operations paged');
  await pageOperations(deps, {
    orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:unknown`,
    title: 'Kitchen system: order MAY be in the kitchen (tablet not rung)',
    body: `Order ${await orderNumberOf(deps, sync.orderId)}: the send to the store's kitchen system got no answer (${reason}), so the kitchen may have it. Swift did NOT ring the tablet (so it is made once) and is watching the kitchen's order updates for ${Math.round(KITCHEN_VERIFY_MS / 1000)} s: if the kitchen shows it, it carries on as sent; if not, Swift cancels it there and then rings the tablet. Check the store's kitchen screen now.`,
  });
  return true;
}

/** [review B S2-1c] In INSERT_OK mode a sent order is accepted on the store's behalf; when that accept is refused
 *  the tablet rings at once (never left to auto-cancel while the kitchen cooks it). Only for an order still PENDING. */
async function acceptSentOrder(deps: KitchenDeps, sync: { id: string; tenantId: string; orderId: string }, promiseSeconds: number | null): Promise<void> {
  if (dragontailSettings(envOf(deps)).acceptOn !== 'INSERT_OK') return;
  const order = await deps.prisma.order.findUnique({ where: { id: sync.orderId }, select: { status: true, vendorId: true, orderNumber: true } });
  if (order?.status !== 'PENDING') return;
  // [security scan · d68ff3f6] Accepting is the store's NEW work: its own gate first, exactly as its Accept button.
  // A store that may not take new orders now is never accepted for: the order stays SENT and unaccepted, the
  // tablet is rung (where the store's own refusal applies) and operations are told the kitchen has it.
  const refused = order.vendorId ? await storeRefusal(deps, order.vendorId, 'NEW') : 'the order has no store';
  if (refused) {
    const marked = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'SENT', fallbackAt: null },
      data: { fallbackAt: new Date(), lastError: `not accepted: ${refused}`.slice(0, 300) },
    });
    if (marked.count === 0) return;
    await ringStoreForOrder(deps, sync.orderId);
    await pageOperations(deps, {
      orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:held-accept`,
      title: 'Kitchen system: order in the kitchen, store may not take it',
      body: `Order ${order.orderNumber} is in the store's kitchen system, but ${refused}, so Swift did not accept it. Call the store: it should not make or send it unless the hold is lifted; cancel it on Swift if it will not.`,
    });
    return;
  }
  const accepted = await runWithTenant(sync.tenantId, () => acceptForKitchen(deps, sync.orderId, promiseSeconds));
  if (!accepted) await ringStuckKitchenClaim(deps, sync.orderId);
}

/** An UNKNOWN sync the kitchen showed it has (an event, or its row in the order updates): it is SENT after all. */
async function confirmLanded(deps: KitchenDeps, sync: SyncRef & { promiseSeconds: number | null }, how: string): Promise<boolean> {
  const moved = await deps.prisma.orderIntegrationSync.updateMany({
    where: { id: sync.id, state: 'UNKNOWN' },
    data: { state: 'SENT', sentAt: nowOf(deps), leaseUntil: null, lastError: null },
  });
  if (moved.count === 0) return false;
  log().info({ orderId: sync.orderId, how }, '[KITCHEN] the kitchen system has the order after all — carried on as sent');
  await pageOperations(deps, {
    orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:landed`,
    title: 'Kitchen system: the unanswered order IS in the kitchen',
    body: `Order ${await orderNumberOf(deps, sync.orderId)}: the store's kitchen system has it (${how}). Swift carries on as sent; the tablet was not rung.`,
  });
  await acceptSentOrder(deps, sync, sync.promiseSeconds);
  return true;
}

/** [review B S2-1] A claim found stuck (switch off, sender not running, accept refused, no kitchen action in time):
 *  ring the tablet and tell operations — or, for a send whose lease lapsed, mark it UNKNOWN (it may have landed).
 *  Idempotent; true when it moved the claim. */
export async function ringStuckKitchenClaim(deps: Pick<KitchenDeps, 'prisma' | 'io' | 'env'>, orderId: string): Promise<boolean> {
  const sync = await deps.prisma.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } } });
  if (!sync || sync.fallbackAt) return false;
  const on = dragontailIntegrationEnabled(deps.env ?? process.env);
  if (sync.state === 'QUEUED') {
    // [delta review S4-4] An order that no longer waits (cancelled, or answered on the tablet) is settled quietly,
    // as the sender does: nothing to ring, nobody to page.
    const order = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (order && order.status !== 'PENDING') {
      const settled = await deps.prisma.orderIntegrationSync.updateMany({
        where: { id: sync.id, state: 'QUEUED' },
        data: { state: order.status === 'CANCELLED' ? 'DONE' : 'FALLBACK', leaseUntil: null, lastError: `not sent: the order was ${order.status} first` },
      });
      return settled.count > 0;
    }
    return fallBack(deps, sync, 'the order was never sent (the sender is not running, or the switch is off)', { from: 'QUEUED' });
  }
  if (sync.state === 'SENDING') {
    // A SENDING row is only stuck once its lease (and so its send's deadline) is gone; whether it landed is unknown.
    if (sync.leaseUntil && sync.leaseUntil > new Date()) return false;
    // [delta review S2-1] With the switch OFF nothing would ever settle an UNKNOWN: the tablet rings now and
    // operations call the store so it is made once (a restart that killed the sender is the usual way here).
    if (!on) return fallBack(deps, sync, 'a sender stopped mid-send', { from: 'SENDING', lapsedOnly: true }, 'maybe-in-kitchen-switch-off');
    return markUnknown(deps, sync, 'a sender stopped mid-send', { from: 'SENDING', lapsedOnly: true });
  }
  if ((sync.state === 'UNKNOWN' || sync.state === 'CANCELLING') && !on) {
    // [delta review S2-1] Switch OFF: no verify, no cancel will happen. Ring the tablet; operations call the store.
    if (sync.state === 'CANCELLING' && sync.leaseUntil && sync.leaseUntil > new Date()) return false;
    const order = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (order?.status !== 'PENDING') return false;
    return fallBack(deps, sync, sync.lastError ?? 'its send got no answer', sync.state === 'UNKNOWN' ? { from: 'UNKNOWN' } : { from: 'CANCELLING', lapsedOnly: true }, 'maybe-in-kitchen-switch-off');
  }
  if (sync.state === 'SENT') {
    const marked = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'SENT', fallbackAt: null, order: { status: 'PENDING' } },
      data: { fallbackAt: new Date(), lastError: 'the kitchen has the order but it was not accepted in time; the tablet was rung' },
    });
    if (marked.count === 0) return false;
    const rang = await ringStoreForOrder(deps, orderId);
    await pageOperations(deps, {
      orderId, tenantId: sync.tenantId, key: `${sync.id}:unaccepted`,
      title: 'Kitchen system: order in the kitchen but not accepted',
      body: `Order ${await orderNumberOf(deps, orderId)} is in the store's kitchen system but was not accepted on Swift. ${rang ? "The store's Swift tablet was rung: the store should accept it there (the kitchen already has it, so it is made once)." : ''}`,
    });
    return true;
  }
  return false;
}

/** The ladder's kitchen check: 'WAIT' (re-arm the rung), 'RANG' (the tablet was just rung: re-arm, the next rung
 *  escalates as for any store), or 'GO' (no claim: escalate now). Never throws. */
export async function kitchenLadderStep(deps: Pick<KitchenDeps, 'prisma' | 'io' | 'env'>, orderId: string): Promise<'WAIT' | 'RANG' | 'GO'> {
  try {
    const decision = await kitchenLadderDecision(deps.prisma, orderId, new Date(), deps.env ?? process.env);
    if (decision === 'WAIT') return 'WAIT';
    if (decision === 'RING') {
      await ringStuckKitchenClaim(deps, orderId);
      // Whatever moved it: rung (fell back, or a sent order rung for its accept) -> RANG; still with the kitchen
      // (a send inside its lease, or UNKNOWN) -> WAIT; anything else -> GO. Never stop the ladder with nothing rung.
      const sync = await deps.prisma.orderIntegrationSync.findUnique({ where: { orderId_provider: { orderId, provider: 'DRAGONTAIL' } }, select: { state: true, fallbackAt: true } });
      if (sync?.fallbackAt) return 'RANG';
      return sync && (sync.state === 'QUEUED' || sync.state === 'SENDING' || sync.state === 'UNKNOWN' || sync.state === 'CANCELLING') ? 'WAIT' : 'GO';
    }
    return 'GO';
  } catch (err) {
    log().error({ err, orderId }, '[KITCHEN] ladder check failed; the ladder carries on');
    return 'GO';
  }
}

/** Accept the order on the store's behalf: PENDING → ACCEPTED → PREPARING, own delivery bound in the same commit. */
export async function acceptForKitchen(deps: KitchenDeps, orderId: string, promiseSeconds: number | null): Promise<boolean> {
  void promiseSeconds; // kept on the sync row only: the spec's promise time is a door time for deliveries (TODO-CONFIRM)
  const { OrderService, preparationMayStart, releaseLapsedHoldInTransaction } = await import('../order/order.service');
  const orders = new OrderService(deps.prisma, deps.io, undefined, undefined, deps.redis);
  try {
    await orders.updateStatus(orderId, 'ACCEPTED', KITCHEN_CHANGED_BY, "Accepted by the store's kitchen system", {
      allowedFrom: ['PENDING'],
      continueTo: { target: 'PREPARING', note: "Preparing: the store's kitchen system has the order", when: preparationMayStart },
      withinTransaction: async (tx, locked) => {
        await releaseLapsedHoldInTransaction(tx, orderId);
        // [KITCHEN-INTEGRATION] A connected store's delivery is its own driver's: bound here, in the accept's
        // commit, so no Swift rider is ever sought for it.
        if (locked.fulfillment === 'DELIVERY' && locked.fulfillmentMode !== 'VENDOR_DELIVERY' && !locked.riderId) {
          await tx.order.update({ where: { id: orderId }, data: { fulfillmentMode: 'VENDOR_DELIVERY', fulfillmentModeVersion: { increment: 1 } } });
        }
      },
    });
    return true;
  } catch (err) {
    log().warn({ err, orderId }, '[KITCHEN] accept on the kitchen system answer refused — the order stays as it is');
    return false;
  }
}

/** Everything before the insert: the order still waits, the connection is on, the store may take new work, every
 *  line has a kitchen number, and there is a login. Anything else falls back (the kitchen does not have it); null. */
async function prepareSend(
  deps: KitchenDeps,
  sync: SyncRef & { externalOrderId: number; externalStoreNo: number; dailyNo: number; vendorIntegration: VendorIntegration },
  own: FromState,
): Promise<{ order: KitchenOrder; provider: KitchenIntegrationProvider } | null> {
  const order = await deps.prisma.order.findUnique({ where: { id: sync.orderId }, select: { status: true, vendorId: true } });
  if (!order || order.status !== 'PENDING') {
    // Cancelled (or answered on the tablet) before it was sent: nothing goes to the kitchen.
    await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'SENDING' },
      data: { state: order?.status === 'CANCELLED' ? 'DONE' : 'FALLBACK', leaseUntil: null, lastError: `not sent: the order was ${order?.status ?? 'gone'} first` },
    });
    return null;
  }
  const integration = sync.vendorIntegration;
  if (!integration.enabled || integration.externalStoreNo == null) {
    await fallBack(deps, sync, 'the connection was switched off', own);
    return null;
  }
  // [DT-OUTAGE] The branch's link is offline: nothing is sent; it rings the tablet (the outage was alerted once).
  if (integration.linkOfflineAt) {
    await fallBack(deps, sync, 'the kitchen link is offline', own, 'link');
    return null;
  }
  // [security scan · d68ff3f6] The order goes to the store number it was claimed under, never a different one.
  if (integration.externalStoreNo !== sync.externalStoreNo) {
    await fallBack(deps, sync, "the connection's store number changed after the claim", own);
    return null;
  }
  // [review A S2-3] the store's own Accept gate: a held, closed or lapsed store takes no new order from the kitchen
  // either (the tablet then refuses it as usual).
  const refused = order.vendorId ? await storeRefusal(deps, order.vendorId, 'NEW') : 'the order has no store';
  if (refused) {
    await fallBack(deps, sync, refused, own);
    return null;
  }
  const built = await buildKitchenOrder(deps.prisma, sync, sync.externalStoreNo);
  if (!built.ok) {
    await fallBack(deps, sync, built.reason, own);
    return null;
  }
  const answer = kitchenProvider(deps, integration, () => built.orderNumber);
  if (!answer.ok) {
    await fallBack(deps, sync, answer.problem, own);
    return null;
  }
  return { order: built.order, provider: answer.provider };
}

/** Send one row this sender leased at `leasedAt`. Its whole send (login, insert, a re-login) must finish by
 *  leasedAt + KITCHEN_SEND_BUDGET_MS, well inside the lease, so no sweeper can take a row whose send may still land. */
async function sendOne(deps: KitchenDeps, syncId: string, leasedAt: number): Promise<void> {
  const sync = await deps.prisma.orderIntegrationSync.findUnique({ where: { id: syncId }, include: { vendorIntegration: true } });
  if (!sync || sync.state !== 'SENDING') return;
  const own: FromState = { from: 'SENDING' };
  let prepared: { order: KitchenOrder; provider: KitchenIntegrationProvider } | null;
  try {
    prepared = await prepareSend(deps, sync, own);
  } catch (err) {
    // Swift's own side failed before anything was sent: the kitchen does not have it.
    await fallBack(deps, sync, `Swift could not prepare the send (${problemOf(err)})`, own);
    return;
  }
  if (!prepared) return;
  const { provider } = prepared;
  // [review A S3-1 · B S3-1] ONE deadline for the whole send, counted from this row's lease, well inside it.
  provider.setDeadline(leasedAt + KITCHEN_SEND_BUDGET_MS);
  let inserted: KitchenInsertResult;
  try {
    inserted = await provider.insertOrder(prepared.order);
  } catch (err) {
    if (err instanceof KitchenTransientError && err.mayHaveLanded) {
      // [review B S3-3] It may be in the kitchen: never re-sent, never rung while unknown; verified, then settled.
      await markUnknown(deps, sync, problemOf(err), own);
      return;
    }
    // [DT-OUTAGE] CERTAINLY not received and the LINK failed (no connection, a 5xx after the spec's retries, no
    // attempt fitted the deadline, a login refused): the tablet rings now, no page per order; the branch's breaker
    // counts it. An order-specific refusal (validation) is not a link failure: rung, and operations paged, as before.
    const linkFailure = err instanceof KitchenTransientError || (err instanceof KitchenPermanentError && err.linkFailure);
    await fallBack(deps, sync, problemOf(err), own, linkFailure ? 'link' : 'default');
    if (linkFailure) await recordLinkFailure(deps, sync.vendorIntegrationId, problemOf(err), envOf(deps));
    return;
  } finally {
    provider.setDeadline(null);
  }
  // The kitchen HAS it. Nothing below may ring the tablet for a failure of Swift's own: a row left SENDING by a
  // database hiccup lapses to UNKNOWN and is confirmed by the kitchen's own events.
  try {
    // SENDING, or UNKNOWN if a sweeper already gave up on an answer that has now come: either way it is SENT.
    const sent = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: { in: ['SENDING', 'UNKNOWN'] } },
      data: {
        state: 'SENT', sentAt: nowOf(deps), leaseUntil: null, lastError: null,
        updateStamp: inserted.updateStamp, promiseSeconds: inserted.promiseSeconds,
      },
    });
    // [DT-OUTAGE] The link works: the breaker's count restarts (and an offline link would close).
    await recordLinkSuccess(deps, sync.vendorIntegrationId);
    if (sent.count === 0) return;
    await deps.prisma.vendorIntegration.update({ where: { id: sync.vendorIntegrationId }, data: { lastHealthyAt: nowOf(deps) } }).catch(() => undefined);
    await acceptSentOrder(deps, sync, inserted.promiseSeconds);
  } catch (err) {
    log().error({ err, syncId: sync.id }, '[KITCHEN] the kitchen took the order but Swift could not record it; its events will confirm it');
  }
}

/** A tick's parts stop taking new work at this moment (each piece of work is bounded by its own deadline). */
export interface KitchenWorkWindow {
  /** ms since epoch; absent = KITCHEN_TICK_BUDGET_MS from the call. */
  until?: number;
}
const untilOf = (w: KitchenWorkWindow) => w.until ?? Date.now() + KITCHEN_TICK_BUDGET_MS;

/**
 * Drain QUEUED rows (and SENDING rows whose lease lapsed: a crashed sender). Each row is leased by compare-and-set,
 * its lease counted from THAT moment, before anything is sent; the loop stops taking rows once its window closes.
 * Returns the ids sent, fallen back or marked unknown.
 */
export async function drainKitchenSyncs(deps: KitchenDeps, opts: { orderIds?: string[]; batch?: number } & KitchenWorkWindow = {}): Promise<string[]> {
  if (!dragontailIntegrationEnabled(envOf(deps))) return [];
  const until = untilOf(opts);
  const due = await deps.prisma.orderIntegrationSync.findMany({
    where: {
      ...(opts.orderIds ? { orderId: { in: opts.orderIds } } : {}),
      OR: [{ state: 'QUEUED' }, { state: 'SENDING', leaseUntil: { lt: new Date() } }],
    },
    select: { id: true, state: true, orderId: true, tenantId: true, vendorIntegrationId: true },
    orderBy: { createdAt: 'asc' },
    take: opts.batch ?? 20,
  });
  const handled: string[] = [];
  for (const row of due) {
    if (Date.now() >= until) break;
    if (row.state === 'SENDING') {
      // A sender died holding this row: whether the kitchen got it is unknown, so it is never re-sent blind.
      if (await markUnknown(deps, row, 'a sender stopped mid-send', { from: 'SENDING', lapsedOnly: true })) handled.push(row.id);
      continue;
    }
    const leasedAt = Date.now();
    const leased = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: row.id, state: 'QUEUED' },
      data: { state: 'SENDING', leaseUntil: new Date(leasedAt + KITCHEN_LEASE_MS), attempts: { increment: 1 } },
    });
    if (leased.count === 0) continue;
    try {
      await sendOne(deps, row.id, leasedAt);
    } catch (err) {
      // Something on Swift's side broke before or around the send: if it never reached the kitchen it falls back;
      // a row the send may have reached is left SENDING for the lapsed-lease path (-> UNKNOWN), never rung.
      log().error({ err, syncId: row.id }, '[KITCHEN] send failed unexpectedly');
    }
    handled.push(row.id);
  }
  return handled;
}

/** Statuses after which the kitchen is owed nothing more (cancellation aside). */
const FINISHED_STATUSES = ['DELIVERED', 'COMPLETED', 'FAILED', 'RETURNED', 'REFUNDED'] as const;

/** A sent (or maybe-sent) order the Swift side cancelled: tell the kitchen. Retried each tick; operations told when
 *  it keeps failing. */
export async function propagateKitchenCancellations(deps: KitchenDeps, opts: { batch?: number } & KitchenWorkWindow = {}): Promise<number> {
  if (!dragontailIntegrationEnabled(envOf(deps))) return 0;
  const until = untilOf(opts);
  // CANCELLED only: a refund after delivery is not a cancel (the driver's cash-out must not see one). An UNKNOWN
  // order is told too: harmless if the kitchen never had it, and it must not make it if it did.
  await deps.prisma.orderIntegrationSync.updateMany({
    where: { state: { in: ['SENT', 'UNKNOWN'] }, order: { status: 'CANCELLED' } },
    data: { state: 'CANCEL_QUEUED', attempts: 0, leaseUntil: null },
  });
  // Finished orders owe the kitchen nothing more.
  await deps.prisma.orderIntegrationSync.updateMany({
    where: { state: { in: ['SENT', 'UNKNOWN'] }, order: { status: { in: [...FINISHED_STATUSES] } } },
    data: { state: 'DONE', leaseUntil: null },
  });
  const due = await deps.prisma.orderIntegrationSync.findMany({
    where: { state: 'CANCEL_QUEUED', attempts: { lt: MAX_CANCEL_ATTEMPTS } },
    include: { vendorIntegration: true },
    take: opts.batch ?? 20,
  });
  let told = 0;
  for (const sync of due) {
    if (Date.now() >= until) break;
    const leased = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'CANCEL_QUEUED', attempts: sync.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (leased.count === 0) continue;
    const outcome = await cancelAtKitchen(deps, sync);
    if (outcome.ok) {
      await deps.prisma.orderIntegrationSync.updateMany({
        where: { id: sync.id, state: 'CANCEL_QUEUED' },
        data: { state: 'CANCELLED', cancelledAt: nowOf(deps), lastError: null },
      });
      told += 1;
      continue;
    }
    await deps.prisma.orderIntegrationSync.update({ where: { id: sync.id }, data: { lastError: outcome.problem } });
    if (sync.attempts + 1 >= MAX_CANCEL_ATTEMPTS) {
      await pageOperations(deps, {
        orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:cancel`,
        title: 'Kitchen system: a cancellation did not reach the kitchen',
        body: `Order ${await orderNumberOf(deps, sync.orderId)} was cancelled on Swift but the store's kitchen system was not told (${outcome.problem}). Call the store so it does not make or send it.`,
      });
    }
  }
  return told;
}

/** One cancel at the kitchen, within its own deadline. Never throws. */
async function cancelAtKitchen(
  deps: KitchenDeps,
  sync: { orderId: string; externalOrderId: number; externalStoreNo: number; dailyNo: number; vendorIntegration: VendorIntegration },
): Promise<{ ok: true } | { ok: false; problem: string }> {
  // [security scan · d68ff3f6] The store number the order was claimed (and sent) under, never the connection's current one.
  const storeNo = sync.externalStoreNo;
  const built = await buildKitchenOrder(deps.prisma, sync, storeNo, { forCancel: true });
  if (!built.ok) return { ok: false, problem: built.reason };
  const answer = kitchenProvider(deps, sync.vendorIntegration, () => built.orderNumber);
  if (!answer.ok) return { ok: false, problem: answer.problem };
  answer.provider.setDeadline(Date.now() + KITCHEN_CANCEL_BUDGET_MS);
  try {
    await answer.provider.cancelOrder(built.order);
    return { ok: true };
  } catch (err) {
    return { ok: false, problem: problemOf(err) };
  } finally {
    answer.provider.setDeadline(null);
  }
}

/**
 * [review B S3-3] Settle UNKNOWN sends whose verify window passed with no sign of the order at the kitchen: still
 * PENDING -> cancel it there; once that goes through, the tablet rings (-> FALLBACK). A cancel that does not go
 * through leaves it UNKNOWN (tried again shortly; operations paged to call the store), never rung while the kitchen
 * may be making it. A store that took it on the tablet meanwhile: operations check it is made once.
 * [delta review S3-1] While its cancel is in flight the row is CANCELLING, which no kitchen event can confirm (and so
 * accept); a CANCELLING row left by a process that died mid-cancel is picked up again once its lease lapses.
 */
export async function resolveUnknownKitchenSyncs(deps: KitchenDeps, opts: KitchenWorkWindow = {}): Promise<number> {
  if (!dragontailIntegrationEnabled(envOf(deps))) return 0;
  const until = untilOf(opts);
  const now = nowOf(deps);
  const due = await deps.prisma.orderIntegrationSync.findMany({
    where: { state: { in: ['UNKNOWN', 'CANCELLING'] }, leaseUntil: { lt: now } },
    include: { vendorIntegration: true },
    orderBy: { leaseUntil: 'asc' },
    take: 20,
  });
  let settled = 0;
  for (const sync of due) {
    if (Date.now() >= until) break;
    const order = await deps.prisma.order.findUnique({ where: { id: sync.orderId }, select: { status: true, orderNumber: true } });
    if (!order) continue;
    if (order.status !== 'PENDING') {
      // Cancelled orders go through propagateKitchenCancellations, finished ones to DONE (back to UNKNOWN for both).
      // Any other: the store took it on the tablet while its kitchen may also have it. Operations check it is made
      // once; nothing is retried.
      const leftAlone = order.status === 'CANCELLED' || (FINISHED_STATUSES as readonly string[]).includes(order.status);
      const parked = await deps.prisma.orderIntegrationSync.updateMany({
        where: { id: sync.id, state: sync.state, leaseUntil: sync.leaseUntil },
        data: { state: 'UNKNOWN', leaseUntil: leftAlone ? new Date(Date.now() + KITCHEN_UNKNOWN_RETRY_MS) : null },
      });
      if (parked.count === 0 || leftAlone) continue;
      await pageOperations(deps, {
        orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:unknown-taken`,
        title: 'Kitchen system: order taken on the tablet; the kitchen may also have it',
        body: `Order ${order.orderNumber}: the store took it on the Swift tablet, but its kitchen system may also have it (its send got no answer). Call the store so it is made once.`,
      });
      continue;
    }
    // Take the row out of UNKNOWN for the whole cancel: a kitchen confirmation racing it cannot accept the order.
    const leased = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: sync.state, leaseUntil: sync.leaseUntil },
      data: { state: 'CANCELLING', leaseUntil: new Date(Date.now() + KITCHEN_CANCEL_BUDGET_MS + KITCHEN_UNKNOWN_RETRY_MS), attempts: { increment: 1 } },
    });
    if (leased.count === 0) continue;
    const outcome = await cancelAtKitchen(deps, sync);
    if (outcome.ok) {
      if (await fallBack(deps, sync, 'the send got no answer and the kitchen showed no sign of it; it was told to cancel it', { from: 'CANCELLING' }, 'cancelled-there')) {
        settled += 1;
      } else {
        // The kitchen cancelled it, but the row was moved meanwhile (by hand, or a sweeper): never drop it silently.
        await pageOperations(deps, {
          orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:cancelled-but-moved`,
          title: 'Kitchen system: CALL THE STORE — cancelled in the kitchen, but Swift moved the order on',
          body: `Order ${order.orderNumber}: Swift cancelled it in the store's kitchen system (its send had got no answer), but the order was moved on in Swift meanwhile. Call the store so it is made (once) from the Swift tablet, or cancel it on Swift.`,
        });
      }
      continue;
    }
    await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: sync.id, state: 'CANCELLING' },
      data: { state: 'UNKNOWN', leaseUntil: new Date(Date.now() + KITCHEN_UNKNOWN_RETRY_MS), lastError: `cancel at the kitchen did not go through: ${outcome.problem}`.slice(0, 300) },
    });
    await pageOperations(deps, {
      orderId: sync.orderId, tenantId: sync.tenantId, key: `${sync.id}:unknown-cancel`,
      title: 'Kitchen system: CALL THE STORE — order may be in the kitchen, cancel failed',
      body: `Order ${order.orderNumber}: Swift cannot tell whether the store's kitchen system has it, and could not cancel it there (${outcome.problem}). The tablet was NOT rung. Call the store: if the kitchen has it, it makes it there; if not, the store accepts it on the Swift tablet. Swift keeps trying the cancel.`,
    });
  }
  return settled;
}

/** Marks a sync whose Swift cancel operations were already told the kitchen never heard (switch off). */
const UNTOLD_CANCEL = 'switch off: the kitchen system was not told of the cancel';

/**
 * [delta review S2-1] Switch OFF: a Swift-cancelled order the kitchen may still hold (SENT, UNKNOWN, CANCEL_QUEUED)
 * is never told to the kitchen (no call leaves Swift). Operations are paged ONCE per order to call the store; the
 * row waits as CANCEL_QUEUED, so the kitchen is told when the switch is back on.
 */
async function pageUntoldKitchenCancels(deps: Pick<KitchenDeps, 'prisma' | 'io'>): Promise<void> {
  const rows = await deps.prisma.orderIntegrationSync.findMany({
    where: {
      state: { in: ['SENT', 'UNKNOWN', 'CANCEL_QUEUED'] },
      order: { status: 'CANCELLED' },
      OR: [{ lastError: null }, { lastError: { not: UNTOLD_CANCEL } }],
    },
    select: { id: true, orderId: true, tenantId: true, state: true },
    take: 50,
  });
  for (const row of rows) {
    const marked = await deps.prisma.orderIntegrationSync.updateMany({
      where: { id: row.id, state: row.state, OR: [{ lastError: null }, { lastError: { not: UNTOLD_CANCEL } }] },
      data: { state: 'CANCEL_QUEUED', lastError: UNTOLD_CANCEL, leaseUntil: null, ...(row.state === 'CANCEL_QUEUED' ? {} : { attempts: 0 }) },
    });
    if (marked.count === 0) continue;
    await runWithTenant(row.tenantId, async () => pageOperations(deps, {
      orderId: row.orderId, tenantId: row.tenantId, key: `${row.id}:untold-cancel`,
      title: 'Kitchen system OFF: CALL THE STORE — a cancelled order may still be in its kitchen',
      body: `Order ${await orderNumberOf(deps, row.orderId)} was cancelled on Swift, but the kitchen-system switch is off, so the store's kitchen system was not told. Call the store so it does not make or send it. (The kitchen is told when the switch is back on.)`,
    }));
  }
}

/**
 * [review B S2-1] THE TABLET BACKSTOP SWEEP, switch on or off (run by the hold-release job as well as the tick; it
 * makes no outside call): rings the tablet for every claim left waiting when the switch is off, for a claim stuck
 * past KITCHEN_STUCK_MS while it is on, and for a sent order still not accepted past its time; a send whose lease
 * lapsed becomes UNKNOWN (never rung). One indexed read when nothing is stuck. The ladder does the same per order.
 */
export async function kitchenBackstopSweep(deps: Pick<KitchenDeps, 'prisma' | 'io' | 'env' | 'now'>): Promise<number> {
  const env = deps.env ?? process.env;
  const on = dragontailIntegrationEnabled(env);
  const now = (deps.now ? deps.now() : new Date()).getTime();
  const { acceptOn, ackTimeoutMs } = dragontailSettings(env);
  const waitMs = on && acceptOn === 'KITCHEN_ACTION' ? ackTimeoutMs : KITCHEN_ACCEPT_GRACE_MS;
  const stale = await deps.prisma.orderIntegrationSync.findMany({
    where: {
      fallbackAt: null,
      OR: [
        { state: 'QUEUED', ...(on ? { createdAt: { lt: new Date(now - KITCHEN_STUCK_MS) } } : {}) },
        { state: 'SENDING', leaseUntil: { lt: new Date(now) } },
        { state: 'SENT', sentAt: { lt: new Date(now - waitMs) }, order: { status: 'PENDING' } },
        // [delta review S2-1] Switch OFF: an order whose send got no answer is never settled by the tick; the tablet
        // rings it and operations call the store (made once).
        ...(on ? [] : [
          { state: 'UNKNOWN' as const, order: { status: 'PENDING' as const } },
          { state: 'CANCELLING' as const, leaseUntil: { lt: new Date(now) }, order: { status: 'PENDING' as const } },
        ]),
      ],
    },
    select: { orderId: true, tenantId: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  if (!on) await pageUntoldKitchenCancels(deps);
  let moved = 0;
  for (const row of stale) {
    try {
      if (await runWithTenant(row.tenantId, () => ringStuckKitchenClaim(deps, row.orderId))) moved += 1;
    } catch (err) {
      log().error({ err, orderId: row.orderId }, '[KITCHEN] backstop ring failed; the alert ladder still rings it');
    }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// INBOUND
// ---------------------------------------------------------------------------

export type KitchenEventOutcome = 'applied' | 'unchanged' | 'unknown-order' | 'ignored';

/** Move the order one declared edge, as the kitchen system; false when the edge does not fit right now. */
async function step(deps: KitchenDeps, orderId: string, target: OrderStatus, note: string, extra?: Parameters<OrderServiceType['updateStatus']>[4]): Promise<boolean> {
  const { OrderService } = await import('../order/order.service');
  try {
    await new OrderService(deps.prisma, deps.io, undefined, undefined, deps.redis).updateStatus(orderId, target, KITCHEN_CHANGED_BY, note, extra);
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

const STATUS_STEPS = new Set(['MAKE_LINE', 'PREPARED', 'COOKED', 'PACKED', 'DISPATCHED', 'DELIVERED']);

/** Apply one kitchen event to its order. Never throws. */
export async function applyKitchenEvent(deps: KitchenDeps, integration: Pick<VendorIntegration, 'id' | 'externalStoreNo' | 'tenantId'>, event: KitchenEvent): Promise<KitchenEventOutcome> {
  try {
    // [delta review S3-2] Found by Dragontail's own key (store number, order id); it must be this connection's, and an
    // event counts only under the store number its order was claimed under [security scan · d68ff3f6].
    const sync = await deps.prisma.orderIntegrationSync.findUnique({
      where: { provider_externalStoreNo_externalOrderId: { provider: 'DRAGONTAIL', externalStoreNo: event.storeNo, externalOrderId: event.externalOrderId } },
    });
    if (!sync || sync.vendorIntegrationId !== integration.id) {
      log().info({ storeNo: event.storeNo, action: event.action }, '[KITCHEN] event for an order Swift did not send — ignored');
      return 'unknown-order';
    }
    // [review B S3-3] Any sign of an order whose send got no answer proves the kitchen has it: SENT after all.
    // An action Swift does not act on (a print request, an unknown name) proves nothing (security scan · d68ff3f6).
    const landed = sync.state === 'UNKNOWN' && event.kind !== 'IGNORED'
      ? await confirmLanded(deps, sync, event.kind === 'SEEN' ? "it is in the kitchen's order updates" : `the kitchen reported "${event.action}"`)
      : false;
    if (event.kind === 'SEEN') return landed ? 'applied' : 'ignored';
    if (event.kind === 'IGNORED') {
      log().info({ orderId: sync.orderId, action: event.action }, '[KITCHEN] kitchen action Swift does not act on — logged');
      return 'ignored';
    }
    // A sync that fell back was never the kitchen's (the store runs it on the tablet); one still being sent (or being
    // cancelled after an unanswered send) is settled by its sender first. Such an event is NOT replayed (the catch-up
    // cursor moves on): the kitchen's later events carry the order forward, and the backstop rings it if none come.
    if (!landed && (sync.state === 'FALLBACK' || sync.state === 'QUEUED' || sync.state === 'SENDING' || sync.state === 'UNKNOWN' || sync.state === 'CANCELLING')) return 'unchanged';
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
      // [review A S2-3] the store's own gate, as its routes apply it: accepting is NEW work, any later step is
      // IN_FLIGHT work. A refused store is not moved by its kitchen either; operations are told once.
      if (STATUS_STEPS.has(event.kind) && order.vendorId) {
        const refused = await storeRefusal(deps, order.vendorId, before === 'PENDING' ? 'NEW' : 'IN_FLIGHT');
        if (refused) {
          await pageOperations(deps, {
            orderId: order.id, tenantId: sync.tenantId, key: `${sync.id}:held:${event.kind}`,
            title: 'Kitchen system: a held store kept working an order',
            body: `Order ${order.orderNumber}: the store's kitchen reported "${event.action}" but ${refused}; Swift did not move the order. Check the order with the store.`,
          });
          return 'unchanged' as const;
        }
      }
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
            // [review B S3-7] the existing slip gate: one "running late" per order per SLIP_GATE_SECONDS
            const { revisePromise, SLIP_GATE_SECONDS } = await import('../eta/promise');
            const gate = await deps.redis.set(`eta:slip:${order.id}`, '1', 'EX', SLIP_GATE_SECONDS, 'NX');
            if (gate === 'OK') {
              const { NotificationService } = await import('../notification/notification.service');
              await revisePromise({ prisma: deps.prisma, io: deps.io, notifications: new NotificationService(deps.prisma, deps.io) }, {
                orderId: order.id, newPromisedAt: arrives, source: 'VENDOR', reason: "the store's driver's route estimate",
              }).catch((err: unknown) => log().warn({ err, orderId: order.id }, '[KITCHEN] promise revision failed'));
            }
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
        case 'UNDELIVERED':
        case 'BACK_TO_STORE': {
          // [review B S3-9] Back at the store without a Delivered (or undelivered, or unassigned): the store may have
          // voided the ticket in its own system, which Swift cannot see. Operations call the store.
          if (event.kind === 'BACK_TO_STORE' && !delivery) return 'unchanged' as const;
          await pageOperations(deps, {
            orderId: order.id, tenantId: sync.tenantId, key: `${sync.id}:${event.kind}`,
            title: event.kind === 'UNDELIVERED' ? "Kitchen system: the store's driver could not deliver"
              : event.kind === 'BACK_TO_STORE' ? "Kitchen system: the store's driver is back without a delivery"
                : "Kitchen system: order taken off the store's driver",
            body: `Order ${order.orderNumber}: the store's kitchen system reported "${event.action}". Call the store (it may have voided the order in its own system), then the customer if the order is late; cancel it in Swift if the store will not deliver.`,
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

/** Only the events for orders Swift gave this connection and still follows (one read, chunked): a catch-up answer
 *  also carries the store's own POS orders, a whole working day of them at stamp 0. */
async function eventsForSwiftOrders(deps: Pick<KitchenDeps, 'prisma'>, integrationId: string, events: KitchenEvent[]): Promise<KitchenEvent[]> {
  const ids = [...new Set(events.map((e) => e.externalOrderId))];
  const known = new Set<number>();
  for (let i = 0; i < ids.length; i += 5_000) {
    const rows = await deps.prisma.orderIntegrationSync.findMany({
      where: { vendorIntegrationId: integrationId, externalOrderId: { in: ids.slice(i, i + 5_000) }, state: { in: ['SENT', 'UNKNOWN', 'CANCEL_QUEUED', 'SENDING'] } },
      select: { externalOrderId: true },
    });
    for (const r of rows) known.add(r.externalOrderId);
  }
  return events.filter((e) => known.has(e.externalOrderId));
}

/** Poll every enabled connection whose interval passed: the updateStamp catch-up (and the queue, if configured). The
 *  cursor moves past everything an answer carried. */
export async function pollKitchenIntegrations(deps: KitchenDeps, opts: KitchenWorkWindow = {}): Promise<number> {
  const env = envOf(deps);
  if (!dragontailIntegrationEnabled(env)) return 0;
  const { pollSeconds } = dragontailSettings(env);
  if (pollSeconds === 0) return 0;
  const until = untilOf(opts);
  const now = nowOf(deps);
  const due = await deps.prisma.vendorIntegration.findMany({
    where: {
      enabled: true, externalStoreNo: { not: null },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: new Date(now.getTime() - pollSeconds * 1000) } }],
    },
    take: 20,
  });
  let polled = 0;
  for (const integration of due) {
    if (Date.now() >= until) break;
    const claimed = await deps.prisma.vendorIntegration.updateMany({
      where: { id: integration.id, lastPolledAt: integration.lastPolledAt },
      data: { lastPolledAt: now },
    });
    if (claimed.count === 0) continue;
    const answer = kitchenProvider(deps, integration);
    if (!answer.ok) {
      await noteIntegrationError(deps, integration.id, answer.problem);
      continue;
    }
    answer.provider.setDeadline(Date.now() + KITCHEN_SEND_BUDGET_MS);
    try {
      const result = await answer.provider.pollNotifications(integration.externalStoreNo!, integration.pollUpdateStamp);
      const ours = await eventsForSwiftOrders(deps, integration.id, result.events);
      await runWithTenant(integration.tenantId, () => applyKitchenEvents(deps, integration, ours));
      await deps.prisma.vendorIntegration.update({
        where: { id: integration.id },
        data: { lastHealthyAt: nowOf(deps), ...(result.nextCursor !== null ? { pollUpdateStamp: result.nextCursor } : {}) },
      });
      polled += 1;
    } catch (err) {
      await noteIntegrationError(deps, integration.id, problemOf(err));
    } finally {
      answer.provider.setDeadline(null);
    }
  }
  return polled;
}

/**
 * [DT-OUTAGE] Probe each OFFLINE branch link at most once per cool-down (compare-and-set on its probe time, so one
 * instance probes): a fresh login, the lightest call the spec has (it has no health check). Success closes the
 * breaker (one "back online" note); failure leaves it offline. Switch off: nothing.
 */
export async function probeOfflineKitchenLinks(deps: KitchenDeps, opts: KitchenWorkWindow = {}): Promise<number> {
  const env = envOf(deps);
  if (!dragontailIntegrationEnabled(env)) return 0;
  const until = untilOf(opts);
  const now = nowOf(deps);
  const { probeMs } = kitchenBreakerSettings(env);
  const due = await deps.prisma.vendorIntegration.findMany({
    where: { enabled: true, linkOfflineAt: { not: null }, OR: [{ linkProbeAt: null }, { linkProbeAt: { lte: new Date(now.getTime() - probeMs) } }] },
    take: 20,
  });
  let closed = 0;
  for (const integration of due) {
    if (Date.now() >= until) break;
    const claimed = await deps.prisma.vendorIntegration.updateMany({ where: { id: integration.id, linkProbeAt: integration.linkProbeAt }, data: { linkProbeAt: now } });
    if (claimed.count === 0) continue;
    const answer = kitchenProvider(deps, integration, () => '', { freshToken: true });
    if (!answer.ok) {
      await noteIntegrationError(deps, integration.id, answer.problem);
      continue;
    }
    answer.provider.setDeadline(Date.now() + 10_000);
    try {
      await answer.provider.testConnection();
      if ((await recordLinkSuccess(deps, integration.id)) === 'closed') closed += 1;
    } catch (err) {
      await noteIntegrationError(deps, integration.id, `link probe: ${problemOf(err)}`);
    } finally {
      answer.provider.setDeadline(null);
    }
  }
  return closed;
}

/**
 * The worker's tick: send, propagate cancels, settle unanswered sends, ring stuck or unaccepted claims, poll.
 * [review A S3-1 · B S3-2] ONE tick at a time across every worker: a Redis lock that outlives the tick's window plus
 * the longest single piece of work (a send's lease); a tick that finds it held returns at once, so kitchen work never
 * holds more than one order-queue worker. Every part stops taking new work when the tick's window closes.
 */
export async function runKitchenTick(deps: KitchenDeps): Promise<'ran' | 'skipped'> {
  if (!dragontailIntegrationEnabled(envOf(deps))) return 'skipped';
  const token = randomUUID();
  const lockMs = KITCHEN_TICK_BUDGET_MS + KITCHEN_LEASE_MS;
  const got = await deps.redis.set(KITCHEN_TICK_LOCK, token, 'PX', lockMs, 'NX');
  if (got !== 'OK') return 'skipped';
  const window: KitchenWorkWindow = { until: Date.now() + KITCHEN_TICK_BUDGET_MS };
  try {
    for (const [name, run] of [
      ['drain', () => drainKitchenSyncs(deps, window)],
      ['cancel', () => propagateKitchenCancellations(deps, window)],
      ['unknown', () => resolveUnknownKitchenSyncs(deps, window)],
      ['backstop', () => kitchenBackstopSweep(deps)],
      ['poll', () => pollKitchenIntegrations(deps, window)],
      ['link-probe', () => probeOfflineKitchenLinks(deps, window)],
    ] as const) {
      try {
        await run();
      } catch (err) {
        log().error({ err, part: name }, '[KITCHEN] tick part failed; the others still ran');
      }
    }
  } finally {
    // Release only our own lock (a lapsed lock may already be another tick's).
    await deps.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1, KITCHEN_TICK_LOCK, token,
    ).catch(() => undefined);
  }
  return 'ran';
}
