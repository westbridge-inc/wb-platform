'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ImageIcon, Star, ThumbsDown, ThumbsUp, UsersRound } from 'lucide-react';
import { storeKey } from '@/lib/store-scope';
import { getOps, getOverview, getRevenue, money } from '@/lib/vendor-api';
import { hasTrailingGuyanaDays, numericFact, reconciledRevenueDays, windowTotals, type RevenueDay } from '@/lib/vendor-hub';
import { photo } from '@/lib/media';
import {
  getBusyHours, getItemFeedback, getPopularItems, getRepeatCustomers, getStanding, getStoreReviews,
  type PopularItem, type StandingData,
} from '@/lib/store-insights-api';
// The app's own rules (plain files, imported as is).
import { insightsHeldView, type InsightsPair } from '../../../../../mobile/src/lib/insightsHeldView';
import { standingGroupNote } from '../../../../../mobile/src/components/standingNote';

// ---------------------------------------------------------------------------
// [WEB-INSIGHTS · audit B4] The phone's Insights screen (apps/mobile/src/modules/vendor/screens/
// VendorInsightsScreen.tsx), card by card, with its server reads and its words, laid out wider.
// Every card says when its read failed; none draws a failure as a zero.
// ---------------------------------------------------------------------------

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

const micro = 'text-[11px] font-semibold tracking-[0.08em] text-[var(--swift-muted)]';

/** The app's DeltaBadge: the change against the period before. */
function DeltaBadge({ cur, prev }: { cur: number; prev: number | null }) {
  if (prev == null) return null;
  if (prev <= 0) return cur > 0 ? <span className="text-[13px] font-semibold text-[var(--swift-success)]">new</span> : null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return <span className="text-[13px] font-semibold text-[var(--swift-muted)]">level</span>;
  const up = pct > 0;
  return <span className={`text-[13px] font-semibold ${up ? 'text-[var(--swift-success)]' : 'text-[var(--swift-muted)]'}`}>{up ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

function Card({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <section aria-label={label} className={`sw-card min-w-0 p-5 ${className}`}>{children}</section>;
}

/** The app's RevenueChart: today is the only loud bar; the sentence in its label is the summary a reader hears. */
function RevenueChart({ daily }: { daily: RevenueDay[] }) {
  const peak = Math.max(...daily.map((day) => day.revenue), 0);
  const scaleMax = Math.max(peak, 1);
  const today = daily.find((day) => day.isToday);
  const shortLabel = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? 'SMTWTFS'[new Date(`${value}T12:00:00Z`).getUTCDay()]! : value.slice(0, 1).toUpperCase());
  const dateLabel = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(`${value}T12:00:00Z`);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  };
  const gap = daily.length <= 7 ? 'gap-2' : daily.length <= 30 ? 'gap-1' : 'gap-px';
  return (
    <div role="img" aria-label={`Revenue trend for ${daily.length} days. Peak ${money(peak)}${today ? `. Today ${money(today.revenue)}` : ''}.`} className="mt-4">
      {today && daily.length > 7 && <p className="sw-caption mb-2 text-right font-semibold text-[var(--swift-ink)]">Today {money(today.revenue)}</p>}
      <div className={`flex h-40 items-end ${gap}`} aria-hidden="true">
        {daily.map((day) => (
          <div key={day.date} className="flex h-full min-w-0 flex-1 flex-col justify-end">
            {day.isToday && daily.length <= 7 && day.revenue > 0 && (
              <span className="sw-caption mb-1 block truncate text-center font-semibold text-[var(--swift-ink)]">{(Math.round(day.revenue / 100) / 10).toFixed(1).replace(/\.0$/, '')}k</span>
            )}
            <div
              className={`rounded-t-sm ${day.isToday && day.revenue > 0 ? 'bg-[var(--swift-red)]' : day.revenue > 0 ? 'bg-[var(--swift-red-50)]' : 'bg-[var(--swift-border)]'}`}
              style={{ height: `${Math.max(3, Math.round((day.revenue / scaleMax) * 100))}%` }}
            />
          </div>
        ))}
      </div>
      {daily.length <= 7 ? (
        <div className={`mt-2 flex ${gap}`} aria-hidden="true">
          {daily.map((day) => <span key={day.date} className={`flex-1 text-center text-xs ${day.isToday ? 'font-bold text-[var(--swift-red)]' : 'text-[var(--swift-muted)]'}`}>{shortLabel(day.date)}</span>)}
        </div>
      ) : (
        <div className="mt-2 flex justify-between text-xs text-[var(--swift-muted)]" aria-hidden="true">
          <span>{dateLabel(daily[0]!.date)}</span><span>peak {money(peak)}</span><span>{dateLabel(daily[daily.length - 1]!.date)}</span>
        </div>
      )}
    </div>
  );
}

function InsightMetric({ label, value, detail, badge }: { label: string; value: string; detail: string; badge?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-[var(--swift-sunken)] p-4">
      <div className="flex items-center justify-between gap-2"><p className={micro}>{label}</p>{badge}</div>
      <p className="sw-title mt-1 truncate">{value}</p>
      <p className="sw-caption mt-1">{detail}</p>
    </div>
  );
}

/**
 * "Revenue at a glance": the range switch (7 / 30 / 90 days), the revenue card with its chart and the change
 * against the days before, and the AVG ORDER / ACCEPTANCE / CANCELLED figures. As the app, double the window is read
 * so the change comes from the same real series (90 is the server's most: no earlier window at that depth), and a
 * range the series does not cover in full is refused rather than shown as a partial total.
 */
export function RevenueSection({ storeId, period, onPeriod }: { storeId: string; period: Period; onPeriod: (_p: Period) => void }) {
  const requestedDays = period === 90 ? 90 : period * 2;
  const overview = useQuery({ queryKey: storeKey(storeId, 'overview'), queryFn: getOverview, refetchInterval: 30_000 });
  const revenueQ = useQuery({ queryKey: storeKey(storeId, 'analytics', 'revenue', requestedDays), queryFn: () => getRevenue(requestedDays) });
  const opsQ = useQuery({ queryKey: storeKey(storeId, 'analytics', 'ops', period), queryFn: () => getOps(period) });
  const refetchRevenue = revenueQ.refetch;
  const revenueBehind = overview.dataUpdatedAt > 0 && overview.dataUpdatedAt > revenueQ.dataUpdatedAt;
  // As the app: a new overview (today's figure) brings the series up to it, so the two always agree.
  useEffect(() => {
    if (overview.dataUpdatedAt > 0) void refetchRevenue();
  }, [overview.dataUpdatedAt, requestedDays, refetchRevenue]);
  // [SPEED 30 Oct] The last pair that agreed stays up while the series catches up, never a new overview over an old series.
  const pair = useRef<InsightsPair | null>(null);
  const heldView = insightsHeldView(pair.current, { days: requestedDays, analytics: overview.data, revenue: revenueQ.data, behind: revenueBehind, revenueFailed: revenueQ.isError });
  pair.current = heldView.held;
  const checking = heldView.checking;
  const a = (checking ? checking.analytics : overview.data) as unknown;
  const daily = reconciledRevenueDays(checking ? checking.revenue : revenueQ.data, a, requestedDays);
  const hasFullWindow = hasTrailingGuyanaDays(daily, period);
  const w = windowTotals(daily, hasFullWindow ? period : 0);
  const aovCur = w.cur.orders != null && w.cur.orders > 0 ? w.cur.revenue / w.cur.orders : null;
  const aovPrev = w.prev?.orders != null && w.prev.orders > 0 ? w.prev.revenue / w.prev.orders : null;
  const acceptanceRate = numericFact(opsQ.data?.['acceptanceRate']);
  const cancellationRate = numericFact(opsQ.data?.['cancellationRate']);
  const placedOrders = numericFact(opsQ.data?.['placedOrders']);
  const primaryLoading = (overview.isLoading && !overview.data) || (revenueQ.isLoading && !revenueQ.data) || (revenueBehind && !revenueQ.isError && !checking);
  const primaryError = (overview.isError && !overview.data) || (revenueQ.isError && (!revenueQ.data || revenueBehind));
  const showingStale = (overview.isError && !!overview.data) || (revenueQ.isError && !!revenueQ.data);
  const opsDetail = opsQ.isLoading
    ? 'Loading this range'
    : opsQ.isError
      ? opsQ.data ? 'Last loaded · refresh failed' : 'Unavailable — try again'
      : placedOrders === 0 ? 'No placed orders' : placedOrders == null ? 'No rate reported' : `${placedOrders} placed order${placedOrders === 1 ? '' : 's'}`;
  const retry = () => { void overview.refetch(); void revenueQ.refetch(); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="sw-heading">Revenue at a glance</h2>
          <p className="sw-caption mt-1">Completed-order revenue. Swift never holds order money; cash and MMG settle peer-to-peer along the handoff.</p>
        </div>
        <div role="group" aria-label="Revenue range" className="inline-flex rounded-full bg-[var(--swift-sunken)] p-1">
          {PERIODS.map((p) => (
            <button key={p} type="button" aria-pressed={p === period} onClick={() => onPeriod(p)}
              className={`min-h-11 min-w-14 rounded-full px-4 text-sm font-semibold ${p === period ? 'bg-[var(--swift-card)] text-[var(--swift-ink)] shadow-sm' : 'text-[var(--swift-muted)]'}`}>{p}d</button>
          ))}
        </div>
      </div>

      {primaryLoading ? (
        <div role="status" className="sw-skeleton h-60"><span className="sr-only">Loading this revenue range…</span></div>
      ) : primaryError ? (
        // [WR-032] A failed read is never zero revenue: a zero is a business fact, not a connection state.
        <div role="status" className="sw-card p-5">
          <p className="text-sm">We couldn&apos;t load this revenue range. Check your connection and try again.</p>
          <button type="button" onClick={retry} className="sw-btn sw-btn-md sw-btn-outline mt-3">Try again</button>
        </div>
      ) : !hasFullWindow ? (
        <div role="status" className="sw-card p-5">
          <p className="text-sm">This revenue range is incomplete, so we won&apos;t present a partial total as the full period.</p>
          <button type="button" onClick={retry} className="sw-btn sw-btn-md sw-btn-outline mt-3">Try again</button>
        </div>
      ) : (
        <>
          <Card label="Revenue" className="p-6">
            <div className="flex items-center justify-between gap-3">
              <p className={micro}>REVENUE · LAST {period} DAYS</p>
              {w.prev && <DeltaBadge cur={w.cur.revenue} prev={w.prev.revenue} />}
            </div>
            <p className="mt-2 truncate text-4xl font-bold tracking-tight">{money(w.cur.revenue)}</p>
            <p className="sw-caption mt-1">{w.cur.orders == null ? 'Order count is not reported for this range.' : `${w.cur.orders} completed order${w.cur.orders === 1 ? '' : 's'} in this range.`}</p>
            {showingStale && <p className="sw-caption mt-2">Showing the last loaded figures — refresh did not complete.</p>}
            {w.curDaily.length > 0 && <RevenueChart daily={w.curDaily} />}
            {w.cur.revenue === 0 && <p className="sw-caption mt-3">No completed-order revenue landed in this range.</p>}
            {w.prev ? <p className="sw-caption mt-3">Change against the previous {period} days.</p>
              : period === 90 ? <p className="sw-caption mt-3">Prior-period comparison is available at 7 and 30 days.</p> : null}
          </Card>
          {/* The AOV change rides in its tile; acceptance and cancelled carry none (the server sends no earlier rates). */}
          <section aria-label="Order figures" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <InsightMetric label="AVG ORDER" value={aovCur == null ? '—' : money(aovCur)} detail={aovCur == null ? 'Needs order count' : `${period}d completed`}
              badge={aovCur != null && aovPrev != null ? <DeltaBadge cur={aovCur} prev={aovPrev} /> : undefined} />
            <InsightMetric label="ACCEPTANCE" value={acceptanceRate == null ? '—' : `${acceptanceRate}%`} detail={opsDetail} />
            <InsightMetric label="CANCELLED" value={cancellationRate == null ? '—' : `${cancellationRate}%`} detail={opsDetail} />
          </section>
        </>
      )}
    </div>
  );
}

/** The item's own photo, a 96 px copy through the store-photo route; only a photo Swift keeps (as the app draws it). */
function ItemPhoto({ url, name }: { url: string | null | undefined; name: string }) {
  const shot = photo(url);
  const src = shot?.loader ? shot.loader({ src: shot.src, width: 96 }) : null;
  return src
    // eslint-disable-next-line @next/next/no-img-element -- a 96 px copy from the store-photo route; next/image is not in the page's first load
    ? <img src={src} alt={`${name} photo`} loading="lazy" className="h-10 w-10 shrink-0 rounded-md object-cover" />
    : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[var(--swift-red-50)]"><ImageIcon size={14} aria-hidden="true" className="text-[var(--swift-muted)]" /></span>;
}

/** The app's TopItemsCard: MOST ORDERED · LIFETIME, with each item's quantity in the last 30 days. */
export function TopItemsCard({ storeId }: { storeId: string }) {
  const q = useQuery({ queryKey: storeKey(storeId, 'analytics', 'popular-items', 8), queryFn: () => getPopularItems(8) });
  const ranked = (q.data ?? []).filter((item: PopularItem) => (numericFact(item.totalOrdered) ?? 0) > 0 || (numericFact(item.recentOrders) ?? 0) > 0);
  return (
    <Card label="Most ordered">
      <p className={micro}>MOST ORDERED · LIFETIME</p>
      <p className="sw-caption mt-1">Ranked by all-time orders placed; the second count is quantity ordered in the last 30 days.</p>
      {q.isLoading && !q.data ? <p className="sw-caption mt-3">Loading item ranking…</p>
        : q.isError && !q.data ? (
          <div className="mt-3">
            <p className="sw-caption">Item ranking is unavailable right now.</p>
            <button type="button" onClick={() => void q.refetch()} className="sw-btn sw-btn-md sw-btn-outline mt-2">Retry</button>
          </div>
        ) : (
          <>
            {q.isError && <p className="sw-caption mt-2">Showing the last loaded item ranking — refresh did not complete.</p>}
            {q.isSuccess && ranked.length === 0 ? <p className="sw-caption mt-3">Your most-ordered items will rank here once orders come in.</p> : (
              <ol className="mt-2">
                {ranked.map((item, i) => (
                  <li key={item.id ?? `${item.name}-${i}`} className="mt-3 flex items-center gap-3">
                    <span className="w-6 shrink-0 text-base font-semibold text-[var(--swift-muted)]">{i + 1}</span>
                    <ItemPhoto url={item.imageUrl} name={item.name} />
                    <span className="min-w-0 flex-1">
                      <span className="sw-label block truncate font-semibold">{item.name}</span>
                      <span className="sw-caption block truncate">{item.category?.name ?? 'Catalogue item'}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      {numericFact(item.totalOrdered) != null && <span className="sw-label block font-semibold">{numericFact(item.totalOrdered)} orders</span>}
                      {numericFact(item.recentOrders) != null && <span className="sw-caption block">{numericFact(item.recentOrders)} ordered in 30d</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
    </Card>
  );
}

/** The app's OpsCard: how fast the store answers, how honest its preparation quote is, how often orders die. */
export function OpsCard({ storeId, period }: { storeId: string; period: Period }) {
  const q = useQuery({ queryKey: storeKey(storeId, 'analytics', 'ops', period), queryFn: () => getOps(period) });
  const ops = q.data;
  if (!ops || !numericFact(ops['placedOrders'])) return null;
  const n = (key: string) => numericFact(ops[key]);
  const prep = n('avgPrepMinutes');
  const quoted = n('avgQuotedPrepMinutes');
  const prepDelta = prep != null && quoted != null ? Math.round((prep - quoted) * 10) / 10 : null;
  const vendorCancellations = n('vendorCancellations') ?? 0;
  const tiles = [
    { value: n('acceptanceRate'), unit: '%', label: 'Acceptance' },
    { value: n('cancellationRate'), unit: '%', label: 'Cancelled' },
    { value: n('avgAcceptMinutes'), unit: 'm', label: 'To accept' },
  ].filter((t) => t.value != null);
  return (
    <Card label={`Operations · rolling ${period}d`}>
      <h3 className="font-bold">Operations · rolling {period}d</h3>
      {q.isError && <p className="sw-caption mt-1">Showing the last loaded operations figures — refresh did not complete.</p>}
      <div className="mt-3 grid grid-cols-3 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl bg-[var(--swift-sunken)] p-3 text-center">
            <p className="sw-title">{t.value}{t.unit}</p>
            <p className="sw-caption">{t.label}</p>
          </div>
        ))}
      </div>
      {prep != null && (
        <p className="sw-caption mt-3">
          Prep runs ~{prep} min{quoted != null ? ` against a ~${quoted} min quote` : ''}
          {prepDelta != null && prepDelta > 2 ? ' — quote a little more time so customers aren’t kept waiting.' : '.'}
        </p>
      )}
      {vendorCancellations > 0 && <p className="sw-caption mt-1">{vendorCancellations} cancelled by the store — keep stock and hours current to protect your rating.</p>}
    </Card>
  );
}

const fmtHour = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);

/** The app's BusyHoursCard: when the orders come in (Guyana hours, last 30 days). Hidden until it has an answer. */
export function BusyHoursCard({ storeId }: { storeId: string }) {
  const q = useQuery({ queryKey: storeKey(storeId, 'analytics', 'busy-hours'), queryFn: getBusyHours });
  const hours = q.data?.hours ?? [];
  if (!q.data || hours.length === 0) return null;
  const total = numericFact(q.data.total) ?? hours.reduce((sum, h) => sum + Number(h.orders ?? 0), 0);
  const peak = q.data.peak ?? hours.reduce((best, h) => (h.orders > best.orders ? h : best), hours[0]!);
  const max = Math.max(...hours.map((h) => h.orders), 1);
  const axis = hours.length <= 8 ? hours : [0, 0.25, 0.5, 0.75, 1].map((f) => hours[Math.round((hours.length - 1) * f)]!);
  return (
    <Card label="Busy hours">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">Busy hours</h3>
        {total > 0 && <span className="sw-caption">peak {fmtHour(peak.hour)}</span>}
      </div>
      {total === 0 ? <p className="sw-caption mt-2">Order times will map out here — staff up for the rush.</p> : (
        <>
          <div className="mt-3 flex h-20 items-end gap-1" aria-hidden="true">
            {hours.map((h) => (
              <div key={h.hour} className={`flex-1 rounded-t-sm ${h.orders > 0 ? 'bg-[var(--swift-red)]' : 'bg-[var(--swift-border)]'}`}
                style={{ height: `${Math.max(4, Math.round((h.orders / max) * 100))}%` }} />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-[var(--swift-muted)]" aria-hidden="true">
            {axis.map((h, i) => <span key={`${h.hour}-${i}`}>{fmtHour(h.hour)}</span>)}
          </div>
        </>
      )}
    </Card>
  );
}

/** The app's RepeatCustomersCard: customers with two or more finished orders here. Hidden until there are customers. */
export function RepeatCustomersCard({ storeId }: { storeId: string }) {
  const q = useQuery({ queryKey: storeKey(storeId, 'analytics', 'repeat-customers'), queryFn: getRepeatCustomers });
  const d = q.data;
  if (!d || (d.totalCustomers ?? 0) === 0) return null;
  const finished = d.totalOrders ?? 0;
  return (
    <Card label="Repeat customers">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 font-semibold"><UsersRound size={18} aria-hidden="true" className="text-[var(--swift-red)]" />Repeat customers</h3>
        <span className="font-bold">{d.repeatRate ?? 0}%</span>
      </div>
      <p className="sw-caption mt-1">{d.repeatCustomers ?? 0} of {d.totalCustomers} customers came back — {finished} finished order{finished === 1 ? '' : 's'}.</p>
    </Card>
  );
}

const BAND: Record<string, { label: string; tone: string }> = {
  EXCELLENT: { label: 'Excellent', tone: 'bg-[var(--swift-soft-success)] text-[var(--swift-success)]' },
  GOOD: { label: 'Good', tone: 'bg-[var(--swift-sunken)] text-[var(--swift-muted)]' },
  ATTENTION: { label: 'Needs attention', tone: 'bg-[var(--swift-red-50)] text-[var(--swift-red)]' },
  AT_RISK: { label: 'At risk', tone: 'bg-[var(--swift-soft-danger)] text-[var(--swift-error)]' },
  NEW: { label: 'New', tone: 'bg-[var(--swift-sunken)] text-[var(--swift-muted)]' },
};
const tagLine = (tags: StandingData['topPositive']) => tags.slice(0, 3).map((t) => `${t.label} ×${t.count}`).join(' · ');

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((s) => <Star key={s} size={12} className="text-amber-500" fill={value >= s - 0.25 ? 'currentColor' : 'none'} />)}
    </span>
  );
}

/** The app's StandingCard ("Store standing") and its item feedback list (Movement R9; daily-folded on the server). */
export function StandingSection({ storeId }: { storeId: string }) {
  const standingQ = useQuery({ queryKey: storeKey(storeId, 'standing'), queryFn: getStanding });
  const thumbsQ = useQuery({ queryKey: storeKey(storeId, 'analytics', 'item-feedback'), queryFn: getItemFeedback });
  const data = standingQ.data;
  const flagged = (thumbsQ.data ?? []).filter((r) => r.down > 0).slice(0, 5);
  const band = data ? BAND[data.standing] ?? BAND['NEW']! : null;
  const groupNote = data ? standingGroupNote(data.groupSize) : null;
  return (
    <>
      {data && band && (
        <Card label="Store standing">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">Store standing</h3>
            <span className={`whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold ${data.topRated ? BAND['EXCELLENT']!.tone : band.tone}`}>{data.topRated ? 'Top rated' : band.label}</span>
          </div>
          <div className="mt-3 flex items-end gap-6">
            <div>
              <p className="text-4xl font-bold">{data.displayRating == null ? 'New' : data.displayRating.toFixed(1)}</p>
              {data.displayRating == null
                ? <p className="sw-caption">Ratings appear after your first few jobs</p>
                : <p className="mt-1 flex items-center gap-2"><Stars value={data.displayRating} /><span className="sw-caption">{data.ratingBucket}</span></p>}
            </div>
            {/* The 13-week trend: the quiet line, no axes. */}
            <div className="flex h-7 flex-1 items-end gap-[3px]" aria-hidden="true">
              {(data.trend ?? []).map((w) => (
                <div key={w.weekStart} className={`flex-1 rounded-sm ${w.average != null ? 'bg-amber-500' : 'bg-[var(--swift-border)]'}`}
                  style={{ height: w.average != null ? `${Math.max(14, (w.average / 5) * 100)}%` : '10%' }} />
              ))}
            </div>
          </div>
          {groupNote && <p className="sw-caption mt-2">{groupNote}</p>}
          {data.topPositive?.length > 0 && <p className="sw-caption mt-3">Customers mention: {tagLine(data.topPositive)}</p>}
          {data.topNegative?.length > 0 && <p className="sw-caption mt-1">Watch for: {tagLine(data.topNegative)}</p>}
          {data.coaching?.length > 0 && (
            <div className="mt-3 space-y-2 rounded-xl border border-[var(--swift-border)] p-3">
              <p className="sw-caption font-semibold text-[var(--swift-ink)]">How to move it</p>
              {data.coaching.map((c) => <p key={c.tag} className="sw-caption">{c.label}: {c.line}</p>)}
            </div>
          )}
        </Card>
      )}
      {flagged.length > 0 && (
        <Card label="Item feedback — last 30 days">
          <h3 className="sw-label font-semibold">Item feedback — last 30 days</h3>
          <ul className="mt-2 space-y-1">
            {flagged.map((r) => (
              <li key={r.itemId} className="flex items-center justify-between gap-3">
                <span className="sw-caption min-w-0 truncate text-[var(--swift-ink)]">{r.name}</span>
                <span role="img" aria-label={`${r.down} thumbs down${r.up > 0 ? `, ${r.up} thumbs up` : ''}`} className="sw-caption flex shrink-0 items-center gap-1">
                  <ThumbsDown size={12} aria-hidden="true" />{r.down}
                  {r.up > 0 && <><span className="px-1">·</span><ThumbsUp size={12} aria-hidden="true" />{r.up}</>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/** The app's RatingsCard: the reviews' score spread as bars. Hidden until the store has a rating. The mean is taken
 *  from the same counts the bars draw (the server's own sum over its published reviews), never a stored lifetime
 *  figure: a store with no review shows no number at all. */
export function RatingsCard({ storeId, lifetimeOrders }: { storeId: string; lifetimeOrders: number | null }) {
  const q = useQuery({ queryKey: storeKey(storeId, 'reviews'), queryFn: getStoreReviews });
  const summary = q.data?.summary;
  const dist = summary?.distribution ?? {};
  const counts = [1, 2, 3, 4, 5].map((s) => Math.max(0, Number(dist[String(s)] ?? 0) || 0));
  const counted = counts.reduce((sum, n) => sum + n, 0);
  if (!summary || !summary.totalReviews || counted === 0) return null;
  const mean = counts.reduce((sum, n, i) => sum + n * (i + 1), 0) / counted;
  const max = Math.max(...counts, 1);
  return (
    <Card label="Ratings">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className={micro}>RATINGS</p>
        {lifetimeOrders != null && <span className="sw-caption">{lifetimeOrders} lifetime orders</span>}
      </div>
      <div className="flex gap-6">
        <div className="flex min-w-24 flex-col items-center justify-center">
          <p className="text-4xl font-bold">{mean.toFixed(1)}</p>
          <span className="mt-1"><Stars value={mean} /></span>
          <p className="sw-caption mt-1">{summary.totalReviews} rating{summary.totalReviews === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1" aria-hidden="true">
          {[5, 4, 3, 2, 1].map((s) => {
            const count = Number(dist[String(s)] ?? 0);
            return (
              <div key={s} className="flex items-center gap-2">
                <span className="sw-caption w-3 text-right">{s}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-sm bg-[var(--swift-border)]">
                  <span className={`block h-2 rounded-sm ${count > 0 ? 'bg-amber-500' : ''}`} style={{ width: `${Math.round((count / max) * 100)}%` }} />
                </span>
                <span className="sw-caption w-6">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
