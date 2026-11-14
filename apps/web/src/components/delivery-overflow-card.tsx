'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/auth';
import { storeKey, useStoreId } from '@/lib/store-scope';
import {
  DAY_NAMES,
  NEW_BUSY_WINDOW,
  OVERFLOW_MODE_OPTIONS,
  OVERFLOW_NOTE,
  OVERFLOW_TITLE,
  busyWindowProblem,
  usesBusyHours,
  type BusyWindow,
  type OverflowMode,
  type OverflowSetting,
} from '../../../mobile/src/modules/vendor/deliveryOverflow';

const PATH = '/api/v1/vendor/kitchen-overflow';

/**
 * [DT-OVERFLOW · owner 14 Nov 2026] "Swift riders when you're busy", as on the phone (DeliveryOverflowCard): a branch
 * connected to Dragontail chooses when its cash deliveries go to Swift riders instead of its own drivers. Rendered
 * only for an owner or manager and only when the server says the setting applies (`available`).
 */
export function DeliveryOverflowCard() {
  const storeId = useStoreId();
  const client = useQueryClient();
  const read = useQuery({
    queryKey: storeKey(storeId, 'kitchen-overflow'),
    queryFn: () => apiFetch(PATH).then((r) => r.data as OverflowSetting),
    retry: false,
  });
  const [mode, setMode] = useState<OverflowMode>('NONE');
  const [windows, setWindows] = useState<BusyWindow[]>([]);
  useEffect(() => {
    if (!read.data) return;
    setMode(read.data.mode);
    setWindows(read.data.busyHours ?? []);
  }, [read.data]);
  const save = useMutation({
    mutationFn: (body: { mode: OverflowMode; busyHours?: BusyWindow[] }) => apiFetch(PATH, { method: 'PUT', body: JSON.stringify(body) }),
    onSettled: () => client.invalidateQueries({ queryKey: storeKey(storeId, 'kitchen-overflow') }),
  });
  if (!read.data?.available) return null;

  const hours = usesBusyHours(mode);
  const problems = hours ? windows.map(busyWindowProblem) : [];
  const blocked = problems.some(Boolean) || (hours && windows.length === 0);
  const update = (i: number, patch: Partial<BusyWindow>) => setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  return (
    <section aria-label={OVERFLOW_TITLE} className="sw-card p-5">
      <p className="font-semibold">{OVERFLOW_TITLE}</p>
      <p className="sw-caption mt-1">{OVERFLOW_NOTE}</p>
      <fieldset className="mt-3 grid gap-2">
        <legend className="sr-only">When Swift riders take your deliveries</legend>
        {OVERFLOW_MODE_OPTIONS.map((option) => (
          <label key={option.mode} className={`flex min-h-11 cursor-pointer gap-3 rounded-lg border p-3 ${mode === option.mode ? 'border-[var(--swift-red)]' : 'border-[var(--swift-border)]'}`}>
            <input type="radio" name="delivery-overflow" value={option.mode} checked={mode === option.mode} onChange={() => setMode(option.mode)} className="mt-1" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{option.label}</span>
              <span className="sw-caption block">{option.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {hours && (
        <div className="mt-4 grid gap-3">
          <p className="text-sm font-semibold">Busy hours (Guyana time)</p>
          {windows.map((w, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-xs">Day
                <select aria-label={`Busy hours ${i + 1}: day`} value={w.day} onChange={(e) => update(i, { day: Number(e.target.value) })} className="min-h-11 rounded-lg border border-[var(--swift-border)] px-2 text-sm">
                  {DAY_NAMES.map((name, day) => <option key={name} value={day}>{name}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-xs">From
                <input aria-label={`Busy hours ${i + 1}: from`} value={w.start} onChange={(e) => update(i, { start: e.target.value })} placeholder="18:00" inputMode="numeric" className="min-h-11 w-24 rounded-lg border border-[var(--swift-border)] px-2 text-sm" />
              </label>
              <label className="grid gap-1 text-xs">To
                <input aria-label={`Busy hours ${i + 1}: to`} value={w.end} onChange={(e) => update(i, { end: e.target.value })} placeholder="21:00" inputMode="numeric" className="min-h-11 w-24 rounded-lg border border-[var(--swift-border)] px-2 text-sm" />
              </label>
              <button type="button" onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))} className="min-h-11 rounded-lg border border-[var(--swift-border)] px-3 text-sm font-semibold">Remove</button>
              {problems[i] && <p className="w-full text-[13px] text-[var(--swift-error)]">{problems[i]}</p>}
            </div>
          ))}
          {windows.length < 28 && (
            <button type="button" onClick={() => setWindows((ws) => [...ws, { ...NEW_BUSY_WINDOW }])} className="min-h-11 justify-self-start rounded-lg border border-[var(--swift-border)] px-4 text-sm font-semibold">Add busy hours</button>
          )}
          <p className="sw-caption">A window that ends before it starts runs past midnight (e.g. Friday 22:00 to 02:00).</p>
        </div>
      )}
      <button
        type="button"
        disabled={save.isPending || blocked}
        onClick={() => save.mutate({ mode, ...(hours ? { busyHours: windows } : {}) })}
        className="mt-4 min-h-11 rounded-lg bg-[var(--swift-red)] px-4 text-sm font-semibold text-white disabled:opacity-50"
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
      {save.isError && <p className="mt-2 text-[13px] text-[var(--swift-error)]">{save.error instanceof Error ? save.error.message : 'Couldn’t save — try again.'}</p>}
      {save.isSuccess && !save.isPending && <p className="mt-2 text-[13px] text-[var(--swift-muted)]">Saved.</p>}
    </section>
  );
}
