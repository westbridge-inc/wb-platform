'use client';

import type { ReactNode } from 'react';
import { useAppStoresLive } from '@/lib/use-web-ordering';

/**
 * [G11 · WEB-APPBAR] The one switch around every store badge: its children only once the web server's
 * SWIFT_APP_STORES switch says the apps are live in both stores (lib/launch-switch.ts), and `soon` (nothing, by
 * default) while it is off, while the answer is on its way, and if the question fails. The badges themselves are
 * drawn by the server (components/store-badges.tsx): this is the only part that runs in the browser.
 */
export function StoresLive({ children, soon = null }: { children: ReactNode; soon?: ReactNode }) {
  return <>{useAppStoresLive() ? children : soon}</>;
}
