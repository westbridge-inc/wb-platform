'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { StoreBadges, type StoreKey } from './store-badges';
import type { StorePlatform } from '@/lib/get-the-app';

/**
 * [WEB-APPBAR] The "Get the app" bar as a phone visitor sees it, loaded only once it may show
 * (components/get-app-bar.tsx decides when). It never blocks the page: no scrim, no focus grab, it sits
 * after the page in the reading order, and the page gets the bar's height back at its foot so nothing is
 * hidden under it. It sits above the tab bar and above a store's checkout button (globals.css .sw-appbar).
 *
 * The way to the app is the official badge of the visitor's own store (both badges on a phone whose store we
 * cannot tell). Tapping a badge or "Not now" keeps the bar away for 30 days. The bar does not animate: the
 * stores' badges are never animated.
 */
export const GET_APP_BAR_TEXT = 'Swift works best in the app: live tracking, taxi rides and faster ordering.';

const STORES: Record<StorePlatform, readonly StoreKey[]> = { ios: ['ios'], android: ['android'], unknown: ['ios', 'android'] };

const QUIET = 'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sm font-semibold text-[var(--swift-muted)] hover:text-[var(--swift-ink)]';

export function GetAppBarCard({ platform, onClose }: { platform: StorePlatform; onClose: () => void }) {
  const bar = useRef<HTMLElement | null>(null);
  const [clearance, setClearance] = useState(0);

  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const measure = () => setClearance(element.getBoundingClientRect().height);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element, { box: 'border-box' });
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const notNow = () => {
    // The bar goes from under the visitor's finger: keep their place on the page, not on the body.
    document.querySelector<HTMLElement>('#main')?.focus({ preventScroll: true });
    onClose();
  };

  return (
    <>
      <div aria-hidden="true" data-get-app-clearance style={{ height: clearance }} />
      <section ref={bar} role="region" aria-label="Get the Swift app" data-get-app-bar className="sw-appbar">
        <div className="mx-auto flex max-w-md flex-wrap items-center gap-x-2 gap-y-2 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-3 text-[var(--swift-ink)] shadow-[var(--swift-elevation-floating)]">
          <p className="min-w-0 flex-[1_1_12rem] text-sm leading-5">{GET_APP_BAR_TEXT}</p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <StoreBadges stores={STORES[platform]} onPick={onClose} bleed={false} />
            <button type="button" onClick={notNow} className={QUIET}>Not now</button>
          </div>
        </div>
      </section>
    </>
  );
}
