'use client';

import { useEffect, useState, type ComponentType } from 'react';

/**
 * [WEB-APPBAR] What the layouts and the app's menus carry for "Get the app": next to nothing. The real code
 * (the phone bar's gate, the menus' store badges) is fetched after the page has loaded, so no page's first load
 * carries it; if it cannot be fetched, the page simply goes without it (no error screen, no retry loop).
 */
function useLater<P>(load: () => Promise<ComponentType<P>>, wanted: () => boolean): ComponentType<P> | null {
  const [Later, setLater] = useState<ComponentType<P> | null>(null);
  useEffect(() => {
    if (!wanted()) return;
    let alive = true;
    load().then((component) => { if (alive) setLater(() => component); }, () => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetched once per mount
  }, []);
  return Later;
}

/** The phone bar's gate (components/get-app-bar.tsx), fetched only on what may be a phone: never on a desktop. */
export function GetAppBarLater() {
  const Bar = useLater(
    () => import('./get-app-bar').then((module) => module.GetAppBar),
    () => /iPhone|iPod|Android/.test(navigator.userAgent) || window.matchMedia?.('(pointer: coarse)').matches === true,
  );
  return Bar ? <Bar /> : null;
}

/** The header's "Get the app" item, opened: the two badges (they show only once the stores switch is live). */
export function AppStoreLinksLater({ className = '' }: { className?: string }) {
  const Links = useLater(() => import('./app-store-links').then((module) => module.AppStoreLinks), () => true);
  return Links ? <Links className={className} /> : null;
}

/** The menus' "Get the app" heading and badges (they show only once the stores switch is live). */
export function GetTheAppLinksLater({ className = '' }: { className?: string }) {
  const Links = useLater(() => import('./app-store-links').then((module) => module.GetTheAppLinks), () => true);
  return Links ? <Links className={className} /> : null;
}
