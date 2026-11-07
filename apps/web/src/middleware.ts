import { NextResponse, type NextRequest } from 'next/server';
import { ORDERING_COOKIE, webOrderingOpen } from '@/lib/web-ordering';
import { webOrderingState } from '@/lib/launch-switch';

/**
 * [WEB-APPBAR · owner 7 Nov 2026] The welcome front page, and who skips it.
 *
 * `/` is the site's welcome page (app/(marketing)/page.tsx): what Swift is, and four doors (Order, Sell, Deliver,
 * Drive). A RETURNING visitor goes straight to ordering (/order), decided here on the server so the welcome page
 * never flashes first. Returning means this browser has opened ordering before: every ordering page the server
 * answers (below) sets ORDERING_COOKIE, a first-party "1" with no person, account or tracking in it. A customer's
 * sign-in lands on ordering (/order), so a signed-in customer carries it too (lib/web-ordering.ts ORDERING_COOKIE). (Their session cookies belong to the
 * API's own host and are never sent to this site, so the site cannot read them.) An installed app's launch
 * (?source=pwa) goes to ordering as well. The welcome page stays one tap away for everyone: `/?welcome` (the
 * app's menus link it) is never redirected.
 */
const ORDERING_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/** The customer ordering app's own pages (the app shell): opening one is "having opened ordering". */
function isOrderingPage(pathname: string): boolean {
  return pathname === '/order' || pathname.startsWith('/order/')
    || ['/explore', '/market', '/cart', '/checkout', '/orders', '/courier', '/taxi', '/account'].some((path) => pathname === path || pathname.startsWith(`${path}/`))
    || pathname.startsWith('/store/');
}

/**
 * [Item 7] The pre-launch front door.
 *
 * Until the switch (lib/launch-switch.ts, read on every request) says ordering
 * is live on the PUBLIC site,
 * every way into ordering there — the home feed, store pages and their cart
 * and checkout, the customer's orders and account — is answered by the
 * "Launching soon" page instead, at the same address. The policy, company,
 * pricing and partner pages are not listed below, so they never pass through
 * here: the card bank, the app stores and new partners always see them.
 *
 * Staging, previews and local runs keep the full marketplace: the decision is
 * made per host (lib/web-ordering.ts), because one container may answer both
 * staging.swiftgy.com and swiftgy.com.
 */
export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  // The deletion instructions sit under /account but are public by policy
  // (Google Play requires them reachable without the app).
  if (pathname === '/account/delete') return NextResponse.next();
  if (!webOrderingOpen(request.headers.get('host'), webOrderingState())) {
    const frontDoor = request.nextUrl.clone();
    frontDoor.pathname = '/launching-soon';
    frontDoor.search = '';
    return NextResponse.rewrite(frontDoor);
  }
  if (pathname === '/') {
    const returning = request.cookies.get(ORDERING_COOKIE)?.value === '1' || searchParams.get('source') === 'pwa';
    if (returning && !searchParams.has('welcome')) {
      const ordering = request.nextUrl.clone();
      ordering.pathname = '/order';
      return NextResponse.redirect(ordering, 307);
    }
    return NextResponse.next();
  }
  const response = NextResponse.next();
  if (isOrderingPage(pathname) && request.cookies.get(ORDERING_COOKIE)?.value !== '1') {
    response.cookies.set(ORDERING_COOKIE, '1', {
      path: '/',
      maxAge: ORDERING_COOKIE_MAX_AGE_S,
      httpOnly: true,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https',
    });
  }
  return response;
}

export const config = {
  matcher: [
    '/',
    '/order/:path*',
    '/explore',
    '/market',
    '/cart',
    // [WEB-LAUNCH-CHECK F1] The checkout itself, and the selfie step it sends a
    // first-time buyer to, were real on swiftgy.com before launch.
    '/checkout/:path*',
    '/selfie',
    '/orders/:path*',
    '/courier',
    '/taxi',
    '/account/:path*',
    '/store/:path*',
    '/stores/:path*',
  ],
};
