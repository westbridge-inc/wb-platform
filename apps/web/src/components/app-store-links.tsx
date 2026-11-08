'use client';

import { useEffect, useRef, useState } from 'react';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';
import { useAppStoresLive } from '@/lib/use-web-ordering';
import { StoreBadges } from './store-badges';

/**
 * [G11] The App Store and Google Play links. They show only once the web
 * server's SWIFT_APP_STORES switch says the apps are live in both stores
 * (lib/launch-switch.ts): while it is off, while the answer is on its way, and
 * if the question fails, the site makes no store claim. Turning it on at
 * Release needs a site restart with the new setting, never a code change.
 *
 * [WEB-APPBAR] These are the browser's own (the site's menus, the FAQ's sentence). A server page draws the
 * official badges itself (components/store-badges.tsx: StoreBadgesWhenLive, GetTheAppSection, StoreButtons) and
 * ships only the switch around them.
 */

const INLINE_LINK = 'font-medium text-[var(--swift-red)] underline underline-offset-2';

/** The two official badges; nothing at all until the apps are live. */
export function AppStoreLinks({ className = '' }: { className?: string }) {
  const live = useAppStoresLive();
  if (!live) return null;
  return <StoreBadges className={className} />;
}

/**
 * [WEB-APPBAR] The site menus' "Get the app" item: a heading and the two store badges. Like the footer's
 * badges, nothing at all until the apps are live in both stores.
 */
export function GetTheAppLinks({ className = '' }: { className?: string }) {
  const live = useAppStoresLive();
  if (!live) return null;
  return (
    <section aria-label="Get the app" className={className}>
      <h2 className="sw-eyebrow">Get the app</h2>
      <StoreBadges className="mt-2" />
    </section>
  );
}

/** One sentence for running text: the promise while the apps are not live, the two links once they are. */
export function AppStoreSentence() {
  const live = useAppStoresLive();
  if (!live) return <>Store download links will appear here when available.</>;
  return (
    <>
      Get it on the{' '}
      <a className={INLINE_LINK} href={APP_STORE_URL}>App Store</a> or{' '}
      <a className={INLINE_LINK} href={GOOGLE_PLAY_URL}>Google Play</a>.
    </>
  );
}

/**
 * [WEB-APPBAR · owner, live page: the badges appear ONCE per page] The ordering app's rail keeps a plain "Get the
 * app" item instead of its own badge block (the page footer, where a page has one, carries the badges). The item
 * opens a small panel with the two badges side by side, beside the rail, so they never stack at mismatched widths
 * in its narrow column. Nothing until the stores switch is live. Escape, a second tap or a tap elsewhere closes it.
 * Loaded after the page (components/get-the-app-later.tsx), never in a page's first load. [perf] It lives in this
 * module, which the menus already load on demand, so it adds no chunk of its own.
 */
export function GetTheAppPopover({ className = '' }: { className?: string }) {
  const live = useAppStoresLive();
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!at) return;
    const onPointer = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setAt(null); };
    const onResize = () => setAt(null);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', onResize);
    return () => { document.removeEventListener('pointerdown', onPointer); window.removeEventListener('resize', onResize); };
  }, [at]);
  if (!live) return null;
  const toggle = () => {
    if (at) { setAt(null); return; }
    const rect = button.current?.getBoundingClientRect();
    setAt({ left: (rect?.right ?? 0) + 12, bottom: Math.max(12, window.innerHeight - (rect?.bottom ?? 0)) });
  };
  return (
    <div ref={box} className={className} onKeyDown={(event) => { if (event.key === 'Escape' && at) { setAt(null); button.current?.focus(); } }}>
      <button ref={button} type="button" aria-expanded={at !== null} aria-controls="rail-get-the-app" onClick={toggle}
        className="inline-flex min-h-8 items-center text-[13px] font-semibold leading-[18px] text-[var(--swift-ink)] hover:text-[var(--swift-red)]">
        Get the app
      </button>
      {at ? (
        <div id="rail-get-the-app" role="group" aria-label="Get the Swift app" style={{ left: at.left, bottom: at.bottom }}
          className="fixed z-50 w-max rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-3 shadow-[var(--swift-elevation-floating)]">
          <StoreBadges wrap={false} bleed={false} />
        </div>
      ) : null}
    </div>
  );
}
