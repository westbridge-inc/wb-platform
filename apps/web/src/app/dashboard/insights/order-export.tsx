'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { storeKey } from '@/lib/store-scope';
import { downloadOrdersCsv, getExportBranches, guyanaMonthStart, guyanaToday } from '@/lib/order-export';

const field = 'mt-1 w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-surface,transparent)] px-3 py-2 text-sm';

/**
 * [ORDER-EXPORT · owner 11 Nov 2026] "Export orders" on Insights (owners and managers, as the page itself): a range
 * of days (at most 366) and, when this login may export several branches, which one or all of them; downloads a CSV
 * for the accountant. [REVIEW-2485-B S4-7] The branches offered are exactly the ones the server lets this login
 * export (GET /orders/export/branches): an owner's every branch, a manager's managed stores ("All branches you
 * manage"). The server checks the role, the branches and the range again; its words are shown when it refuses.
 */
export function OrderExportCard({ storeId }: { storeId: string }) {
  const today = guyanaToday();
  const [from, setFrom] = useState(guyanaMonthStart());
  const [to, setTo] = useState(today);
  const [picked, setPicked] = useState<string | null>(null);
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const allowed = useQuery({ queryKey: storeKey(storeId, 'order-export-branches'), queryFn: getExportBranches });
  const branches = allowed.data?.branches ?? [];
  const several = branches.length > 1;
  const branch = picked ?? (branches.some((b) => b.id === storeId) ? storeId : branches[0]?.id ?? storeId);
  const allLabel = allowed.data?.scope === 'manager' ? 'All branches you manage' : 'All branches';
  const run = async () => {
    if (state.busy) return;
    if (!from || !to || from > to) {
      setState({ busy: false, error: 'Choose a start day on or before the end day.', done: false });
      return;
    }
    setState({ busy: true, error: null, done: false });
    try {
      await downloadOrdersCsv(storeId, { from, to, branch });
      setState({ busy: false, error: null, done: true });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error && e.message ? e.message : 'Couldn’t export the orders. Try again.', done: false });
    }
  };
  return (
    <section className="sw-card p-5" aria-labelledby="order-export-title">
      <h2 id="order-export-title" className="text-base font-semibold">Export orders</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        A spreadsheet (CSV) of the orders placed between the days you choose, for your accounts: times, payment, totals, who funded each discount, cancellations and refunds. No customer details. Up to 366 days.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="text-sm font-medium">
          Placed from
          <input type="date" className={field} value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Placed to
          <input type="date" className={field} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        {several && (
          <label className="text-sm font-medium">
            Branch
            <select className={field} value={branch} onChange={(e) => setPicked(e.target.value)}>
              {branches.map((s) => <option key={s.id} value={s.id}>{s.city ? `${s.name} · ${s.city}` : s.name}</option>)}
              <option value="all">{allLabel}</option>
            </select>
          </label>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={state.busy}
          className="rounded-lg border border-[var(--swift-border)] px-4 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)] disabled:opacity-60"
        >
          {state.busy ? 'Exporting…' : 'Export orders (CSV)'}
        </button>
        {state.done && <p role="status" className="text-sm text-[var(--swift-muted)]">Downloaded.</p>}
        {state.error && <p role="alert" className="text-sm text-[var(--swift-red)]">{state.error}</p>}
      </div>
    </section>
  );
}
