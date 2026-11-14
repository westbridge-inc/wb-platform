import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { kitchenLoginRef, kitchenSecretStatus, kitchenWebhookRef, newKitchenIntegrationId } from './kitchen-credentials';
import { dragontailApiUrl, dragontailDriverCheckEnabled, dragontailIntegrationEnabled, dragontailSettings } from './kitchen-switch';
import { kitchenProvider, probeKitchenLink, type KitchenDeps } from './kitchen-sync';
import { listKitchenRoutes, readBusyHours, writeKitchenOverflowSetting } from './kitchen-overflow';

/**
 * [KITCHEN-INTEGRATION] The operations console's door to a store's kitchen-system connection (UI later). Handlers
 * only; admin.routes.ts registers them so every route is classified by the admin authority engine.
 *
 *   GET  /vendors/:id/kitchen-integration               the connection, its health, whether its secrets resolve
 *   PUT  /vendors/:id/kitchen-integration               enable/disable, store number, secret references (C3, a reason)
 *   POST /vendors/:id/kitchen-integration/test          log in only (no order is sent)
 *   GET  /vendors/:id/kitchen-integration/syncs         the sync log, newest first
 *   PUT  /vendors/:id/kitchen-integration/item-numbers  bulk-set kitchen item numbers on listings and choices
 *   PUT  /vendors/:id/kitchen-integration/overflow      [DT-OVERFLOW] the branch's delivery overflow (mode, busy hours)
 *   GET  /vendors/:id/kitchen-integration/routes        [DT-OVERFLOW] where its recent deliveries went, and why
 *
 * [review A S3-2] While the switch (DRAGONTAIL_INTEGRATION) is off the two writing routes and the test are REFUSED
 * (409 KITCHEN_SWITCH_OFF): nothing is written to the kitchen tables and no call leaves Swift. The reads still
 * answer. Switching on enables nothing by itself: each store's connection is then enabled here, one by one.
 *
 * Never returns a credential: only the keys the owner enters them under and whether they resolve. The keys are
 * DERIVED from the connection's own id and written by the server; no request can name, set or move one (a
 * request that tries is refused by the strict schema), so a store can never be pointed at another store's login
 * or webhook secret. Credentials themselves are set only in the deploy secret store, by the owner.
 */

export const kitchenIntegrationSchema = z.object({
  enabled: z.boolean().optional(),
  externalStoreNo: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  reason: z.string().optional(),
}).strict();

export const kitchenItemNumbersSchema = z.object({
  items: z.array(z.object({ itemId: z.string().min(1), externalItemNo: z.string().trim().max(64).nullable() })).max(2000).default([]),
  options: z.array(z.object({ optionId: z.string().min(1), externalItemNo: z.string().trim().max(64).nullable() })).max(5000).default([]),
  reason: z.string().optional(),
}).strict();

function view(row: {
  id: string; provider: string; enabled: boolean; externalStoreNo: number | null; secretRef: string | null; webhookSecretRef: string | null;
  pollUpdateStamp: bigint; lastPolledAt: Date | null; lastHealthyAt: Date | null; lastError: string | null; lastErrorAt: Date | null; updatedAt: Date;
  overflowMode: string; overflowBusyHours: unknown; overflowUpdatedAt: Date | null;
} | null) {
  const env = process.env;
  return {
    switchOn: dragontailIntegrationEnabled(env),
    apiUrl: dragontailApiUrl(env),
    settings: dragontailSettings(env),
    connection: row
      ? {
        id: row.id, provider: row.provider, enabled: row.enabled, externalStoreNo: row.externalStoreNo,
        webhookPath: `/api/v1/integrations/dragontail/notifications/${row.id}`,
        secrets: kitchenSecretStatus(row, env),
        pollUpdateStamp: row.pollUpdateStamp.toString(),
        lastPolledAt: row.lastPolledAt, lastHealthyAt: row.lastHealthyAt, lastError: row.lastError, lastErrorAt: row.lastErrorAt,
        updatedAt: row.updatedAt,
        overflow: { mode: row.overflowMode, busyHours: readBusyHours(row.overflowBusyHours), updatedAt: row.overflowUpdatedAt },
      }
      : null,
  };
}

async function vendorOrThrow(prisma: PrismaClient, vendorId: string) {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, selfDeliveryEnabled: true } });
  if (!vendor) throw new AppError(404, 'NOT_FOUND', 'Store not found');
  return vendor;
}

export async function getKitchenIntegration(prisma: PrismaClient, vendorId: string) {
  await vendorOrThrow(prisma, vendorId);
  const row = await prisma.vendorIntegration.findUnique({ where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } } });
  return view(row);
}

/** [review A S4-5] What an enabling/renumbering change looked like, for the inline audit row (no person data). */
export type KitchenAuditFacts = Record<string, string | number | boolean | null>;
export type KitchenAudit = (tx: Prisma.TransactionClient, entityId: string, facts: KitchenAuditFacts) => Promise<void>;

/** Sync states in which the kitchen system may still hold or act on an order. */
const LIVE_SYNC_STATES = ['QUEUED', 'SENDING', 'SENT', 'UNKNOWN', 'CANCELLING', 'CANCEL_QUEUED'] as const;

/** [review A S3-2] The writing routes and the test answer only while the switch is on. */
function assertSwitchOn(what: string): void {
  if (!dragontailIntegrationEnabled()) {
    throw new AppError(409, 'KITCHEN_SWITCH_OFF', `The kitchen-system switch (DRAGONTAIL_INTEGRATION) is off: ${what} is refused while it is off.`);
  }
}

export async function putKitchenIntegration(prisma: PrismaClient, vendorId: string, body: unknown, audit?: KitchenAudit) {
  assertSwitchOn('changing a connection');
  const input = kitchenIntegrationSchema.parse(body ?? {});
  const vendor = await vendorOrThrow(prisma, vendorId);
  const existing = await prisma.vendorIntegration.findUnique({ where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } } });
  const next = {
    enabled: input.enabled ?? existing?.enabled ?? false,
    externalStoreNo: input.externalStoreNo !== undefined ? input.externalStoreNo : existing?.externalStoreNo ?? null,
  };
  if (next.enabled) {
    if (next.externalStoreNo == null) {
      throw new AppError(400, 'KITCHEN_INCOMPLETE', 'Set the store number before switching the connection on.');
    }
    // A connected store's deliveries go with its own drivers: Swift riders never join a kitchen-system order.
    if (!vendor.selfDeliveryEnabled) {
      throw new AppError(409, 'KITCHEN_NEEDS_OWN_DELIVERY', "Turn on the store's own delivery first: a connected store delivers with its own drivers.");
    }
  }
  if (next.externalStoreNo != null) {
    const taken = await prisma.vendorIntegration.findFirst({
      where: { provider: 'DRAGONTAIL', externalStoreNo: next.externalStoreNo, NOT: { vendorId } },
      select: { id: true },
    });
    if (taken) throw new AppError(409, 'KITCHEN_STORE_NO_TAKEN', 'Another Swift store already uses this kitchen store number.');
  }
  // [review B S4-1] Renumbering while the kitchen still holds orders would send their cancels (and read their
  // events) under the wrong store: refused until every order with it is finished.
  if (existing && existing.externalStoreNo != null && next.externalStoreNo !== existing.externalStoreNo) {
    const live = await prisma.orderIntegrationSync.count({ where: { vendorIntegrationId: existing.id, state: { in: [...LIVE_SYNC_STATES] } } });
    if (live > 0) throw new AppError(409, 'KITCHEN_ORDERS_LIVE', `${live} order(s) are still with the kitchen system under the current store number; change it when they are finished.`);
  }
  const row = await prisma.$transaction(async (tx) => {
    let written;
    if (existing) {
      written = await tx.vendorIntegration.update({ where: { id: existing.id }, data: next });
    } else {
      const id = newKitchenIntegrationId();
      const keys = { id, provider: 'DRAGONTAIL' as const };
      written = await tx.vendorIntegration.create({
        data: { ...keys, vendorId, ...next, secretRef: kitchenLoginRef(keys), webhookSecretRef: kitchenWebhookRef(keys) },
      });
    }
    await audit?.(tx, written.id, {
      enabledBefore: existing?.enabled ?? null, enabledAfter: written.enabled,
      storeNoBefore: existing?.externalStoreNo ?? null, storeNoAfter: written.externalStoreNo,
      created: !existing,
    });
    return written;
  });
  return view(row);
}

export async function testKitchenConnection(prisma: PrismaClient, vendorId: string) {
  // [review A S3-2] No call leaves Swift while the switch is off, a login test included.
  assertSwitchOn('a login test (nothing is sent to any kitchen system)');
  await vendorOrThrow(prisma, vendorId);
  const row = await prisma.vendorIntegration.findUnique({ where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } } });
  if (!row) throw new AppError(404, 'KITCHEN_NOT_SET_UP', 'This store has no kitchen-system connection yet.');
  // A fresh login, never the sender's cached token.
  const answer = kitchenProvider({}, row, () => '', { freshToken: true });
  if (!answer.ok) {
    return { ok: false, problem: answer.problem === 'the store login is not in the credentials secret' ? `No login under ${kitchenLoginRef(row)} in the credentials secret.` : answer.problem };
  }
  const provider = answer.provider;
  provider.setDeadline(Date.now() + 20_000);
  try {
    await provider.testConnection();
    await prisma.vendorIntegration.update({ where: { id: row.id }, data: { lastHealthyAt: new Date() } });
    return { ok: true, problem: null };
  } catch (err) {
    const problem = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await prisma.vendorIntegration.update({ where: { id: row.id }, data: { lastError: problem, lastErrorAt: new Date() } });
    return { ok: false, problem };
  }
}

export async function listKitchenSyncs(prisma: PrismaClient, vendorId: string, query: { limit?: unknown }) {
  await vendorOrThrow(prisma, vendorId);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const rows = await prisma.orderIntegrationSync.findMany({
    where: { vendorIntegration: { vendorId } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, orderId: true, externalOrderId: true, dailyNo: true, state: true, lastAction: true, lastActionAt: true,
      attempts: true, lastError: true, promiseSeconds: true, sentAt: true, fallbackAt: true, cancelledAt: true, dispatchedAt: true,
      createdAt: true, order: { select: { orderNumber: true, status: true } },
    },
  });
  return rows.map(({ order, ...row }) => ({ ...row, orderNumber: order.orderNumber, orderStatus: order.status }));
}

export async function setKitchenItemNumbers(prisma: PrismaClient, vendorId: string, body: unknown) {
  assertSwitchOn('setting kitchen item numbers');
  const input = kitchenItemNumbersSchema.parse(body ?? {});
  await vendorOrThrow(prisma, vendorId);
  // [review B S4-8] Ownership is checked in two reads up front (a foreign id refuses the whole change before any
  // write), and the writes get a timeout that fits a large menu.
  const itemIds = [...new Set(input.items.map((r) => r.itemId))];
  const optionIds = [...new Set(input.options.map((r) => r.optionId))];
  const ownItems = itemIds.length ? await prisma.item.count({ where: { id: { in: itemIds }, vendorId } }) : 0;
  const ownOptions = optionIds.length ? await prisma.option.count({ where: { id: { in: optionIds }, optionGroup: { item: { vendorId } } } }) : 0;
  const unknown = itemIds.length - ownItems + optionIds.length - ownOptions;
  if (unknown > 0) throw new AppError(400, 'KITCHEN_UNKNOWN_LINES', `${unknown} listing(s) or choice(s) are not this store's; nothing was changed.`);
  return prisma.$transaction(async (tx) => {
    let items = 0;
    let options = 0;
    for (const row of input.items) {
      items += (await tx.item.updateMany({ where: { id: row.itemId, vendorId }, data: { externalItemNo: row.externalItemNo || null } })).count;
    }
    for (const row of input.options) {
      options += (await tx.option.updateMany({ where: { id: row.optionId, optionGroup: { item: { vendorId } } }, data: { externalItemNo: row.externalItemNo || null } })).count;
    }
    return { items, options };
  }, { timeout: 120_000, maxWait: 10_000 });
}

/** [DT-OVERFLOW] The branch's delivery overflow, for the console: the switch, the connection, the setting. */
export async function getKitchenOverflow(prisma: PrismaClient, vendorId: string) {
  await vendorOrThrow(prisma, vendorId);
  const row = await prisma.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } },
    select: {
      enabled: true, overflowMode: true, overflowBusyHours: true, overflowUpdatedAt: true, linkOfflineAt: true, linkFailures: true,
      linkOutageSince: true, driverCheckAt: true, driverCheckFree: true, driverCheckProblem: true,
    },
  });
  // [round 3 · review B S4-8] Orders on the tablet that Dragontail MAY also have (the switch went off mid-send): "Get a
  // Swift rider" stays refused for them until operations confirm with the store that Dragontail does not have them.
  const maybe = row ? await prisma.orderIntegrationSync.findMany({
    where: { vendorIntegration: { vendorId }, state: 'FALLBACK', maybeInKitchen: true },
    orderBy: { fallbackAt: 'desc' },
    take: 20,
    select: { orderId: true, fallbackAt: true, order: { select: { orderNumber: true, status: true } } },
  }) : [];
  return {
    maybeInKitchen: maybe.map((m) => ({ orderId: m.orderId, orderNumber: m.order.orderNumber, orderStatus: m.order.status, fallbackAt: m.fallbackAt })),
    switchOn: dragontailIntegrationEnabled(),
    // [round 2 · review A S2-3] The driver check's own switch: off until Dragontail confirms what it lists.
    driverCheckAvailable: dragontailDriverCheckEnabled(),
    // [round 2 · review A S2-2] The kitchen tick's latest driver check for this branch (null free = it failed: why).
    driverCheck: row?.driverCheckAt ? { at: row.driverCheckAt, free: row.driverCheckFree, problem: row.driverCheckProblem } : null,
    // [round 2 · review A S3-2] A probe's login re-opened the link; the outage ends when a real send goes through.
    linkOnTrial: row != null && row.linkOfflineAt == null && row.linkOutageSince != null,
    // [DT-OUTAGE] "Kitchen link offline, orders on tablet" (kitchen-link.ts), and the certain failures counted so far.
    linkOfflineAt: row?.linkOfflineAt ?? null,
    linkFailures: row?.linkFailures ?? 0,
    connected: row !== null,
    enabled: row?.enabled ?? false,
    mode: row?.overflowMode ?? 'NONE',
    busyHours: readBusyHours(row?.overflowBusyHours),
    updatedAt: row?.overflowUpdatedAt ?? null,
  };
}

/** [DT-OVERFLOW] The console's change of a branch's delivery overflow (refused while the switch is off). */
export async function putKitchenOverflow(prisma: PrismaClient, vendorId: string, body: unknown, audit?: KitchenAudit) {
  await vendorOrThrow(prisma, vendorId);
  await writeKitchenOverflowSetting(prisma, vendorId, body, process.env, audit);
  return getKitchenOverflow(prisma, vendorId);
}

/**
 * [round 3 · review B S4-8] Operations confirmed with the store that Dragontail does NOT have this order (absent, or
 * cancelled there): the "maybe in Dragontail" hold is cleared, so the store may get a Swift rider for it again. Only a
 * tablet order still flagged; audited (the order, never a person's detail).
 */
export async function clearMaybeInKitchen(prisma: PrismaClient, vendorId: string, orderId: string, audit?: KitchenAudit, reason: string | null = null) {
  await vendorOrThrow(prisma, vendorId);
  return prisma.$transaction(async (tx) => {
    const sync = await tx.orderIntegrationSync.findFirst({
      where: { orderId, provider: 'DRAGONTAIL', vendorIntegration: { vendorId } },
      select: { id: true, state: true, maybeInKitchen: true },
    });
    if (!sync) throw new AppError(404, 'NOT_FOUND', 'This order has no kitchen-system record at this store.');
    if (sync.state !== 'FALLBACK' || !sync.maybeInKitchen) {
      throw new AppError(409, 'NOT_MAYBE_IN_KITCHEN', 'This order is not waiting on a "maybe in Dragontail" check.');
    }
    await tx.orderIntegrationSync.update({ where: { id: sync.id }, data: { maybeInKitchen: false } });
    // [follow-up · confirm review N-5] The stated reason (who confirmed it, in the operator's words) rides the audit row.
    await audit?.(tx, sync.id, { orderId, maybeInKitchenBefore: true, maybeInKitchenAfter: false, reason });
    return { orderId, maybeInKitchen: false };
  });
}

/**
 * [follow-up · confirm review N-1] "Try the link now": operations force ONE probe of an OFFLINE branch link (a fresh
 * login and an order-API read; a 4xx to the optional read counts as login only), ignoring the back-off. A pass puts
 * the link on trial, as the tick's probe would. Refused while the switch is off or the link is not offline. Audited
 * (the result, never a credential); the route requires a stated reason.
 */
export async function tryKitchenLinkNow(deps: Pick<KitchenDeps, 'prisma' | 'io' | 'redis'>, vendorId: string, audit?: KitchenAudit) {
  assertSwitchOn('trying the kitchen link (one login and one order read)');
  const { prisma } = deps;
  await vendorOrThrow(prisma, vendorId);
  const row = await prisma.vendorIntegration.findUnique({
    where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } },
    select: { id: true, provider: true, enabled: true, linkOfflineAt: true, linkProbeAt: true, externalStoreNo: true, pollUpdateStamp: true },
  });
  if (!row) throw new AppError(404, 'KITCHEN_NOT_SET_UP', 'This store has no kitchen-system connection yet.');
  if (!row.enabled) throw new AppError(409, 'KITCHEN_CONNECTION_OFF', 'This connection is switched off.');
  if (!row.linkOfflineAt) throw new AppError(409, 'LINK_NOT_OFFLINE', 'The kitchen link is not offline: there is nothing to try.');
  const result = await probeKitchenLink(deps as KitchenDeps, row);
  const after = await prisma.vendorIntegration.findUnique({ where: { id: row.id }, select: { linkOfflineAt: true, lastError: true } });
  await prisma.$transaction(async (tx) => {
    await audit?.(tx, row.id, { result, offlineSince: row.linkOfflineAt?.toISOString() ?? null, offlineAfter: after?.linkOfflineAt != null });
  });
  return { result, linkOffline: after?.linkOfflineAt != null, problem: result === 'failed' ? after?.lastError ?? null : null };
}

/** [DT-OVERFLOW] Where the branch's recent deliveries went (its kitchen system or Swift riders), and why. */
export async function listKitchenRoutesFor(prisma: PrismaClient, vendorId: string, query: { limit?: unknown }) {
  await vendorOrThrow(prisma, vendorId);
  return listKitchenRoutes(prisma, vendorId, query);
}
