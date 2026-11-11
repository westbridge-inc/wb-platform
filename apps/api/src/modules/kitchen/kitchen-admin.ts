import type { PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import { AppError } from '../../utils/errors';
import { kitchenLoginRef, kitchenSecretStatus, kitchenWebhookRef, newKitchenIntegrationId } from './kitchen-credentials';
import { dragontailApiUrl, dragontailIntegrationEnabled, dragontailSettings } from './kitchen-switch';
import { kitchenProviderFor } from './kitchen-sync';

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

export async function putKitchenIntegration(prisma: PrismaClient, vendorId: string, body: unknown) {
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
  let row;
  if (existing) {
    row = await prisma.vendorIntegration.update({ where: { id: existing.id }, data: next });
  } else {
    const id = newKitchenIntegrationId();
    const keys = { id, provider: 'DRAGONTAIL' as const };
    row = await prisma.vendorIntegration.create({
      data: { ...keys, vendorId, ...next, secretRef: kitchenLoginRef(keys), webhookSecretRef: kitchenWebhookRef(keys) },
    });
  }
  return view(row);
}

export async function testKitchenConnection(prisma: PrismaClient, io: Server, redis: Redis, vendorId: string) {
  await vendorOrThrow(prisma, vendorId);
  const row = await prisma.vendorIntegration.findUnique({ where: { vendorId_provider: { vendorId, provider: 'DRAGONTAIL' } } });
  if (!row) throw new AppError(404, 'KITCHEN_NOT_SET_UP', 'This store has no kitchen-system connection yet.');
  const provider = kitchenProviderFor({ prisma, io, redis }, row);
  if (!provider) {
    return { ok: false, problem: `No login under ${kitchenLoginRef(row)} in the credentials secret.` };
  }
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
  const input = kitchenItemNumbersSchema.parse(body ?? {});
  await vendorOrThrow(prisma, vendorId);
  return prisma.$transaction(async (tx) => {
    let items = 0;
    let options = 0;
    for (const row of input.items) {
      const r = await tx.item.updateMany({ where: { id: row.itemId, vendorId }, data: { externalItemNo: row.externalItemNo || null } });
      items += r.count;
    }
    for (const row of input.options) {
      const r = await tx.option.updateMany({ where: { id: row.optionId, optionGroup: { item: { vendorId } } }, data: { externalItemNo: row.externalItemNo || null } });
      options += r.count;
    }
    const unknown = input.items.length - items + input.options.length - options;
    if (unknown > 0) throw new AppError(400, 'KITCHEN_UNKNOWN_LINES', `${unknown} listing(s) or choice(s) are not this store's; nothing was changed.`);
    return { items, options };
  });
}
