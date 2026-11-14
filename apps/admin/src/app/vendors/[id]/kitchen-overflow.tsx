'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearMaybeInKitchen, fetchKitchenOverflow, fetchKitchenRoutes, setKitchenOverflow, tryKitchenLinkNow, type KitchenBusyWindow, type KitchenOverflowMode, type KitchenOverflowView } from '@/lib/api';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { MutationError } from '@/components/MutationError';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { gyDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [DT-OVERFLOW · owner 14 Nov 2026] On a Dragontail branch's page: when its cash deliveries go to Swift riders instead
// of its own drivers (the store's owner or manager sets the same in the app), and where its recent deliveries went.
// Shown only while the kitchen-system switch is on and the branch has a connection.
// ---------------------------------------------------------------------------

export const OVERFLOW_MODE_WORDS: Record<KitchenOverflowMode, string> = {
  NONE: 'Off: every delivery goes to Dragontail',
  AUTO_DRIVER_CHECK: 'When all its drivers are busy (asks Dragontail first)',
  BUSY_HOURS: 'During its busy hours',
  BOTH: 'Busy hours, then when all its drivers are busy',
};

export const ROUTE_REASON_WORDS: Record<string, string> = {
  OVERFLOW_OFF: 'overflow off',
  OUTSIDE_BUSY_HOURS: 'outside busy hours',
  DRIVER_FREE: 'a driver was free',
  DRIVER_CHECK_FAILED: 'driver check failed or timed out (safe default)',
  NO_SWIFT_RIDER_NEAR: 'no Swift rider near could carry it',
  SWIFT_RIDER_CHECK_FAILED: 'Swift rider check failed',
  OVERFLOW_CHECK_FAILED: 'overflow check failed (safe default)',
  DRIVER_CHECK_OFF: 'driver check switched off',
  LINK_OFFLINE: 'kitchen link offline: on the tablet, own driver',
  BUSY_HOURS: 'busy hours',
  NO_FREE_DRIVER: 'no free driver',
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const usesHours = (mode: KitchenOverflowMode) => mode === 'BUSY_HOURS' || mode === 'BOTH';
/** [round 2] The driver check's two choices wait for Dragontail's written confirmation (the server refuses them). */
const lockedMode = (mode: KitchenOverflowMode, available: boolean | undefined) => (mode === 'AUTO_DRIVER_CHECK' || mode === 'BOTH') && available !== true;

export function KitchenOverflowPanel({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ['kitchen-overflow', vendorId], queryFn: () => fetchKitchenOverflow(vendorId) });
  const setting = view.data?.data ?? null;
  const live = setting?.switchOn === true && setting.connected;
  const routes = useQuery({ queryKey: ['kitchen-routes', vendorId], queryFn: () => fetchKitchenRoutes(vendorId), enabled: live });
  const [mode, setMode] = useState<KitchenOverflowMode>('NONE');
  const [windows, setWindows] = useState<KitchenBusyWindow[]>([]);
  useEffect(() => {
    if (!setting) return;
    setMode(setting.mode);
    setWindows(setting.busyHours);
  }, [setting]);
  const save = useMutation({
    mutationFn: () => setKitchenOverflow(vendorId, { mode, ...(usesHours(mode) ? { busyHours: windows } : {}) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['kitchen-overflow', vendorId] }),
  });

  if (view.isError) return <QueryFailed error={view.error} what="the kitchen-system connection" onRetry={() => void view.refetch()} retrying={view.isFetching} />;
  // [follow-up · confirm review N-2] Orders Dragontail MAY also have are flagged exactly when the switch goes OFF: their
  // list (and its clear action, which the server allows with the switch off) shows whatever the switch says.
  if (!live) return setting && (setting.maybeInKitchen?.length ?? 0) > 0 ? <MaybeInKitchen vendorId={vendorId} setting={setting} /> : null;
  const update = (i: number, patch: Partial<KitchenBusyWindow>) => setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const rows = routes.data?.data ?? [];

  return (
    <section aria-labelledby="kitchen-overflow" className="mc-card space-y-3">
      <h2 id="kitchen-overflow" className="mc-label">Dragontail: Swift riders when the branch is busy</h2>
      {setting?.linkOfflineAt && (
        <div role="status" className="space-y-1">
          <p className="text-sm font-semibold">Kitchen link offline, orders on tablet (since {gyDate(setting.linkOfflineAt)}). Swift checks the link by itself, less often while it keeps failing (at most every 15 minutes).</p>
          <TryLinkNow vendorId={vendorId} />
        </div>
      )}
      {setting?.linkOnTrial && (
        <p role="status" className="text-sm">Kitchen link on trial: a check of the link worked, so orders go to Dragontail again. The outage ends when an order goes through; one more failure puts orders back on the tablet.</p>
      )}
      {setting?.driverCheck && (
        <p className="text-sm">Last driver check ({gyDate(setting.driverCheck.at)}): {setting.driverCheck.free == null ? `failed: ${setting.driverCheck.problem ?? 'no answer'}` : `${setting.driverCheck.free} free vehicle(s)`}</p>
      )}
      <p className="text-sm">Decided order by order, before sending: each cash delivery goes to Dragontail or to the Swift tablet and Swift riders, never both. Pickups always go to Dragontail.</p>
      <label className="grid gap-1 text-sm">When
        <select value={mode} onChange={(e) => setMode(e.target.value as KitchenOverflowMode)} className="rounded border px-2 py-1">
          {(Object.keys(OVERFLOW_MODE_WORDS) as KitchenOverflowMode[]).map((m) => {
            const locked = lockedMode(m, setting?.driverCheckAvailable);
            return <option key={m} value={m} disabled={locked}>{OVERFLOW_MODE_WORDS[m]}{locked ? ' (waiting for Dragontail to confirm its driver check)' : ''}</option>;
          })}
        </select>
      </label>
      {usesHours(mode) && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Busy hours (Guyana time; an end before the start runs past midnight)</p>
          {windows.map((w, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 text-sm">
              <select aria-label={`Window ${i + 1}: day`} value={w.day} onChange={(e) => update(i, { day: Number(e.target.value) })} className="rounded border px-2 py-1">
                {DAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}
              </select>
              <input aria-label={`Window ${i + 1}: from`} value={w.start} onChange={(e) => update(i, { start: e.target.value })} className="w-20 rounded border px-2 py-1" />
              <input aria-label={`Window ${i + 1}: to`} value={w.end} onChange={(e) => update(i, { end: e.target.value })} className="w-20 rounded border px-2 py-1" />
              <button type="button" className="rounded border px-2 py-1" onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          {windows.length < 28 && <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setWindows((ws) => [...ws, { day: 5, start: '18:00', end: '21:00' }])}>Add busy hours</button>}
        </div>
      )}
      <button type="button" className="mc-btn" disabled={save.isPending || lockedMode(mode, setting?.driverCheckAvailable)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
      <MutationError error={save.error} label="Saving the overflow setting" />
      {setting && (setting.maybeInKitchen?.length ?? 0) > 0 && <MaybeInKitchen vendorId={vendorId} setting={setting} />}
      <h3 className="mc-label">Recent deliveries: where they went</h3>
      {routes.isError ? (
        <QueryFailed error={routes.error} what="the recent routes" onRetry={() => void routes.refetch()} retrying={routes.isFetching} />
      ) : routes.data && rows.length === 0 ? (
        <p className="text-sm">No delivery routed yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.id}>
              {r.orderNumber}: {r.kitchenRoute === 'SWIFT_RIDERS' ? 'Swift riders' : r.kitchenRoute === 'TABLET' ? 'tablet, own driver' : 'Dragontail'} ({ROUTE_REASON_WORDS[r.kitchenRouteReason ?? ''] ?? 'reason not recorded'}){r.kitchenRouteAt ? `, ${gyDate(r.kitchenRouteAt)}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * [round 3 · review B S4-8 · follow-up N-2/N-5] Tablet orders Dragontail MAY also have (the switch went off mid-send):
 * "Get a Swift rider" stays refused for them until operations confirm with the store. Clearing one asks for a confirm and
 * a reason (who confirmed it), recorded in the audit log. Shown whether the switch is on or off.
 */
function MaybeInKitchen({ vendorId, setting }: { vendorId: string; setting: KitchenOverflowView }) {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const clear = (orderId: string, orderNumber: string) => dialog.run({
    title: `Dragontail does not have order ${orderNumber}?`,
    body: <p>Confirm with the store first. If Dragontail does have it, a Dragontail driver and a Swift rider could both come for it.</p>,
    confirmLabel: 'Dragontail does not have it',
    reason: { label: 'Who confirmed it, and how', hint: 'For example: the manager checked the Dragontail screen. No customer details.' },
    submit: ({ reason }) => clearMaybeInKitchen(vendorId, orderId, reason),
    success: () => `Order ${orderNumber}: the store can get a Swift rider for it now.`,
  }).then(() => qc.invalidateQueries({ queryKey: ['kitchen-overflow', vendorId] }));
  return (
    <section aria-label="On the tablet, and maybe in Dragontail" className="mc-card space-y-1">
      <h3 className="mc-label">On the tablet, and maybe in Dragontail</h3>
      <p className="text-sm">The switch went off while these were being sent. &ldquo;Get a Swift rider&rdquo; stays refused for them until you confirm with the store that Dragontail does not have the order.</p>
      <ul className="space-y-1 text-sm">
        {(setting.maybeInKitchen ?? []).map((m) => (
          <li key={m.orderId} className="flex items-center gap-2">
            <span>{m.orderNumber}{m.fallbackAt ? `, on the tablet since ${gyDate(m.fallbackAt)}` : ''}</span>
            <button type="button" className="mc-btn" onClick={() => void clear(m.orderId, m.orderNumber)}>Dragontail does not have it</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** [follow-up · confirm review N-1] One probe of the offline link now (a login and an order read), with a reason; audited. */
function TryLinkNow({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const run = () => dialog.run({
    title: 'Try the kitchen link now?',
    body: <p>Swift logs in to Dragontail and reads its order list once. If that works, new orders go to Dragontail again; one more failure puts them back on the tablet.</p>,
    confirmLabel: 'Try the link now',
    reason: { hint: 'For example: Dragontail says the store is back. Kept on the record.' },
    submit: ({ reason }) => tryKitchenLinkNow(vendorId, reason),
    success: (r) => (r.data.linkOffline ? `Still offline: ${r.data.problem ?? 'Dragontail did not answer'}` : 'The link answered: orders go to Dragontail again, on trial.'),
  }).then(() => qc.invalidateQueries({ queryKey: ['kitchen-overflow', vendorId] }));
  return <button type="button" className="mc-btn" onClick={() => void run()}>Try the link now</button>;
}

