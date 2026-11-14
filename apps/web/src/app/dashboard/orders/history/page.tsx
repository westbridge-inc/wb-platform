'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronLeft, Store as StoreIcon } from 'lucide-react';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { getStores, money, type VendorOrder } from '@/lib/vendor-api';
import { fmtWhen } from '@/lib/vendor-hub';
import { HISTORY_FILTERS, getOrderHistory, historyRangeProblem, type OrderHistoryFilters } from '@/lib/order-history';
import { DataUnavailable } from '@/components/data-unavailable';
import { focusableIn } from '@/components/modal';
import { preloadedPart } from '@/lib/preloaded-part';
import { statusChip } from '../order-chip';
// [STORE-MONEY] The app's own reader of the store's money (plain file, imported as is).
import { ringMoney } from '../../../../../../mobile/src/modules/vendor/ringMoney';

// The order window, its own chunk fetched from mount (as on the board), drawn in the tap's frame.
const orderDetail = preloadedPart(() => import('../order-detail').then((module) => module.OrderDetail));

const field = 'min-h-11 w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 text-sm';

/** The phone's HistoryRow: number and status, then when · items · customer, and the store's own money. */
function HistoryRow({ order, onOpen }: { order: VendorOrder; onOpen: () => void }) {
  const items = order.items?.length ?? 0;
  // [COORD 17 Oct] The first name only: the store is never shown a customer's last name.
  const customer = order.customer?.firstName?.trim();
  const status = (order.status || '').toUpperCase();
  return (
    <button type="button" data-order-id={order.id} onClick={onOpen} aria-label={`Order ${order.orderNumber}`}
      className="sw-card block w-full p-4 text-left hover:outline hover:outline-1 hover:outline-[var(--swift-border-strong)]">
      <span className="flex items-center justify-between gap-3">
        <span className="sw-label min-w-0 truncate font-bold">{order.orderNumber ? `#${order.orderNumber}` : 'Order'}</span>
        {statusChip(status)}
      </span>
      <span className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="sw-caption min-w-0 break-words">
          {fmtWhen(order.placedAt)}
          {items ? ` · ${items} item${items === 1 ? '' : 's'}` : ''}
          {customer ? ` · ${customer}` : ''}
        </span>
        {/* [STORE-MONEY] The store's own money on the order, never the customer's total with the rider's tip. */}
        <span className="sw-label font-semibold">{money(ringMoney(order).food)}</span>
      </span>
    </button>
  );
}

/**
 * [WEB-HISTORY · audit B2 + C5] The store's Order history: the phone's VendorOrderHistoryScreen (search by order
 * number or customer, All / Delivered / Completed / Cancelled, "Load more" pages of 20) over the same server read,
 * plus a range of days. Every role the board serves may read it (the server's own rule for GET /vendor/orders).
 */
export default function OrderHistoryPage() {
  const storeId = useStoreId();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const OrderDetail = orderDetail.usePart(!!selected);
  const dialog = useRef<HTMLDivElement | null>(null);

  // As the phone: free typing reaches the server's search 400 ms after the last key.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const rangeProblem = historyRangeProblem(from, to);
  const status = HISTORY_FILTERS[filter]?.status;
  const filters: OrderHistoryFilters = useMemo(() => ({
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }), [status, search, from, to]);

  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const storeName = stores.data?.stores?.find((s) => s.id === storeId)?.name;
  // Its own key (not the board's 'orders'): the store's live feed re-reads the board on every order event, and a
  // long history must not be re-read page by page each time. Closing an order window re-reads it instead.
  const history = useInfiniteQuery({
    queryKey: storeKey(storeId, 'order-history', JSON.stringify(filters)),
    queryFn: ({ pageParam }) => getOrderHistory(filters, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasNext ? last.page + 1 : undefined),
    enabled: !!storeId && !rangeProblem,
  });

  const rows = useMemo(() => {
    const seen = new Set<string>();
    // A page read after a new order arrived can repeat the last row of the page before it: shown once.
    return (history.data?.pages ?? []).flatMap((page) => page.orders).filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
  }, [history.data]);
  const total = history.data?.pages.at(-1)?.total ?? 0;
  const narrowed = !!(search || status || from || to);

  const close = () => {
    setSelected(null);
    // An action in the window may have moved the order on (refunded, completed): the list says so.
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'order-history') });
  };
  useEffect(() => {
    if (!selected) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLButtonElement>('[aria-label="Close order detail"]')?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      const row = document.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(selected)}"]`);
      (row ?? (previousFocus?.isConnected ? previousFocus : null))?.focus();
    };
  }, [selected]);
  // The order window is a modal dialog: Tab and Shift+Tab stay inside it.
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const inside = focusableIn(dialog.current);
    if (!inside.length) return;
    const first = inside[0]!;
    const last = inside[inside.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="space-y-5">
      <div>
        <Link href="/dashboard/orders" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-[var(--swift-red)]">
          <ChevronLeft size={16} aria-hidden="true" />Orders
        </Link>
        <h1 className="sw-title">Order history</h1>
      </div>

      <div className="space-y-3">
        <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search order # or customer"
          aria-label="Search order # or customer" maxLength={100} autoCapitalize="none" className={field} />
        <div role="group" aria-label="Show orders" className="flex flex-wrap gap-2">
          {HISTORY_FILTERS.map((f, i) => (
            <button key={f.label} type="button" aria-pressed={i === filter} onClick={() => setFilter(i)}
              className={`sw-btn sw-btn-md ${i === filter ? '' : 'sw-btn-outline'}`}>{f.label}</button>
          ))}
        </div>
        <fieldset className="flex flex-wrap items-end gap-3">
          <legend className="sw-caption mb-1">Placed between (Guyana days)</legend>
          <label className="text-sm font-medium">From
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={`${field} mt-1`} />
          </label>
          <label className="text-sm font-medium">To
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={`${field} mt-1`} />
          </label>
          {(from || to) && <button type="button" onClick={() => { setFrom(''); setTo(''); }} className="sw-btn sw-btn-md sw-btn-outline">Clear days</button>}
        </fieldset>
        {rangeProblem && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{rangeProblem}</p>}
      </div>

      {!rangeProblem && history.data && storeName && (
        <p className="sw-caption flex items-center gap-2 font-semibold">
          <StoreIcon size={14} aria-hidden="true" className="text-[var(--swift-red)]" />
          {storeName} · {total} order{total === 1 ? '' : 's'}
        </p>
      )}

      {rangeProblem ? null : history.isLoading && rows.length === 0 ? (
        <div role="status" className="sw-skeleton h-24"><span className="sr-only">Loading your order history…</span></div>
      ) : history.isError && rows.length === 0 ? (
        // [WR-032] An outage is not "No orders yet".
        <DataUnavailable what="your order history" error={history.error} onRetry={() => void history.refetch()} />
      ) : history.isSuccess && rows.length === 0 ? (
        <div className="sw-card p-6 text-center">
          <p className="font-semibold">{narrowed ? 'Nothing matches' : 'No orders yet'}</p>
          <p className="sw-caption mt-1">{narrowed ? 'Try a different filter, search or days.' : 'Completed and cancelled orders build your history here.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 wide:grid-cols-2">
            {rows.map((o) => <HistoryRow key={o.id} order={o} onOpen={() => setSelected(o.id)} />)}
          </div>
          {history.isFetchNextPageError && <p role="alert" className="text-sm text-[var(--swift-red)]">Couldn’t load more orders. Try again.</p>}
          {history.hasNextPage ? (
            <button type="button" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}
              className="sw-btn sw-btn-md sw-btn-outline w-full disabled:opacity-60">
              {history.isFetchingNextPage ? 'Loading…' : `Load more (${rows.length} of ${total})`}
            </button>
          ) : rows.length > 0 && (
            <p className="sw-caption flex items-center justify-center gap-2"><CheckCircle2 size={13} aria-hidden="true" />That’s everything</p>
          )}
        </div>
      )}

      {selected && <div ref={dialog} className="sw-scrim items-start overflow-y-auto p-4 pt-[calc(env(safe-area-inset-top)_+_1rem)] wide:items-center" role="dialog" aria-modal="true" aria-label="Order details" onKeyDown={(e) => { if (e.key === 'Escape') close(); else trapTab(e); }}>
        <div className="relative max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-[var(--swift-canvas)]">
          {OrderDetail ? <OrderDetail id={selected} onClose={close} /> : (
            <div className="sw-card p-6 text-sm text-[var(--swift-muted)]">
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold text-[var(--swift-ink)]">Order detail</p>
                <button onClick={close} aria-label="Close order detail" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xl text-[var(--swift-muted)] hover:text-[var(--swift-ink)]">✕</button>
              </div>
              <p className="mt-3">Loading…</p>
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}
