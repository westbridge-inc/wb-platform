import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetAppBar } from './get-app-bar';
import { GET_APP_BAR_TEXT } from './get-app-bar-card';
import { forgetLaunchAnswer } from '@/lib/use-web-ordering';
import {
  GET_APP_ENGAGED_MS, GET_APP_SNOOZE_KEY, GET_APP_SNOOZE_MS, forgetGetAppVisit, getAppBarAllowedOn, insideAnApp, isPhone, storePlatform,
} from '@/lib/get-the-app';
import { APP_STORE_URL, GOOGLE_PLAY_URL } from '@/lib/app-stores';

// ---------------------------------------------------------------------------
// [WEB-APPBAR · owner 7 Nov 2026] "Visitors to swiftgy.com should see the WEBSITE first, never be pushed
// into the app; then have a gentle option to get the app."
//
// On a phone only, never on first paint: after 10 s on the site or a scroll of half a screen, and only
// while the server's SWIFT_APP_STORES switch says the apps are live, a small bar at the bottom offers the
// app with the official badge of the phone's own store (both badges when we cannot tell); "Not now" keeps it
// away for 30 days (this visit only where the browser keeps nothing). Never on the cart, checkout,
// payment, sign-in, an order, an account or a legal page; never inside an app.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ pathname: '/' as string | null }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const ANDROID_WEBVIEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const OTHER_PHONE = 'Mozilla/5.0 (Mobile; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5';

const restores: Array<() => void> = [];
function override(target: object, key: string, descriptor: PropertyDescriptor) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restores.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}

/** A device: its browser's name, its touch points, and what the screen answers to media queries. */
function device(userAgent: string, { touchPoints = 5, media = {} as Record<string, boolean> } = {}) {
  override(navigator, 'userAgent', { get: () => userAgent });
  override(navigator, 'maxTouchPoints', { get: () => touchPoints });
  override(window, 'matchMedia', {
    value: (query: string) => ({ matches: media[query] ?? false, media: query, addEventListener() {}, removeEventListener() {} }),
  });
}

let launchQuestions = 0;
/** The web server's stores switch, as /api/launch-state answers it. */
function storesSwitch(appStores: 'live' | 'soon') {
  launchQuestions = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/api/launch-state')) {
      launchQuestions += 1;
      return new Response(JSON.stringify({ webOrdering: 'live', appStores }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }));
}

function openAt(url: string) {
  (window as unknown as { happyDOM: { setURL(_u: string): void } }).happyDOM.setURL(url);
  state.pathname = new URL(url).pathname;
}

function page() {
  return render(<><main id="main" tabIndex={-1}><p>Page</p></main><GetAppBar /></>);
}

/** Time passes on the site; the server's answer and the bar's code arrive. */
async function wait(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); await new Promise((r) => setImmediate(r)); });
}

const bar = () => screen.queryByRole('region', { name: 'Get the Swift app' });
const storeLinks = () => [...(bar()?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  forgetLaunchAnswer();
  forgetGetAppVisit();
  openAt('https://swiftgy.com/');
  storesSwitch('live');
  override(window, 'scrollY', { configurable: true, writable: true, value: 0 });
  override(window, 'innerHeight', { configurable: true, writable: true, value: 800 });
});

afterEach(() => {
  vi.useRealTimers();
  for (const restore of restores.splice(0).reverse()) restore();
  openAt('http://localhost:3000/');
});

describe('[WEB-APPBAR] the website first: never on first paint, only after the visitor engages', () => {
  it('shows nothing (and asks nothing) before 10 s on the site, then the bar with the owner’s words', async () => {
    device(IPHONE);
    page();
    expect(bar()).toBeNull();
    await wait(GET_APP_ENGAGED_MS - 1);
    expect(bar()).toBeNull();
    expect(launchQuestions).toBe(0);
    await wait(1);
    expect(bar()).not.toBeNull();
    expect(bar()!.textContent).toContain(GET_APP_BAR_TEXT);
    // [WEB-APPBAR review] Only what is true of the app alone (the website already tracks orders live).
    expect(GET_APP_BAR_TEXT).toBe('Swift works best in the app: taxi rides, instant order alerts and faster ordering.');
    expect(GET_APP_BAR_TEXT).not.toMatch(/tracking/i);
  });

  it('a scroll of half a screen counts as engaged; a small one does not', async () => {
    device(ANDROID);
    page();
    await act(async () => { window.scrollY = 120; window.dispatchEvent(new Event('scroll')); });
    await wait(0);
    expect(bar()).toBeNull();
    await act(async () => { window.scrollY = 400; window.dispatchEvent(new Event('scroll')); });
    await wait(0);
    expect(bar()).not.toBeNull();
  });

  it('once engaged, the next page of the same visit need not wait again', async () => {
    device(IPHONE);
    const first = page();
    await wait(GET_APP_ENGAGED_MS);
    expect(bar()).not.toBeNull();
    first.unmount();
    page();
    await wait(0);
    expect(bar()).not.toBeNull();
  });
});

describe('[WEB-APPBAR] only while the stores switch is live', () => {
  it('never shows while the switch is off, however long the visitor stays', async () => {
    storesSwitch('soon');
    device(IPHONE);
    page();
    await wait(GET_APP_ENGAGED_MS * 3);
    expect(launchQuestions).toBe(1);
    expect(bar()).toBeNull();
  });

  it('never shows if the question fails, nor on staging or a local run (which never ask)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    device(IPHONE);
    let view = page();
    await wait(GET_APP_ENGAGED_MS);
    expect(bar()).toBeNull();
    view.unmount();

    for (const url of ['https://staging.swiftgy.com/', 'http://localhost:3000/']) {
      forgetLaunchAnswer();
      forgetGetAppVisit();
      storesSwitch('live');
      openAt(url);
      view = page();
      await wait(GET_APP_ENGAGED_MS);
      expect(bar(), url).toBeNull();
      expect(launchQuestions, url).toBe(0);
      view.unmount();
    }
  });
});

describe('[WEB-APPBAR] the way to the app is the official badge of the phone’s own store', () => {
  it('an iPhone gets the App Store badge, to the Guyana storefront', async () => {
    device(IPHONE);
    page();
    await wait(GET_APP_ENGAGED_MS);
    const link = screen.getByRole('link', { name: 'Download on the App Store' });
    expect(link.querySelector('img')?.getAttribute('src')).toBe('/badges/download-on-the-app-store.svg');
    expect(link.getAttribute('href')).toBe(APP_STORE_URL);
    expect(APP_STORE_URL).toBe('https://apps.apple.com/gy/app/swiftgy/id6815507102');
    expect(storeLinks()).toEqual([APP_STORE_URL]);
  });

  it('an Android phone gets the Google Play badge', async () => {
    device(ANDROID);
    page();
    await wait(GET_APP_ENGAGED_MS);
    const link = screen.getByRole('link', { name: 'Get it on Google Play' });
    expect(link.querySelector('img')?.getAttribute('src')).toBe('/badges/get-it-on-google-play.png');
    expect(link.getAttribute('href')).toBe(GOOGLE_PLAY_URL);
    expect(storeLinks()).toEqual([GOOGLE_PLAY_URL]);
  });

  it('a narrow touch screen whose store we cannot tell gets both badges', async () => {
    device(OTHER_PHONE, { media: { '(max-width: 47.4375rem)': true, '(pointer: coarse)': true } });
    page();
    await wait(GET_APP_ENGAGED_MS);
    expect(storeLinks()).toEqual([APP_STORE_URL, GOOGLE_PLAY_URL]);
  });

  it('tapping a badge keeps the bar away for 30 days too', async () => {
    device(ANDROID);
    page();
    await wait(GET_APP_ENGAGED_MS);
    fireEvent.click(screen.getByRole('link', { name: 'Get it on Google Play' }));
    expect(bar()).toBeNull();
    expect(localStorage.getItem(GET_APP_SNOOZE_KEY)).toBe(String(Date.now()));
  });
});

describe('[WEB-APPBAR] phones only, never inside an app', () => {
  it.each([
    ['a desktop', DESKTOP, {}, 0],
    ['an iPad', IPAD, {}, 5],
    ['an Android tablet', ANDROID_TABLET, {}, 5],
    ['a narrow desktop window (no touch)', DESKTOP, { '(max-width: 47.4375rem)': true }, 0],
    ['an Android web view', ANDROID_WEBVIEW, {}, 5],
    ['Swift installed from the browser', IPHONE, { '(display-mode: standalone)': true }, 5],
  ])('never on %s', async (_name, userAgent, media, touchPoints) => {
    device(userAgent, { media, touchPoints });
    page();
    await wait(GET_APP_ENGAGED_MS * 2);
    expect(bar()).toBeNull();
    expect(launchQuestions).toBe(0);
  });

  it('never inside the Swift app’s own web views', async () => {
    device(IPHONE);
    override(window, 'ReactNativeWebView', { value: { postMessage() {} } });
    page();
    await wait(GET_APP_ENGAGED_MS * 2);
    expect(bar()).toBeNull();
  });

  it('the pure checks agree', () => {
    expect(isPhone(IPHONE, false)).toBe(true);
    expect(isPhone(ANDROID, false)).toBe(true);
    expect(isPhone(ANDROID_TABLET, false)).toBe(false);
    expect(isPhone(IPAD, false)).toBe(false);
    expect(isPhone(DESKTOP, true)).toBe(true);
    expect(storePlatform(IPHONE, 5)).toBe('ios');
    expect(storePlatform(IPAD, 5)).toBe('ios');
    expect(storePlatform(ANDROID, 5)).toBe('android');
    expect(storePlatform(OTHER_PHONE, 5)).toBe('unknown');
    expect(insideAnApp(ANDROID_WEBVIEW, {}, false)).toBe(true);
    expect(insideAnApp(IPHONE, { ReactNativeWebView: {} }, false)).toBe(true);
    expect(insideAnApp(IPHONE, {}, true)).toBe(true);
    expect(insideAnApp(IPHONE, {}, false)).toBe(false);
  });
});

describe('[WEB-APPBAR] never on checkout, payment, sign-in, an order, an account or a legal page', () => {
  const NEVER = [
    '/cart', '/checkout', '/pay/mmg/return', '/pay/mmg/x/y', '/weekly-fee', '/login', '/login/otp', '/signup', '/selfie',
    '/orders', '/orders/o1', '/order/location', '/courier', '/account', '/account/addresses', '/account/delete', '/account-deleted',
    '/legal/terms', '/legal/privacy', '/legal/refunds', '/track/abc', '/trip/abc', '/qr/x', '/dashboard', '/portal', '/advertiser',
    '/safety-check', '/offline', '/store/kfc/checkout', '/unknown-new-page', '', null,
  ];
  const ALWAYS = [
    '/', '/order', '/order/browse', '/order/search', '/order/vendor/v1', '/store/kfc', '/store/kfc/', '/explore', '/market', '/taxi',
    '/about', '/contact', '/drivers', '/faq', '/how-it-works', '/pricing', '/stores', '/stores/kfc', '/vendors', '/welcome', '/launching-soon',
  ];

  it('the allow-list: browsing and company pages only', () => {
    for (const path of NEVER) expect(getAppBarAllowedOn(path), String(path)).toBe(false);
    for (const path of ALWAYS) expect(getAppBarAllowedOn(path), path).toBe(true);
  });

  it.each(['/checkout', '/cart', '/login', '/legal/terms', '/orders/o1', '/pay/mmg/return'])('an engaged phone visitor on %s sees no bar', async (path) => {
    device(IPHONE);
    openAt(`https://swiftgy.com${path}`);
    page();
    await wait(GET_APP_ENGAGED_MS * 2);
    expect(bar()).toBeNull();
  });

  it('the bar goes when the visitor moves on to the checkout', async () => {
    device(IPHONE);
    const view = page();
    await wait(GET_APP_ENGAGED_MS);
    expect(bar()).not.toBeNull();
    state.pathname = '/checkout';
    view.rerender(<><main id="main" tabIndex={-1}><p>Page</p></main><GetAppBar /></>);
    expect(bar()).toBeNull();
  });

  it('the shell and the company pages carry it; the legal pages, partner consoles and sign-in do not', () => {
    const src = join(process.cwd(), 'src', 'app');
    for (const layout of ['(app)/layout.tsx', '(marketing)/layout.tsx', '(welcome)/layout.tsx']) {
      expect(readFileSync(join(src, layout), 'utf8'), layout).toMatch(/<GetAppBarLater \/>/);
    }
    for (const layout of ['legal/layout.tsx', 'dashboard/layout.tsx', 'portal/layout.tsx', 'login/layout.tsx', 'signup/layout.tsx', 'layout.tsx']) {
      expect(readFileSync(join(src, layout), 'utf8'), layout).not.toMatch(/GetAppBar/);
    }
  });
});

describe('[WEB-APPBAR review · ruling: table QR = menu only] never on a visit from a table’s QR code', () => {
  it.each(['/store/kfc?src=qr&c=AB12', '/order/vendor/v1?src=qr'])('an engaged phone visitor who scanned in (%s) sees no bar, there or on the next page', async (url) => {
    device(IPHONE);
    openAt(`https://swiftgy.com${url}`);
    const view = page();
    await wait(GET_APP_ENGAGED_MS * 2);
    expect(bar()).toBeNull();
    view.unmount();
    // The same visit moves on (the query is gone): still no bar.
    openAt('https://swiftgy.com/store/kfc');
    page();
    await wait(GET_APP_ENGAGED_MS * 2);
    expect(bar()).toBeNull();
    expect(sessionStorage.getItem('swift.qr-visit')).toBe('1');
  });

  it('the same store opened without the QR code offers the bar as usual', async () => {
    device(IPHONE);
    openAt('https://swiftgy.com/store/kfc?src=search');
    page();
    await wait(GET_APP_ENGAGED_MS);
    expect(bar()).not.toBeNull();
  });

  it('the pure check: a store or old store address with src=qr, or a /qr/ address, is a table-QR visit', async () => {
    const { noteQrVisit, qrVisit } = await import('@/lib/table-qr');
    for (const [path, search, expected] of [
      ['/store/kfc', '?src=qr', true], ['/order/vendor/v1', '?c=1&src=qr', true], ['/qr/AB12', '', true],
      ['/store/kfc', '?src=qrx', false], ['/', '?src=qr', false], ['/store/kfc', '', false],
    ] as const) {
      forgetGetAppVisit();
      noteQrVisit(path, search);
      expect(qrVisit(), `${path}${search}`).toBe(expected);
    }
  });
});

describe('[WEB-APPBAR] "Not now" means not now', () => {
  it('hides the bar, returns focus to the page, and keeps it away for 30 days', async () => {
    device(IPHONE);
    let view = page();
    await wait(GET_APP_ENGAGED_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(bar()).toBeNull();
    expect(document.activeElement?.id).toBe('main');
    expect(localStorage.getItem(GET_APP_SNOOZE_KEY)).toBe(String(Date.now()));
    view.unmount();

    // A new visit 29 days later: still away.
    forgetGetAppVisit();
    forgetLaunchAnswer();
    vi.setSystemTime(Date.now() + GET_APP_SNOOZE_MS - 24 * 60 * 60_000);
    view = page();
    await wait(GET_APP_ENGAGED_MS * 2);
    expect(bar()).toBeNull();
    view.unmount();

    // A visit after the 30 days: offered once more.
    forgetGetAppVisit();
    forgetLaunchAnswer();
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
    page();
    await wait(GET_APP_ENGAGED_MS);
    expect(bar()).not.toBeNull();
  });

  it('where the browser keeps nothing, it still shows, and "Not now" holds for the rest of the visit', async () => {
    const blocked = { getItem() { throw new DOMException('blocked', 'SecurityError'); }, setItem() { throw new DOMException('blocked', 'SecurityError'); } };
    override(window, 'localStorage', { get: () => blocked });
    override(globalThis, 'localStorage', { get: () => blocked });
    device(IPHONE);
    const first = page();
    await wait(GET_APP_ENGAGED_MS);
    expect(bar()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(bar()).toBeNull();
    first.unmount();
    // Another page of the same visit: not again.
    page();
    await wait(GET_APP_ENGAGED_MS * 2);
    expect(bar()).toBeNull();
  });
});

describe('[WEB-APPBAR] accessible and out of the way', () => {
  it('is a labelled region after the page, with 44 px targets, no focus grab, and the page’s foot kept clear', async () => {
    device(IPHONE);
    const view = page();
    const before = document.activeElement;
    await wait(GET_APP_ENGAGED_MS);
    const region = bar()!;
    expect(region.getAttribute('role')).toBe('region');
    expect(document.activeElement).toBe(before);
    // After the page in the reading and focus order.
    const main = view.container.querySelector('main')!;
    expect(main.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The badge's link is 60 px tall (the 40 px badge and its 10 px clear space); never under 44 px.
    expect(screen.getByRole('link', { name: 'Download on the App Store' }).className).toMatch(/\bmin-h-11\b/);
    expect(screen.getByRole('link', { name: 'Download on the App Store' }).className).toMatch(/\bp-\[10px\]/);
    expect(screen.getByRole('button', { name: 'Not now' }).className).toMatch(/min-h-11/);
    expect(screen.getByRole('button', { name: 'Not now' }).className).toMatch(/min-w-11/);
    expect(view.container.querySelector('[data-get-app-clearance]')).not.toBeNull();
    expect(region.className).toMatch(/\bsw-appbar\b/);
    // The stores' badges are never animated: the bar does not slide or fade in.
    expect(region.className).not.toMatch(/\bsw-in\b|animate-/);
  });

  it('the stylesheet lifts it above the tab bar and a store’s checkout button, and steps aside for the install card', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
    const rule = /\.sw-appbar \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position: fixed/);
    expect(rule).toMatch(/bottom: calc\(var\(--swift-dock, env\(safe-area-inset-bottom\)\) \+ 8px\)/);
    expect(css).toMatch(/\.swift-app:has\(\[data-floating-dock\]\) \.sw-appbar \{\s*bottom: calc\(var\(--swift-dock, 0px\) \+ var\(--swift-space-lg\) \+ var\(--swift-touch\) \+ var\(--swift-space-md\) \+ 8px\);/);
    expect(css).toMatch(/\.swift-app:has\(\[data-install-clearance\]\) \.sw-appbar/);
    const storefront = readFileSync(join(process.cwd(), 'src', 'components', 'storefront', 'storefront-experience.tsx'), 'utf8');
    expect(storefront).toMatch(/className=\{styles\.mobileDock\}\s*data-floating-dock/);
  });

  it('its code is not in any page’s first load: the layouts import only the small gate, which loads the bar on demand', () => {
    const gate = readFileSync(join(process.cwd(), 'src', 'components', 'get-app-bar.tsx'), 'utf8');
    const staticImports = gate.split('\n').filter((line) => /^import\s/.test(line)).join('\n');
    expect(staticImports).not.toMatch(/get-app-bar-card|app-stores/);
    expect(gate).toMatch(/lazyRetry\(\(\) => import\('\.\/get-app-bar-card'\)/);
  });
});
