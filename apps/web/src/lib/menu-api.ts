import { apiFetch, ApiRequestError } from '@/lib/auth';
import type { CatalogItem } from '@/lib/vendor-api';
import { itemGoneWords } from '@/lib/store-kind-words';
// [REVIEW-MENU-B S3-5] What every option write says (MENU_OPTIONS_V2): the server refuses an older store app's edit of
// a size / half-and-half / follow-up group. The app's own plain file, imported by path (the Dockerfile copies it).
import { cartWriteCapabilities } from '../../../mobile/src/lib/menuOptionsCapability';

// [TAP-AUDIT 27 Oct · owner rule 11 Oct: the website copies the app] The menu writes the phone's item editor and
// Products tab make (apps/mobile/src/services/api.ts vendorApi, same routes, same bodies), so the web dashboard can add
// and edit an item with its photo and options, and add, rename and delete sections — before this the web could only
// switch items on/off, change a price and bulk-import. Loaded only with the editor (the Products page's first load
// does not carry it).

const V = '/api/v1/vendor';

export type BulkWord = 'normal' | 'bulky' | 'very_bulky';
// [VAT-DOCS] vatListedAdditionalPrice: the extra price the store typed before VAT, while VAT is added to it (else null).
// [MENU-OPTIONS · owner 11 Nov 2026] followUpGroupId: the group of the same item this choice opens (one level).
export type OptionRow = { id: string; name: string; additionalPrice: string | number; vatListedAdditionalPrice?: string | number | null; isAvailable?: boolean; followUpGroupId?: string | null };
// [MENU-OPTIONS] setsPrice (size sets the price), allowHalves + halfPricePercent (half-and-half), libraryGroupId (a
// copy of a shared library group: edited in the option library only).
export type OptionGroupRow = {
  id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: OptionRow[];
  setsPrice?: boolean; allowHalves?: boolean; halfPricePercent?: number; libraryGroupId?: string | null;
};
export type GroupBody = {
  name?: string; isRequired?: boolean; minSelect?: number; maxSelect?: number; setsPrice?: boolean; allowHalves?: boolean; halfPricePercent?: number;
  // [REVIEW-MENU-B S2-1] Switching "Sets the price" converts every choice's typed price in the same request.
  prices?: Array<{ id: string; price: number }>;
};
/** [REVIEW-MENU-B S2-1] A new size group comes with its sizes (the server refuses a size group with none). */
export type NewGroupOption = { name: string; additionalPrice: number; vatListedAdditionalPrice?: number };
/** An item as the server answers it to the editor (GET /items row, POST/PUT /items answer). */
export type MenuItem = CatalogItem & {
  categoryId?: string;
  description?: string | null;
  isPopular?: boolean;
  bulk?: BulkWord;
  fulfillment?: string;
  bookingConfig?: { durationMinutes?: number; slots?: Array<{ dayOfWeek: number; start: string; end: string }>; serviceMode?: 'AT_BUSINESS' | 'MOBILE' | 'BOTH'; serviceRadiusKm?: number } | null;
  optionGroups?: OptionGroupRow[];
};
export type Section = { id: string; name: string; imageUrl?: string | null; items?: unknown[] };

/** The editor's body for POST /vendor/items (with `optionGroups` on a new item) or PUT /vendor/items/:id. */
export type ItemBody = Record<string, unknown>;

const data = <T>(r: { data?: unknown }) => r.data as T;

export const createItem = (body: ItemBody) => apiFetch(`${V}/items`, { method: 'POST', body: JSON.stringify(body) }).then(data<MenuItem>);
export const saveItem = (id: string, body: ItemBody) => apiFetch(`${V}/items/${id}`, { method: 'PUT', body: JSON.stringify(body) }).then(data<MenuItem>);
/** [MENU-OPTIONS] One item as the editor reads it (GET /items holds every item: an attach or a shared group's removal
 *  changes more than one of the item's groups, so they are read again). */
export const readItem = (id: string) => apiFetch(`${V}/items`).then((r) => (data<MenuItem[]>(r) ?? []).find((i) => i.id === id) ?? null);
export const deleteItem = (id: string) => apiFetch(`${V}/items/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean }>);
export const uploadItemPhoto = (id: string, file: Blob, name: string) => {
  const form = new FormData();
  form.append('file', file, name);
  return apiFetch(`${V}/items/${id}/image`, { method: 'POST', body: form }).then(data<{ id: string; imageUrl: string | null }>);
};

export const createSection = (name: string) => apiFetch(`${V}/categories`, { method: 'POST', body: JSON.stringify({ name }) }).then(data<Section>);
export const renameSection = (id: string, name: string) => apiFetch(`${V}/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }).then(data<Section>);
export const deleteSection = (id: string) => apiFetch(`${V}/categories/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean; itemsRemoved: number }>);

const withCapability = <T extends object>(body: T) => JSON.stringify({ ...body, capabilities: cartWriteCapabilities() });
export const addOptionGroup = (itemId: string, body: GroupBody & { name: string; isRequired: boolean; minSelect: number; maxSelect: number; options?: NewGroupOption[] }) =>
  apiFetch(`${V}/items/${itemId}/option-groups`, { method: 'POST', body: withCapability(body) }).then(data<OptionGroupRow>);
export const updateOptionGroup = (id: string, body: GroupBody) =>
  apiFetch(`${V}/option-groups/${id}`, { method: 'PUT', body: withCapability(body) }).then(data<OptionGroupRow>);
export const updateOption = (id: string, body: { followUpGroupId?: string | null; isAvailable?: boolean }) =>
  apiFetch(`${V}/options/${id}`, { method: 'PUT', body: withCapability(body) }).then(data<OptionRow>);
export const deleteOptionGroup = (id: string) => apiFetch(`${V}/option-groups/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean }>);
export const addOption = (groupId: string, body: { name: string; additionalPrice: number; vatListedAdditionalPrice?: number }) =>
  apiFetch(`${V}/option-groups/${groupId}/options`, { method: 'POST', body: withCapability(body) }).then(data<OptionRow>);
export const deleteOption = (id: string) => apiFetch(`${V}/options/${id}`, { method: 'DELETE' }).then(data<{ deleted: boolean }>);

// [MENU-OPTIONS · owner 11 Nov 2026] The shared option library (the app's VendorOptionLibraryScreen, same routes and
// bodies): a group built once and attached to many items; editing it changes every item that uses it. Prices are what
// the store types (before VAT where VAT is added).
export type LibraryOption = { id: string; name: string; price: number; isDefault: boolean; isAvailable: boolean; sortOrder: number; followUpGroupId: string | null; externalCode: string | null };
export type LibraryGroup = {
  id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; sortOrder: number;
  setsPrice: boolean; allowHalves: boolean; halfPricePercent: number; isFollowUp: boolean;
  usedByItemCount: number; usedByItems: Array<{ id: string; name: string }>; options: LibraryOption[];
};
export type LibraryOptionBody = { name?: string; price?: number; isAvailable?: boolean; followUpGroupId?: string | null; externalCode?: string | null };
// [REVIEW-MENU-A S4-11] Every library call names the store whose library the window shows (x-vendor-id, captured when
// the window opened: a store switched meanwhile refuses it, SESSION_CHANGED, never writes into the other store).
// [REVIEW-MENU-B S3-5] Every library write says the tools edit sizes, halves and follow-ups (MENU_OPTIONS_V2).
type StoreId = string | null;
const json = (method: string, body?: object) => ({ method, ...(body === undefined ? {} : { body: withCapability(body) }) });
const inStore = (storeId: StoreId) => ({ storeId });
export const getLibrary = (storeId: StoreId) => apiFetch(`${V}/modifier-groups`, undefined, inStore(storeId)).then(data<LibraryGroup[]>);
export const createLibraryGroup = (storeId: StoreId, body: GroupBody & { name: string }) =>
  apiFetch(`${V}/modifier-groups`, json('POST', body), inStore(storeId)).then(data<LibraryGroup>);
export const updateLibraryGroup = (storeId: StoreId, id: string, body: GroupBody) =>
  apiFetch(`${V}/modifier-groups/${id}`, json('PUT', body), inStore(storeId)).then(data<LibraryGroup>);
export const deleteLibraryGroup = (storeId: StoreId, id: string) =>
  apiFetch(`${V}/modifier-groups/${id}`, json('DELETE'), inStore(storeId)).then(data<{ deleted: boolean; removedFromItems: number }>);
export const orderLibrary = (storeId: StoreId, ids: string[]) =>
  apiFetch(`${V}/modifier-groups/order`, json('PUT', { ids }), inStore(storeId)).then(data<{ ordered: number }>);
export const addLibraryOption = (storeId: StoreId, groupId: string, body: LibraryOptionBody & { name: string }) =>
  apiFetch(`${V}/modifier-groups/${groupId}/options`, json('POST', body), inStore(storeId)).then(data<LibraryOption>);
export const updateLibraryOption = (storeId: StoreId, id: string, body: LibraryOptionBody) =>
  apiFetch(`${V}/modifier-options/${id}`, json('PUT', body), inStore(storeId)).then(data<LibraryOption>);
export const deleteLibraryOption = (storeId: StoreId, id: string) =>
  apiFetch(`${V}/modifier-options/${id}`, json('DELETE'), inStore(storeId)).then(data<{ deleted: boolean }>);
export const attachLibraryGroup = (storeId: StoreId, id: string, itemIds: string[]) =>
  apiFetch(`${V}/modifier-groups/${id}/attach`, json('POST', { itemIds }), inStore(storeId)).then(data<{ attached: string[]; already: string[] }>);
export const detachLibraryGroup = (storeId: StoreId, id: string, itemIds: string[]) =>
  apiFetch(`${V}/modifier-groups/${id}/detach`, json('POST', { itemIds }), inStore(storeId)).then(data<{ detached: string[] }>);

/** [REVIEW-F #2142 S4-2, as the phone's #2141] The item or its section was deleted on another device: the server's
 *  "Category with id … not found" names an internal id, so the store reads this instead. */
export const ITEM_GONE_WORDS = 'This section or item was removed on another phone. Go back and open the menu again.';

/** [STORE-WORDS sweep] The same words in the store's kind, from the app's word list ("the menu" only for a restaurant). */
export { itemGoneWords };

/** Why the server refused, in its own words (a banned word, documents not yet checked). A refusal with no words for a
 *  person (the form's shape, a duplicate, a server fault) gives null, so the caller keeps its own sentence; a missing
 *  item or section says so in plain words. */
export function refusalWords(error: unknown, vendorType?: string | null): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === 'NOT_FOUND') return itemGoneWords(vendorType);
  if (error.code === 'VALIDATION_ERROR' || error.code === 'DUPLICATE' || error.code === 'INTERNAL_ERROR' || !error.message.trim()) return null;
  return error.message;
}

/** A photo sized in the browser before it is sent, like the phone app does (long edge 1280 px, JPEG): a few hundred
 *  KB instead of a multi-MB camera original. It is drawn upright (the camera's orientation applied, since the re-encode
 *  drops the EXIF that carried it) on white (JPEG has no transparency: a transparent PNG would otherwise turn black —
 *  REVIEW-F #2142 S3-1). Anything that cannot be sized (no canvas, a format the browser cannot draw, no 2D context) is
 *  sent as chosen — never dropped, never a blank image. The server still checks, scans and redraws every photo. */
export async function sizedPhoto(file: File, edge = 1280): Promise<{ blob: Blob; name: string }> {
  const original = { blob: file as Blob, name: file.name };
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return original;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 600_000) { bitmap.close?.(); return original; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return original; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    return blob && blob.size > 0 ? { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' } : original;
  } catch {
    return original;
  }
}
