'use client';

import { addedBySwiftLine, photoAddedBySwiftLine } from '../../../../../mobile/src/lib/assistedSetupCopy';
// [MENU-SEARCH · owner 14 Nov 2026] The app's matcher: the same words find the same items on the phone and here.
import {
  CATALOGUE_FILTER_WORDS, CATALOGUE_SEARCH_PLACEHOLDER, filterCount, filterShownLine, isLowStockItem, itemCountLine, itemMatches, matchesFilter, noMatchLine,
  offeredFilters, searchTerms, type CatalogueFilter,
} from '../../../../../mobile/src/lib/catalogueSearch';
import { memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { getCategories, getItems, getProfile, getStores, money, setItemAvailability, setItemsAvailability, toAmount, updateItem, type CatalogItem, type VatClass } from '@/lib/vendor-api';
// [MENU-BULK] The app's words for several items at once (the same file the app's Menu tab reads).
import { bulkConfirmBody, bulkConfirmTitle, bulkResultLine, keepSelectable, selectAll, toggleSelected } from '../../../../../mobile/src/lib/bulkAvailability';
import { getStoreVat } from '@/lib/store-vat-read';
import { Pictogram } from '@/components/glyphs';
import { DataUnavailable } from '@/components/data-unavailable';
import { MutationNotice } from '@/components/mutation-notice';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useCatalogueName, yourCatalogue } from '@/lib/catalogue-name';
import { instantSwitch } from '@/lib/instant-toggle';
import { useStoreRole } from '@/lib/store-role';
import { lazyRetry } from '@/lib/chunk-retry';

// [CHAINS PR2] Drawn only for an empty menu of a business with more than one store (its code loads then).
const BranchMenuCopy = lazyRetry(() => import('@/components/branch-menu-copy'));

// [TAP-AUDIT 27 Oct · owner rule 11 Oct: the website copies the app] The app's item editor, section tools, delete ask,
// and the parts of a row shown only on a tap, in their own chunk: fetched in the background when the page mounts (once,
// tried a second time if it fails to arrive), so the first load does not carry them and the tap finds them here. A
// needed part that still fails goes to the page's error screen (as lib/preloaded-part does; inlined to keep this
// page's first load within its size ceiling).
type Tools = typeof import('./menu-tools');
let toolsHere: Tools | undefined;
let toolsLoad: Promise<Tools> | undefined;
const loadTools = () => (toolsLoad ??= import('./menu-tools').catch(() => new Promise<Tools>((resolve, reject) => {
  setTimeout(() => { import('./menu-tools').then(resolve, reject); }, 800);
})).then((tools) => (toolsHere = tools), (error: unknown) => { toolsLoad = undefined; throw error; }));
const menuTools = {
  usePart(needed: boolean): Tools | undefined {
    const [, arrived] = useState(0);
    const [failure, setFailure] = useState<{ error: unknown } | null>(null);
    useEffect(() => {
      if (toolsHere) return;
      let live = true;
      loadTools().then(() => { if (live) arrived((n) => n + 1); }, (error: unknown) => { if (live) setFailure({ error }); });
      return () => { live = false; };
    }, [needed]);
    if (toolsHere) return toolsHere;
    if (failure && needed) throw failure.error;
    return undefined;
  },
};
type Dialog = import('./menu-tools').MenuDialogState;
type VatPricing = import('./menu-tools').VatPricing;

/** [TAP-AUDIT] The item's own photo, as the app shows it (drawn by the tools chunk); none = the placeholder. */
function RowPhoto({ url }: { url: string | null | undefined }) {
  return url ? <RowThumb url={url} /> : <Pictogram name="food" size={26} />;
}
function RowThumb({ url }: { url: string }) {
  const tools = menuTools.usePart(true);
  return tools ? <tools.Thumb url={url} fallback={<Pictogram name="food" size={26} />} /> : <Pictogram name="food" size={26} />;
}
/** [REVIEW-F #2142 S4-1] As the app: an outside photo address is named for what it is (drawn by the tools chunk). */
function RowPhotoNote({ url }: { url: string }) {
  const tools = menuTools.usePart(true);
  return tools ? <tools.PhotoNote url={url} /> : null;
}
/** [STORE-VAT] The owner's VAT class select and its note, drawn by the tools chunk (only VAT-registered stores). */
function RowVat(props: { item: CatalogItem; vatRate: number; vatEffective: boolean; pending: boolean; onVatClass: (_id: string, _vatClass: VatClass) => void; vatBeforeVat?: boolean }) {
  const tools = menuTools.usePart(true);
  return tools ? <tools.VatSelect {...props} /> : null;
}
function VatNote() {
  const tools = menuTools.usePart(true);
  return tools ? <tools.VatNote /> : null;
}

/** [TAP-AUDIT] A row's own price box or stock adjuster, drawn from the tools chunk (fetched at mount) only on the row
 *  that opened it, so the page's first load carries neither and no other row draws again. */
function RowTool({ tool, item, onSave = () => undefined, onDone }: { tool: 'price' | 'stock'; item: CatalogItem; onSave?: (_price: number) => void; onDone: () => void }) {
  const tools = menuTools.usePart(true);
  if (!tools) return null;
  return tool === 'price' ? <tools.PriceEdit item={item} onSave={onSave} onDone={onDone} /> : <tools.StockAdjust item={item} onDone={onDone} />;
}

/** [IN-STORE-SALE] A tracked row's count, "Adjust stock" and the app's "Sold in store −1", drawn from the tools chunk
 *  (the count alone until it arrives). */
function RowStock({ item, onAdjust }: { item: CatalogItem; onAdjust: () => void }) {
  const tools = menuTools.usePart(true);
  const storeId = useStoreId();
  if (tools) return <tools.SaleStock item={item} storeId={storeId} onAdjust={onAdjust} />;
  // [REVIEW #2514 S4-3] The one Low stock rule (the "Low stock" button's and the app's).
  const low = isLowStockItem(item);
  return <>
    {low && <span className="font-semibold text-amber-700">Low stock</span>}
    <button onClick={onAdjust} className="sw-link-btn min-h-8">{item.stockQuantity} in stock · Adjust stock</button>
  </>;
}

/**
 * [SPEED 22 Oct] One item's row. Memoised: an in-stock tap, a background re-read or a key
 * typed in Search draws again only a row whose own facts changed (the read keeps unchanged
 * items as the same objects), not every row of the catalogue. Off-screen rows also skip
 * layout and paint until scrolled to (content-visibility), which long catalogues need.
 */
const ItemRow = memo(function ItemRow({ item: i, pending, pricePending, manager, adjusting, editingPrice, onToggle, onAdjust, onEditPrice, onPrice, onEdit, onDelete, onSaved, vatRate, vatEffective, vatPending, onVatClass, vatBeforeVat = false, selecting = false, selected = false, onSelect }: {
  /** [MENU-BULK] While the store is choosing several items: the row's tick. */
  selecting?: boolean;
  selected?: boolean;
  onSelect?: (_id: string) => void;
  item: CatalogItem;
  pending: boolean;
  pricePending: boolean;
  /** Owner or manager: the app's "Edit item" and "Delete" (staff switch items on and off only). */
  manager: boolean;
  onPrice: (_item: CatalogItem, _price: number) => void;
  onEdit: (_item: CatalogItem) => void;
  onDelete: (_item: CatalogItem) => void;
  adjusting: boolean;
  editingPrice: boolean;
  onToggle: (_id: string, _isAvailable: boolean) => void;
  onAdjust: (_id: string | null) => void;
  onEditPrice: (_id: string | null) => void;
  onSaved: () => void;
  /** Set only when the owner's store has told Swift it is VAT-registered: the item's VAT class is shown and can change. */
  vatRate: number | null;
  vatEffective: boolean;
  vatPending: boolean;
  onVatClass: (_id: string, _vatClass: VatClass) => void;
  /** [STORE-VAT-EXCLUSIVE] The store prices before VAT: its class words say VAT is added at checkout. */
  vatBeforeVat?: boolean;
}) {
  // The item's own photo, as the app shows it (a 96 px copy through the store-photo route); none = the placeholder.
  return <article aria-label={i.name} className="border-b border-[var(--swift-border)] py-5" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}>
    <div className="flex items-center gap-3">
      {selecting && <input type="checkbox" aria-label={`Select ${i.name}`} checked={selected} onChange={() => onSelect?.(i.id)} className="h-5 w-5 flex-none accent-[var(--swift-red)]" />}
      <span className="grid h-12 w-12 flex-none place-items-center overflow-hidden rounded-xl bg-[var(--swift-sunken)]">
        <RowPhoto url={i.imageUrl} />
      </span>
      <div className={`min-w-0 flex-1 ${i.isAvailable ? '' : 'opacity-60'}`}><h2 className="sw-label">{i.name}</h2><p className="sw-caption">{i.category?.name ?? 'Uncategorised'}</p>
        {i.catalogueCheck && <CatalogueCheckNote check={i.catalogueCheck} />}
        {/* [ASSISTED SETUP] Added by Swift with the store's OK: the store edits or replaces it as its own. */}
        {(i.addedBySwiftAt || i.photoAddedBySwiftAt) && <p className="sw-caption" data-testid="added-by-swift">{[i.addedBySwiftAt ? addedBySwiftLine(i.addedBySwiftAt) : null, i.photoAddedBySwiftAt ? photoAddedBySwiftLine(i.photoAddedBySwiftAt) : null].filter(Boolean).join(' · ')}</p>}
        {i.imageUrl && <RowPhotoNote url={i.imageUrl} />}
        {editingPrice ? <RowTool tool="price" item={i} onSave={(price) => onPrice(i, price)} onDone={() => onEditPrice(null)} /> : <button onClick={() => onEditPrice(i.id)} disabled={pricePending} className={`min-h-8 font-semibold hover:underline ${pricePending ? 'opacity-60' : ''}`}>{money(i.basePrice)}</button>}
      </div>
      <button role="switch" aria-label={`In stock: ${i.name}`} aria-checked={i.isAvailable} onClick={() => onToggle(i.id, !i.isAvailable)} disabled={pending}
        className="grid h-11 w-16 flex-none place-items-center disabled:opacity-60" title={i.isAvailable ? 'Live — customers can order it' : 'Hidden / sold out'}>
        <span className={`sw-stock-switch ${i.isAvailable ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border-strong)]'}`}><span className={`sw-stock-knob ${i.isAvailable ? 'translate-x-5' : ''}`} /></span>
      </button>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-[var(--swift-muted)]">
      {!i.isAvailable && <span>Sold out</span>}
      {i.stockQuantity == null ? <span>Stock untracked</span> : <RowStock item={i} onAdjust={() => onAdjust(adjusting ? null : i.id)} />}
      {i.sku && <span>SKU: {i.sku}</span>}
      {vatRate != null && <RowVat item={i} vatRate={vatRate} vatEffective={vatEffective} pending={vatPending} onVatClass={onVatClass} vatBeforeVat={vatBeforeVat} />}
    </div>
    {adjusting && <RowTool tool="stock" item={i} onDone={() => { onAdjust(null); onSaved(); }} />}
    {manager && (
      <div className="mt-3 flex gap-3">
        <button type="button" onClick={() => onEdit(i)} className="min-h-10 flex-1 rounded-full bg-[var(--swift-red-50)] text-sm font-semibold text-[var(--swift-red-600)]">Edit item</button>
        <button type="button" onClick={() => onDelete(i)} className="min-h-10 flex-1 rounded-full border border-[var(--swift-border)] text-sm font-semibold">Delete</button>
      </div>
    )}
  </article>;
});

export default function InventoryPage() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [chosenFilter, setFilter] = useState<CatalogueFilter | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [editingPrice, setEditingPrice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const catalogue = useCatalogueName();
  // Owner or manager edits the menu; staff switch items on and off (lib/store-role: the app's own matrix; unknown or
  // loading = staff). The store type names the editor's section hints and booking set-up.
  const { manager } = useStoreRole();
  const stores = useQuery({ queryKey: storeKey(storeId, 'my-role'), queryFn: getStores });
  const vendorType = (stores.data?.stores ?? []).find((st) => st.id === (storeId ?? stores.data?.selectedId))?.vendorType;
  const tools = menuTools.usePart(dialog !== null);

  const items = useQuery({ queryKey: storeKey(storeId, 'items', 'all'), queryFn: () => getItems() });
  const categories = useQuery({ queryKey: storeKey(storeId, 'categories'), queryFn: getCategories });

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'items') }), [queryClient, storeId]);
  // [STORE-VAT · owner O-5] The owner whose store told Swift it is VAT-registered gives each item its VAT class here.
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const isOwner = (profile.data as { myRole?: string } | undefined)?.myRole === 'OWNER';
  // [BOOK-S5b · owner A4] The selected store's word that "Confirm bookings automatically" can be chosen (switch on).
  const profileStores = (profile.data as { vendors?: Array<{ id: string; instantBookingAvailable?: unknown; vatAddsToPrices?: unknown; vatRatePercent?: unknown; vatPricesBeforeVat?: unknown }> } | undefined)?.vendors ?? [];
  const profileStore = profileStores.find((v) => v.id === storeId) ?? (profileStores.length === 1 ? profileStores[0] : undefined);
  const instantAvailable = profileStore?.instantBookingAvailable === true;
  // [VAT-DOCS · security review #2256] Whether VAT is added to this store's prices, for every role that edits the menu (the
  // profile, not the owner-only VAT read): one word for the before-VAT wording and the payload. null until it has loaded.
  // A store the profile does not list (or an older server): the bare price, which the server refuses if it is wrong.
  const vatPricing: VatPricing = profile.isSuccess
    ? {
      adds: profileStore?.vatAddsToPrices === true && typeof profileStore.vatRatePercent === 'number', ratePercent: Number(profileStore?.vatRatePercent) || 0,
      // [STORE-VAT-EXCLUSIVE] The store prices before VAT: labelled so, sent as typed (nothing is added into the price).
      beforeVat: profileStore?.vatPricesBeforeVat === true,
    }
    : null;
  const vat = useQuery({ queryKey: storeKey(storeId, 'vat'), queryFn: getStoreVat, enabled: isOwner });
  const vatRate = vat.data && vat.data.status !== 'NONE' ? vat.data.ratePercent : null;
  const vatEffective = vat.data?.effective === true;
  const vatMut = useMutation({
    mutationFn: (v: { id: string; vatClass: VatClass }) => updateItem(v.id, { vatClass: v.vatClass }),
    onSettled: () => void refresh(),
  });
  const setVat = vatMut.mutate;
  const onVatClass = useCallback((id: string, vatClass: VatClass) => setVat({ id, vatClass }), [setVat]);
  // [PERF row 562] An item's in-stock switch moves at the tap and goes back if the server refuses.
  // Only that item's switch waits for its answer: the others stay usable (they used to lock together).
  const availKey = ['item-availability', storeId];
  const availMut = useMutation({
    mutationKey: availKey,
    mutationFn: (v: { id: string; isAvailable: boolean }) => setItemAvailability(v.id, v.isAvailable),
    ...instantSwitch<{ id: string; isAvailable: boolean }, CatalogItem[]>(
      queryClient, storeKey(storeId, 'items', 'all'),
      (rows, v, undo) => rows.map((row) => (row.id === v.id ? { ...row, isAvailable: undo ? !v.isAvailable : v.isAvailable } : row)),
      // [#1936 S4-1] Only the last answer re-reads: a re-read while another item's change is
      // still on its way would show that item's old value for a moment. (This one still counts.)
      () => (queryClient.isMutating({ mutationKey: availKey }) > 1 ? undefined : refresh()),
    ),
  });
  const availPending = new Set(useMutationState({
    filters: { mutationKey: availKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id: string } | undefined)?.id,
  }));
  // [TAP-AUDIT] A new price shows on the row at the tap; only that row waits, the server's answer is written at once
  // and the list is read again once after the last answer. A refusal puts the old price back and says why.
  const priceKey = ['item-price', storeId];
  const priceMut = useMutation({
    mutationKey: priceKey,
    // [VAT-DOCS] An item Swift adds VAT to is priced by what the store types before VAT (the server adds the VAT).
    mutationFn: (v: { id: string; price: number; was: number | null; beforeVat: boolean }) => updateItem(v.id, v.beforeVat ? { vatListedPrice: v.price } : { basePrice: v.price }),
    ...instantSwitch<{ id: string; price: number; was: number | null; beforeVat: boolean }, CatalogItem[], { data?: { basePrice?: unknown; vatListedPrice?: unknown } }>(
      queryClient, storeKey(storeId, 'items', 'all'),
      (rows, v, undo) => rows.map((row) => (row.id !== v.id || v.beforeVat ? row : { ...row, basePrice: undo ? v.was : v.price })),
      () => (queryClient.isMutating({ mutationKey: priceKey }) > 1 ? undefined : refresh()),
      (rows, answer) => {
        const saved = answer?.data as { id?: string; basePrice?: unknown; vatListedPrice?: unknown } | undefined;
        return saved?.id ? rows.map((row) => (row.id === saved.id ? { ...row, basePrice: toAmount(saved.basePrice), vatListedPrice: toAmount(saved.vatListedPrice) } : row)) : rows;
      },
    ),
  });
  const pricePending = new Set(useMutationState({
    filters: { mutationKey: priceKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as { id: string } | undefined)?.id,
  }));
  const sendPrice = priceMut.mutate;
  const onPrice = useCallback((item: CatalogItem, price: number) => sendPrice({ id: item.id, price, was: item.basePrice, beforeVat: item.vatListedPrice != null }), [sendPrice]);
  const onEdit = useCallback((item: CatalogItem) => setDialog({ kind: 'item', item }), []);
  const onDelete = useCallback((item: CatalogItem) => setDialog({ kind: 'delete', item }), []);

  const soldOutCount = (items.data ?? []).filter((i) => i.isAvailable === false).length;
  const activeCount = Math.max(0, (items.data ?? []).length - soldOutCount);
  const sections = useMemo(() => categories.data ?? [], [categories.data]);
  const perSection = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items.data ?? []) if (i.category?.id) counts.set(i.category.id, (counts.get(i.category.id) ?? 0) + 1);
    return counts;
  }, [items.data]);

  // [SPEED 22 Oct] The search box answers each key at once; the list follows a moment later.
  const shownSearch = useDeferredValue(search);
  // [MENU-SEARCH] As in the app (lib/catalogueSearch): name, SKU and option names; any case, any accent; every word.
  const terms = useMemo(() => searchTerms(shownSearch), [shownSearch]);
  // [MENU-FILTERS · parity audit C1] The app's filter buttons: Sold out, Low stock (only when some item's stock is
  // counted, never a restaurant's), No photo. One at a time; pressed again, it is off.
  const filters = useMemo(() => offeredFilters(items.data ?? []), [items.data]);
  const filter = chosenFilter && filters.includes(chosenFilter) ? chosenFilter : null;
  const list = useMemo(() => {
    let rows = items.data ?? [];
    if (terms.length) rows = rows.filter((i) => itemMatches(i, terms));
    if (categoryId) rows = rows.filter((i) => i.category?.id === categoryId);
    if (filter) rows = rows.filter((i) => matchesFilter(i, filter));
    return rows;
  }, [items.data, terms, categoryId, filter]);
  // As in the app: the items under their section's heading, in the store's section order (an item whose section the
  // page does not know yet comes last, under no heading). With nothing filtered, an empty section shows too.
  const filtered = terms.length > 0 || filter !== null;
  // [REVIEW #2514 S4-2] As the app: while searching (or a button is on), each section chip counts its matches.
  const matchedPerSection = useMemo(() => {
    const counts = new Map<string, number>();
    let all = 0;
    for (const i of items.data ?? []) {
      if ((terms.length && !itemMatches(i, terms)) || (filter && !matchesFilter(i, filter))) continue;
      all += 1;
      if (i.category?.id) counts.set(i.category.id, (counts.get(i.category.id) ?? 0) + 1);
    }
    return { all, counts };
  }, [items.data, terms, filter]);
  const groups = useMemo(() => {
    const known = new Set(sections.map((c) => c.id));
    const out = sections.filter((c) => !categoryId || c.id === categoryId)
      .map((c) => ({ section: c as { id: string; name: string } | null, rows: list.filter((i) => i.category?.id === c.id) }))
      .filter((g) => g.rows.length > 0 || !filtered);
    const rest = list.filter((i) => !i.category?.id || !known.has(i.category.id));
    if (rest.length) out.push({ section: null, rows: rest });
    return out;
  }, [sections, list, categoryId, filtered]);
  // [MENU-BULK · parity audit C2] Several items at once, as the app: "Select" ticks rows; the bar at the bottom sends
  // them sold out or back on in ONE request, after asking; the answer is counted in the app's words. Any member of the
  // store (as the one-item switch).
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelected] = useState<Set<string>>(() => new Set());
  const [ask, setAsk] = useState<boolean | null>(null);
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const ticks = useMemo(() => keepSelectable(selectedIds, (items.data ?? []).map((i) => i.id)), [selectedIds, items.data]);
  const bulkMut = useMutation({
    mutationFn: (v: { itemIds: string[]; isAvailable: boolean }) => setItemsAvailability(v.itemIds, v.isAvailable),
    onSuccess: (answer, v) => { setBulkNote(bulkResultLine(answer, v.isAvailable)); setSelected(new Set()); setSelecting(false); },
    onSettled: () => void refresh(),
  });
  const onSelect = useCallback((id: string) => setSelected((s) => toggleSelected(s, id)), []);
  const sendBulk = () => {
    if (ask === null || ticks.size === 0 || bulkMut.isPending) return;
    const isAvailable = ask;
    setAsk(null);
    bulkMut.mutate({ itemIds: [...ticks], isAvailable });
  };
  const toggle = availMut.mutate;
  const onToggle = useCallback((id: string, isAvailable: boolean) => toggle({ id, isAvailable }), [toggle]);
  // [CHAINS PR2] An empty branch menu can start as a copy of another branch's; managers can export the menu as CSV.
  const storeList = stores.data?.stores ?? [];
  const emptyMenu = items.isSuccess && categories.isSuccess && (items.data ?? []).length === 0 && sections.length === 0;
  const [exportState, setExportState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const exportMenu = async () => {
    if (!storeId || exportState.busy) return;
    setExportState({ busy: true, error: null });
    try {
      await (await import('@/lib/menu-export')).downloadMenuCsv(storeId);
      setExportState({ busy: false, error: null });
    } catch (e) {
      setExportState({ busy: false, error: e instanceof Error && e.message ? e.message : `Couldn\u2019t export the ${catalogue.toLowerCase()}. Try again.` });
    }
  };

  return (
    <div className="space-y-5">
      <MutationNotice errors={[availMut.error, vatMut.error, priceMut.error]} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          {/* As in the app (VendorMenuScreen): the store type's name, then [F20] "Your <its name>" with live and sold-out counts. */}
          <h1 className="sw-title">{catalogue}</h1>
          <p className="sw-caption mt-1"><span className="font-semibold uppercase tracking-wide">{yourCatalogue(catalogue)}</span>{items.data && <> · <span>{activeCount} active · {soldOutCount} sold out</span></>}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/inventory/import"
            className="flex items-center gap-2 rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)]"
          >
            Bulk import CSV / Excel
          </Link>
          {manager && !emptyMenu && (
            <button type="button" disabled={exportState.busy} onClick={() => void exportMenu()}
              className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)]">
              {exportState.busy ? 'Exporting…' : `Export ${catalogue.toLowerCase()} (CSV)`}
            </button>
          )}
          {/* [MENU-OPTIONS · owner 11 Nov 2026] Shared option groups (sizes, crusts, toppings): built once, on many items. */}
          {manager && vendorType !== 'SERVICE' && (
            <button type="button" onClick={() => setDialog({ kind: 'library', items: (items.data ?? []).map((i) => ({ id: i.id, name: i.name, basePrice: i.basePrice, vatListedPrice: i.vatListedPrice })) })}
              className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)]">
              Option library
            </button>
          )}
          {manager && (
            <button type="button" disabled={!sections.length} onClick={() => setDialog({ kind: 'item', item: null })}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50">
              + Add item
            </button>
          )}
        </div>
      </div>
      {exportState.error && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{exportState.error}</p>}
      {manager && emptyMenu && storeId && storeList.length > 1 && (
        <Suspense fallback={null}>
          <BranchMenuCopy storeId={storeId} stores={storeList} onCopied={() => { void refresh(); void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'categories') }); }} />
        </Suspense>
      )}
      {manager && categories.isSuccess && !sections.length && <p className="sw-caption">Add a section first, then add individual items.</p>}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--swift-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={CATALOGUE_SEARCH_PLACEHOLDER}
            aria-label={CATALOGUE_SEARCH_PLACEHOLDER}
            className="w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] py-2 pl-9 pr-9 text-sm"
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => setSearch('')}
              className="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-[var(--swift-muted)] hover:bg-[var(--swift-subtle)]">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {filters.map((f) => (
          <button key={f} type="button" className="sw-chip" aria-pressed={filter === f} onClick={() => setFilter(filter === f ? null : f)}>
            {CATALOGUE_FILTER_WORDS[f]} · {filterCount(items.data ?? [], f)}
          </button>
        ))}
        <span className="text-sm text-[var(--swift-muted)]" aria-live="polite">{itemCountLine(list.length)}</span>
        <button type="button" className="sw-chip" aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setBulkNote(null); bulkMut.reset(); setAsk(null); }}>
          {selecting ? 'Done' : 'Select'}
        </button>
      </div>
      {bulkNote && <p role="status" className="text-sm font-semibold">{bulkNote}</p>}
      {/* The app's SECTIONS chips: every section with how many items it holds, then "Add section". */}
      <div className="sw-chip-row" aria-label="Sections">
        <button type="button" className="sw-chip max-w-64 truncate" aria-pressed={!categoryId} onClick={() => setCategoryId('')}>All · {filtered ? matchedPerSection.all : (items.data ?? []).length}</button>
        {sections.map((c) => <button key={c.id} type="button" className="sw-chip max-w-64 truncate" title={c.name} aria-pressed={categoryId === c.id} onClick={() => setCategoryId(c.id)}>{c.name} · {(filtered ? matchedPerSection.counts : perSection).get(c.id) ?? 0}</button>)}
        {manager && <button type="button" className="sw-chip" onClick={() => setDialog({ kind: 'section', mode: 'add', section: null })}>+ Add section</button>}
      </div>

      {items.isError && <DataUnavailable what={yourCatalogue(catalogue).toLowerCase()} error={items.error} onRetry={() => void items.refetch()} />}
      {categories.isError && <DataUnavailable what={`${yourCatalogue(catalogue).toLowerCase()} categories`} error={categories.error} onRetry={() => void categories.refetch()} />}
      {vat.isError && <DataUnavailable what="your VAT settings" error={vat.error} onRetry={() => void vat.refetch()} />}
      {vatRate != null && <VatNote />}
      {items.isLoading && <div className="sw-empty" role="status"><span className="sw-skeleton h-24 w-full" />Loading {yourCatalogue(catalogue).toLowerCase()}…</div>}
      {!items.isLoading && !items.isError && !list.length && <p className="sw-board-empty">{noMatchLine(terms.length ? shownSearch : '')}{filter ? ` ${filterShownLine(filter)}` : ''}</p>}
      {groups.map(({ section, rows }) => (
        <section key={section?.id ?? 'other'} aria-label={section?.name ?? 'Other items'}>
          {section && (
            <div className="flex items-center gap-2 border-b border-[var(--swift-border)] pb-2 pt-3">
              <h2 className="sw-label min-w-0 flex-1 truncate text-base font-bold">{section.name}</h2>
              <span className="sw-caption">{perSection.get(section.id) ?? 0} item{perSection.get(section.id) === 1 ? '' : 's'}</span>
              {manager && <button type="button" className="min-h-9 px-2 text-sm font-semibold text-[var(--swift-muted)]" aria-label={`Rename ${section.name}`} onClick={() => setDialog({ kind: 'section', mode: 'rename', section })}>Rename</button>}
              {manager && <button type="button" className="min-h-9 px-2 text-sm font-semibold text-[var(--swift-muted)]" aria-label={`Delete ${section.name}`} onClick={() => setDialog({ kind: 'section', mode: 'delete', section })}>Delete</button>}
            </div>
          )}
          {!rows.length && <p className="sw-caption py-3">No items yet.</p>}
          <div className="grid gap-x-8 wide:grid-cols-2">
            {rows.map(i => <ItemRow key={i.id} item={i} pending={availPending.has(i.id)} pricePending={pricePending.has(i.id)} manager={manager} adjusting={adjusting === i.id} editingPrice={editingPrice === i.id}
              onToggle={onToggle} onAdjust={setAdjusting} onEditPrice={setEditingPrice} onPrice={onPrice} onEdit={onEdit} onDelete={onDelete} onSaved={refresh}
              vatRate={vatRate} vatEffective={vatEffective} vatPending={vatMut.isPending && vatMut.variables?.id === i.id} onVatClass={onVatClass} vatBeforeVat={vatPricing?.beforeVat === true}
              selecting={selecting} selected={ticks.has(i.id)} onSelect={onSelect} />)}
          </div>
        </section>
      ))}
      {/* The app's footer words (VendorMenuScreen). */}
      {sections.length > 0 && (
        <p className="text-xs text-[var(--swift-muted)]">
          Sold-out items are hidden from new orders. They appear again when you switch them on. If a current order has an item
          you mark sold out, the customer is asked to choose a replacement or the item is marked for a refund. The business
          handles any money directly.
        </p>
      )}
      {selecting && (
        <section aria-label="Selected items" className="sticky bottom-0 z-10 space-y-2 border-t border-[var(--swift-border)] bg-[var(--swift-card)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 text-sm font-semibold" aria-live="polite">{`${ticks.size} selected`}</span>
            <button type="button" className="sw-chip" disabled={!list.length} onClick={() => setSelected((s) => selectAll(s, list.map((i) => i.id)))}>Select all shown</button>
            <button type="button" className="sw-chip" disabled={!ticks.size} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
          {bulkMut.error && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{bulkMut.error instanceof Error && bulkMut.error.message ? bulkMut.error.message : 'The items didn\u2019t change. Check your connection and try again.'}</p>}
          {ask !== null ? (
            <div role="dialog" aria-label={bulkConfirmTitle(ticks.size, ask)} className="space-y-2 rounded-lg bg-[var(--swift-subtle)] p-3">
              <p className="sw-label">{bulkConfirmTitle(ticks.size, ask)}</p>
              <p className="sw-caption">{bulkConfirmBody(ask)}</p>
              <div className="flex gap-2">
                <button type="button" onClick={sendBulk} className="min-h-10 flex-1 rounded-full bg-[var(--swift-red)] text-sm font-semibold text-white">{ask ? 'Yes, make available' : 'Yes, mark sold out'}</button>
                <button type="button" onClick={() => setAsk(null)} className="min-h-10 flex-1 rounded-full border border-[var(--swift-border)] text-sm font-semibold">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button type="button" disabled={!ticks.size || bulkMut.isPending} onClick={() => setAsk(false)} className="min-h-10 flex-1 rounded-full bg-[var(--swift-red)] text-sm font-semibold text-white disabled:opacity-50">Mark sold out</button>
              <button type="button" disabled={!ticks.size || bulkMut.isPending} onClick={() => setAsk(true)} className="min-h-10 flex-1 rounded-full border border-[var(--swift-border)] text-sm font-semibold disabled:opacity-50">Make available</button>
            </div>
          )}
        </section>
      )}
      {tools && dialog && <tools.MenuDialog dialog={dialog} storeId={storeId} sections={sections} counts={perSection} vendorType={vendorType}
        instantAvailable={instantAvailable} vatRate={vatRate} vatEffective={vatEffective} vatPricing={vatPricing} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** [GUARDRAILS §8] Why customers cannot see this item: Swift does not allow it, or a person is checking it. */
function CatalogueCheckNote({ check }: { check: NonNullable<CatalogItem['catalogueCheck']> }) {
  const reason = check.status === 'NOT_ALLOWED' && check.reason ? ` Reason: ${check.reason}` : '';
  return (
    <p role="status" className={`text-[13px] font-semibold ${check.status === 'NOT_ALLOWED' ? 'text-[var(--swift-red)]' : 'text-amber-700'}`}>
      {check.message}{check.status === 'WAITING_FOR_CHECK' ? ' — hidden from customers until Swift checks it.' : ''}{reason}
    </p>
  );
}
