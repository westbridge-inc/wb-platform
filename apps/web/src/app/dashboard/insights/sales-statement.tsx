'use client';

import { useState } from 'react';
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';
import { getSalesStatementPath } from '@/lib/store-insights-api';

/**
 * [WEB-INSIGHTS · audit B5] The app's "Get sales statement": the printable 30-day statement a store shows its
 * accountant (completed orders; the store's take is items less its own promotions). The server mints a short-lived
 * signed link (GET /vendor/sales-statement?link=1), opened in a new tab: the tab is opened on the click itself, so a
 * pop-up blocker allows it, and closed again if the link fails (the earner portal's statement button does the same).
 */
export function SalesStatementButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (busy) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('Your browser blocked the new tab. Allow pop-ups for Swift, then try again.'); return; }
    tab.opener = null;
    setBusy(true);
    setError(null);
    try {
      const path = await getSalesStatementPath();
      tab.location.href = `${BROWSER_API_ORIGIN}${path}`;
    } catch {
      tab.close();
      setError('Couldn’t open the statement — try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Sales statement" className="sw-card p-5">
      <h2 className="text-base font-semibold">Sales statement</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">The last 30 days of completed orders, ready to print or save for your accountant. It opens in a new tab.</p>
      <button type="button" onClick={() => void open()} disabled={busy} className="sw-btn sw-btn-md sw-btn-outline mt-4 disabled:opacity-60">
        {busy ? 'Opening…' : 'Get sales statement'}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{error}</p>}
    </section>
  );
}
