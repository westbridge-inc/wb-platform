'use client';

import { Suspense, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { lazyRetry } from '@/lib/chunk-retry';
import { useAppStoresLive } from '@/lib/use-web-ordering';
import {
  GET_APP_ENGAGED_MS, GET_APP_SCROLL_SHARE, engagedEarlier, getAppBarAllowedOn, insideAnApp, isPhone, markEngaged, snooze, snoozed,
  storePlatform, type StorePlatform,
} from '@/lib/get-the-app';

/**
 * [WEB-APPBAR · owner 7 Nov 2026] The website comes first; the app is offered gently, on phones only.
 *
 * This part rides in the page and draws nothing. It waits until the visitor has engaged (time on the site
 * or a real scroll: never on first paint), and only on a phone, outside any app, on a browsing or company
 * page (lib/get-the-app.ts), with no "Not now" in the last 30 days. Only then does it ask whether the apps
 * are live in the stores (the same SWIFT_APP_STORES switch as the footer), and only once they are does the
 * bar's own code load, so it adds nothing to a page's first load.
 */
const GetAppBarCard = lazyRetry(() => import('./get-app-bar-card').then((module) => ({ default: module.GetAppBarCard })));

type Device = { platform: StorePlatform } | null;

export function GetAppBar() {
  const pathname = usePathname();
  const allowed = getAppBarAllowedOn(pathname);
  const [device, setDevice] = useState<Device>(null);
  const [engaged, setEngaged] = useState(false);
  const [closed, setClosed] = useState(false);

  // Which device this is, read once in the browser (the server never draws the bar).
  useEffect(() => {
    const userAgent = navigator.userAgent;
    const media = (query: string) => window.matchMedia?.(query).matches === true;
    const standalone = media('(display-mode: standalone)') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (insideAnApp(userAgent, window as { ReactNativeWebView?: unknown }, standalone)) return;
    if (!isPhone(userAgent, media('(max-width: 47.4375rem)') && media('(pointer: coarse)'))) return;
    if (snoozed(Date.now())) return;
    setDevice({ platform: storePlatform(userAgent, navigator.maxTouchPoints ?? 0) });
  }, []);

  // Engaged: GET_APP_ENGAGED_MS on the site, or a scroll of half a screen. Kept for the rest of the visit.
  useEffect(() => {
    if (!device || engaged) return;
    if (engagedEarlier()) { setEngaged(true); return; }
    const engage = () => { markEngaged(); setEngaged(true); };
    const timer = window.setTimeout(engage, GET_APP_ENGAGED_MS);
    const onScroll = () => { if (window.scrollY >= window.innerHeight * GET_APP_SCROLL_SHARE) engage(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.clearTimeout(timer); window.removeEventListener('scroll', onScroll); };
  }, [device, engaged]);

  if (!device || !engaged || !allowed || closed) return null;
  return <LiveBar platform={device.platform} onClose={() => { snooze(Date.now()); setClosed(true); }} />;
}

/** Asked only once the bar could show: nothing at all unless the server says the apps are live. */
function LiveBar({ platform, onClose }: { platform: StorePlatform; onClose: () => void }) {
  const live = useAppStoresLive();
  if (!live) return null;
  return (
    <Suspense fallback={null}>
      <GetAppBarCard platform={platform} onClose={onClose} />
    </Suspense>
  );
}
