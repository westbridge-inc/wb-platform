import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import { kitchenLoginRef, kitchenSecretStatus, kitchenWebhookRef, newKitchenIntegrationId } from './kitchen-credentials';
import { dragontailApiUrl, dragontailIntegrationEnabled, dragontailSettings } from './kitchen-switch';
import { kitchenProvider } from './kitchen-sync';

/**
 * [KITCHEN-INTEGRATION] The operations console's door to a store's kitchen-system connection (UI later). Handlers
 * only; admin.routes.ts registers them so every route is classified by the admin authority engine.
 *
 *   GET  /vendors/:id/kitchen-integration               the connection, its health, whether its secrets resolve
 *   PUT  /vendors/:id/kitchen-integration               enable/disable, store number, secret references (C3, a reason)
 *   POST /vendors/:id/kitchen-integration/test          log in only (no order is sent)
 *   GET  /vendors/:id/kitchen-integration/syncs         the sync log, newest first
 *   PUT  /vendors/:id/kitchen-integration/item-numbers  bulk-set kitchen item numbers on listings and choices
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
const LIVE_SYNC_STATES = ['QUEUED', 'SENDING', 'SENT', 'UNKNOWN', 'CANCEL_QUEUED'] as const;

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
