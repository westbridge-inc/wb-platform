import type { FastifyBaseLogger } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { retryStorageOrphan } from '../../lib/storage-orphans';
import { runAsSystem } from '../../plugins/tenant-context';
import type { StorageProvider } from '../../providers/storage/storage-provider';
import { NotFoundError } from '../../utils/errors';
import { queueStorePhotoDeletions } from './store-photos';

type PhotoDeps = { prisma: PrismaClient; storage: StorageProvider; log: FastifyBaseLogger };

/** [IMAGES-E2E PR4] After a store photo's pointer change commits: delete each photo now. A
 *  delete that fails stays owed and the standing retry (retryStorageOrphans) finishes it. */
export async function deleteQueuedStorePhotos(deps: PhotoDeps, orphanIds: string[]): Promise<void> {
  if (orphanIds.length === 0) return;
  await runAsSystem('public-photo-deletion', async () => {
    for (const id of orphanIds) await retryStorageOrphan(deps.prisma, deps.storage, deps.log, id);
  });
}

/** A photo just kept that its row could not take (the row went meanwhile) is deleted, not left behind. */
export async function discardKeptStorePhoto(deps: PhotoDeps, vendorId: string, url: string): Promise<void> {
  const ids = await deps.prisma.$transaction((tx) => queueStorePhotoDeletions(tx, vendorId, [url])).catch(() => [] as string[]);
  await deleteQueuedStorePhotos(deps, ids);
}

/**
 * [IMAGES-E2E PR4 · ASSISTED SETUP] An item's photo set to a photo just kept in the store's own folder (keepPublicPhoto,
 * `items/<store>/`), whoever uploaded it: the store (vendor.routes POST /items/:id/image) or a Swift admin setting the
 * store up with its consent. Under the item's lock; the photo it replaces is queued for deletion in the same transaction
 * and deleted after (a photo the row could not take is deleted too). `within` runs in that transaction (the assisted
 * setup's record), so the photo is never set without it.
 */
export async function setItemPhoto(
  deps: PhotoDeps,
  input: { vendorId: string; itemId: string; url: string; within?: (tx: Prisma.TransactionClient, item: { id: string; name: string; imageUrl: string | null }) => Promise<void> },
): Promise<{ id: string; name: string; imageUrl: string | null }> {
  const { vendorId, itemId, url } = input;
  const { item, orphanIds } = await deps.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ imageUrl: string | null }>>`
      SELECT "imageUrl" FROM "items" WHERE "id" = ${itemId} AND "vendorId" = ${vendorId} AND "archivedAt" IS NULL
      FOR UPDATE /* item-photo-authority */
    `;
    if (!rows[0]) throw new NotFoundError('Item', itemId);
    const queued = await queueStorePhotoDeletions(tx, vendorId, [rows[0].imageUrl]);
    const row = await tx.item.update({
      where: { id: itemId, archivedAt: null },
      data: { imageUrl: url },
      select: { id: true, name: true, imageUrl: true },
    });
    if (input.within) await input.within(tx, row);
    return { item: row, orphanIds: queued };
  }).catch(async (err: unknown) => {
    await discardKeptStorePhoto(deps, vendorId, url);
    // [Item 62] A listing archived between the read and the guarded write is gone: 404, never a 500.
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025') throw new NotFoundError('Item', itemId);
    throw err;
  });
  await deleteQueuedStorePhotos(deps, orphanIds);
  return item;
}
