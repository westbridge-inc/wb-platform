'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ChevronLeft, Store as StoreIcon } from 'lucide-react';
import { cancellationReasonWords, storeOrderStatusWords } from '@swift/types/src/order-words';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { getStores, money, type VendorOrder } from '@/lib/vendor-api';
import { fmtWhen } from '@/lib/vendor-hub';
import { HISTORY_FILTERS, getOrderHistory, historyRangeProblem, type OrderHistoryFilters } from '@/lib/order-history';
import { DataUnavailable } from '@/components/data-unavailable';
// [STORE-MONEY] The app's own reader of the store's money (plain file, imported as is).
import { ringMoney } from '../../../../../../mobile/src/modules/vendor/ringMoney';

// [PERF · size budget] This page shares nothing with the order board beyond what every console page already loads:
// no order window, no board chip, no modal. Each of those, shared or loaded on demand, either split the board's own
// files (the board grew by 2 kB) or added an entry to the chunk map every page of the site downloads (/login grew).
// A finished order's facts are shown in place instead; actions on an order stay on the board.

const field = 'min-h-11 w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 text-sm';

/** The phone's status pill words (its OrderStatusPill), never a status code. */
function StatusPill({ status }: { status: string }) {
  const done = status === 'DELIVERED' || status === 'COMPLETED';
  const dead = status === 'CANCELLED' || status === 'REFUNDED';
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${done ? 'bg-green-100 text-green-700' : dead ? 'bg-black/5 text-[var(--swift-muted)]' : 'bg-[var(--swift-red)]/10 text-[var(--swift-red)]'}`}>
      {storeOrderStatusWords(status)}
    </span>
  );
}

/** The phone's HistoryRow: number and status, then when · items · customer, and the store's own money. A tap shows
 *  the order's lines, the money lines and why it was cancelled, in place. */
function HistoryRow({ order, open, onToggle }: { order: VendorOrder; open: boolean; onToggle: () => void }) {
  const items = order.items?.length ?? 0;
  // [COORD 17 Oct] The first name only: the store is never shown a customer's last name.
  const customer = order.customer?.firstName?.trim();
  const status = (order.status || '').toUpperCase();
  const sm = ringMoney(order);
  const panel = `order-${order.id}-facts`;
  // The order window's own words for why it was cancelled (never the stored code).
  const cancelled = status === 'CANCELLED' ? cancellationReasonWords(order.cancellationReason, 'store') : null;
  return (
    <article className="sw-card min-w-0 p-4" aria-label={`Order ${order.orderNumber}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={panel} className="block w-full text-left">
        <span className="flex items-center justify-between gap-3">
          <span className="sw-label min-w-0 truncate font-bold">{order.orderNumber ? `#${order.orderNumber}` : 'Order'}</span>
          <StatusPill status={status} />
        </span>
        <span className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="sw-caption min-w-0 break-words">
            {fmtWhen(order.placedAt)}
            {items ? ` · ${items} item${items === 1 ? '' : 's'}` : ''}
            {customer ? ` · ${customer}` : ''}
          </span>
          {/* [STORE-MONEY] The store's own money on the order, never the customer's total with the rider's tip. */}
          <span className="sw-label inline-flex items-center gap-1 font-semibold">
            {money(sm.food)}
            <ChevronDown size={14} aria-hidden="true" className={`text-[var(--swift-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
          </span>
        </span>
      </button>
      {open && (
        <div id={panel} className="mt-3 space-y-1 border-t border-[var(--swift-border)] pt-3">
          {(order.items ?? []).map((line) => (
            <p key={line.id} className="sw-caption flex justify-between gap-3 text-[var(--swift-ink)]">
              <span className="min-w-0 break-words">{line.quantity}× {line.substituteName || line.name}</span>
              <span className="shrink-0">{money(line.totalCustomer)}</span>
            </p>
          ))}
          <p className="sw-caption pt-1 font-semibold text-[var(--swift-ink)]">{sm.longLabel}: {money(sm.food)}</p>
          {sm.notes.map((line) => <p key={line} className="sw-caption">{line}</p>)}
          {order.paymentMethod && <p className="sw-caption">{order.paymentMethod === 'MOBILE_MONEY' ? 'Paid by MMG' : order.paymentMethod === 'CASH' ? 'Cash' : 'Card'}</p>}
          {cancelled && <p className="sw-caption">{cancelled}</p>}
        </div>
      )}
    </article>
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
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<VendorOrder[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  // As the phone: free typing reaches the server's search 400 ms after the last key, from the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = searchInput.trim();
      // Only a changed search starts again from the first page (a "Load more" tapped meanwhile is kept).
      if (next === search) return;
      setSearch(next);
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput, search]);

  const rangeProblem = historyRangeProblem(from, to);
  const status = HISTORY_FILTERS[filter]?.status;
  const filters: OrderHistoryFilters = useMemo(() => ({
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }), [status, search, from, to]);

  const { manager } = useStoreRole();
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const storeName = stores.data?.stores?.find((s) => s.id === storeId)?.name;
  // Its own key (not the board's 'orders'): the store's live feed re-reads the board on every order event, and a
  // long history must not be re-read each time.
  const q = useQuery({
    queryKey: storeKey(storeId, 'order-history', JSON.stringify(filters), page),
    queryFn: () => getOrderHistory(filters, page),
    enabled: !!storeId && !rangeProblem,
    // As the phone (useVendorOrderHistory): the last answer stays up while the next one loads.
    placeholderData: (previous) => previous,
  });

  // As the phone: a first page replaces the list, a later one is added under it (any filter change starts again).
  useEffect(() => {
    if (!q.data || q.isPlaceholderData) return;
    const next = q.data;
    setRows((prev) => {
      if (next.page === 1) return next.orders;
      // A page read after a new order arrived can repeat the last row of the page before it: shown once.
      const seen = new Set(prev.map((o) => o.id));
      return [...prev, ...next.orders.filter((o) => !seen.has(o.id))];
    });
  }, [q.data, q.isPlaceholderData]);

  const changeFilter = (apply: () => void) => { apply(); setPage(1); };
  const total = q.data?.total ?? 0;
  const narrowed = !!(search || status || from || to);
  const firstPageShown = q.isSuccess && !q.isPlaceholderData && q.data.page === 1;
  // While the next page (or a new filter's first page) is on its way, the button stays and says so.
  const hasMore = q.isPlaceholderData || !!q.data?.hasNext;
  const refresh = () => {
    setPage(1);
    void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'order-history') });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/dashboard/orders" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-[var(--swift-red)]">
            <ChevronLeft size={16} aria-hidden="true" />Orders
          </Link>
          <h1 className="sw-title">Order history</h1>
        </div>
        <button type="button" onClick={refresh} className="sw-btn sw-btn-md sw-btn-outline">Refresh</button>
      </div>

      <div className="space-y-3">
        <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search order # or customer"
          aria-label="Search order # or customer" maxLength={100} autoCapitalize="none" className={field} />
        <div role="group" aria-label="Show orders" className="flex flex-wrap gap-2">
          {HISTORY_FILTERS.map((f, i) => (
            <button key={f.label} type="button" aria-pressed={i === filter} onClick={() => changeFilter(() => setFilter(i))}
              className={`sw-btn sw-btn-md ${i === filter ? '' : 'sw-btn-outline'}`}>{f.label}</button>
          ))}
        </div>
        <fieldset className="flex flex-wrap items-end gap-3">
          <legend className="sw-caption mb-1">Placed between (Guyana days)</legend>
          <label className="text-sm font-medium">From
            <input type="date" value={from} max={to || undefined} onChange={(e) => changeFilter(() => setFrom(e.target.value))} className={`${field} mt-1`} />
          </label>
          <label className="text-sm font-medium">To
            <input type="date" value={to} min={from || undefined} onChange={(e) => changeFilter(() => setTo(e.target.value))} className={`${field} mt-1`} />
          </label>
          {(from || to) && <button type="button" onClick={() => changeFilter(() => { setFrom(''); setTo(''); })} className="sw-btn sw-btn-md sw-btn-outline">Clear days</button>}
        </fieldset>
        {rangeProblem && <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">{rangeProblem}</p>}
        {/* Owners and managers can also take the orders away as a spreadsheet (the export is theirs alone, as on the server). */}
        {manager && <p className="sw-caption">Need a spreadsheet for your accounts? <Link href="/dashboard/insights" className="font-semibold text-[var(--swift-red)]">Export orders on Insights</Link>.</p>}
      </div>

      {!rangeProblem && q.data && storeName && (
        <p className="sw-caption flex items-center gap-2 font-semibold">
          <StoreIcon size={14} aria-hidden="true" className="text-[var(--swift-red)]" />
          {storeName} · {total} order{total === 1 ? '' : 's'}
        </p>
      )}

      {rangeProblem ? null : q.isLoading && rows.length === 0 ? (
        <div role="status" className="sw-skeleton h-24"><span className="sr-only">Loading your order history…</span></div>
      ) : q.isError && rows.length === 0 ? (
        // [WR-032] An outage is not "No orders yet".
        <DataUnavailable what="your order history" error={q.error} onRetry={() => void q.refetch()} />
      ) : firstPageShown && q.data.orders.length === 0 ? (
        <div className="sw-card p-6 text-center">
          <p className="font-semibold">{narrowed ? 'Nothing matches' : 'No orders yet'}</p>
          <p className="sw-caption mt-1">{narrowed ? 'Try a different filter, search or days.' : 'Completed and cancelled orders build your history here.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid items-start gap-3 wide:grid-cols-2">
            {rows.map((o) => <HistoryRow key={o.id} order={o} open={open === o.id} onToggle={() => setOpen((id) => (id === o.id ? null : o.id))} />)}
          </div>
          {q.isError && rows.length > 0 && <p role="alert" className="text-sm text-[var(--swift-red)]">Couldn’t load more orders. Try again.</p>}
          {hasMore ? (
            <button type="button" onClick={() => setPage((p) => p + 1)} disabled={q.isFetching}
              className="sw-btn sw-btn-md sw-btn-outline w-full disabled:opacity-60">
              {q.isFetching ? 'Loading…' : `Load more (${rows.length} of ${total})`}
            </button>
          ) : rows.length > 0 && !q.isFetching && (
            <p className="sw-caption flex items-center justify-center gap-2"><CheckCircle2 size={13} aria-hidden="true" />That’s everything</p>
          )}
        </div>
      )}
    </div>
  );
}
