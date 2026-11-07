'use client';

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
