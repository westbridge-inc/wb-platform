import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { vatTermsByVendor } from './order-vat';

// ---------------------------------------------------------------------------
// [STORE-VAT-EXCLUSIVE · REVIEW-A F3 · REVIEW-B S3-1] Older apps and a store pricing BEFORE VAT.
//
// A store pricing before VAT adds its VAT at checkout as its own "VAT 14%" line. An app built before that line existed
// shows the server's Total (VAT inside) with no VAT row and no "+ VAT" beside the prices, so its screen does not add up
// and nothing tells the customer why. Such an app never orders from such a store: the cart add and the checkout are
// refused, in plain words, unless the app declares it shows the VAT line (VAT_LINE_CAPABILITY, sent beside
// MENU_OPTIONS_V2 in the same `capabilities` list). The price lock does not help here: an old app sends the server's
// total, VAT included, as its expected total.
// ---------------------------------------------------------------------------

/** The capability an app declares (cart writes and checkout `capabilities`) when it shows a store's "VAT 14%" line,
 *  the "+ VAT" beside before-VAT prices and the store-page note. */
export const VAT_LINE_CAPABILITY = 'VAT_LINE_V1';

export const VAT_LINE_APP_UPDATE_MESSAGE =
  'This store’s prices are before VAT: VAT is added at checkout as its own line, and this version of the Swift app cannot show it. Update the Swift app to order from this store.';

/** Whether a request body declares it. */
export function declaresVatLine(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes(VAT_LINE_CAPABILITY);
}

/** The refusal (409 APP_UPDATE_REQUIRED, the code older apps already answer with "update the app"). */
export function vatLineAppUpdateRequired(vendorIds: readonly string[]): AppError {
  return new AppError(409, 'APP_UPDATE_REQUIRED', VAT_LINE_APP_UPDATE_MESSAGE, { vendorId: [...vendorIds] });
}

/** Refuses a cart write for a store pricing before VAT from an app that does not declare it shows the VAT line. */
export async function assertAppShowsVatLine(
  db: Pick<Prisma.TransactionClient, 'vendor'>, vendorIds: readonly string[], capabilities: unknown,
): Promise<void> {
  if (declaresVatLine(capabilities) || vendorIds.length === 0) return;
  const terms = await vatTermsByVendor(db, vendorIds);
  const onTop = [...terms.entries()].filter(([, t]) => t.onTop).map(([id]) => id);
  if (onTop.length > 0) throw vatLineAppUpdateRequired(onTop);
}
