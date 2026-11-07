/**
 * [WEB-APPBAR · owner 7 Nov 2026] Website first, then a gentle way to the app.
 *
 * A visitor to swiftgy.com sees the website and is never pushed into the app. On a phone, once they have
 * spent a little time on the site (GET_APP_ENGAGED_MS) or scrolled a real way down a page, a small bar at
 * the bottom offers the app, with "Not now" that keeps it away for GET_APP_SNOOZE_MS. These are the pure
 * decisions behind that bar (components/get-app-bar.tsx); nothing here touches a person's data, and the
 * only thing kept in the browser is when "Not now" was pressed.
 */

/** How long a visitor is on the site before the bar may show. */
export const GET_APP_ENGAGED_MS = 10_000;
/** A scroll this far (as a share of the screen's height) also counts as engaged. */
export const GET_APP_SCROLL_SHARE = 0.5;
/** "Not now" (or a tap through to a store) keeps the bar away this long. */
export const GET_APP_SNOOZE_MS = 30 * 24 * 60 * 60_000;
export const GET_APP_SNOOZE_KEY = 'swift_get_app_bar';

/**
 * The pages where the bar may show: browsing and the company pages. It is an allow-list, so a page added
 * later stays quiet until it is named here. Never on the cart, checkout or payment, sign-in, sign-up or a
 * code, an MMG return, an order or its tracking, an account page, or a legal page (none of those is here).
 */
const EXACT = new Set([
  '/', '/order', '/order/browse', '/order/search', '/explore', '/market', '/taxi',
  '/about', '/contact', '/drivers', '/faq', '/how-it-works', '/pricing', '/stores', '/vendors', '/welcome',
  '/launching-soon',
]);
const UNDER = ['/store/', '/stores/', '/order/vendor/'];

export function getAppBarAllowedOn(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (EXACT.has(path)) return true;
  return UNDER.some((prefix) => path.startsWith(prefix) && path.length > prefix.length && !path.slice(prefix.length).includes('/'));
}

export type StorePlatform = 'ios' | 'android' | 'unknown';

/** Which store a "Get the app" tap opens. iPadOS reports a Mac; its touch screen tells it apart. */
export function storePlatform(userAgent: string, maxTouchPoints: number): StorePlatform {
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  return 'unknown';
}

/** A phone: an iPhone or Android phone by its browser's name, or any narrow touch screen. Never a tablet or a desktop. */
export function isPhone(userAgent: string, narrowTouchScreen: boolean): boolean {
  return /iPhone|iPod/.test(userAgent) || (/Android/.test(userAgent) && /Mobile/.test(userAgent)) || narrowTouchScreen;
}

/** Inside an app already: the Swift app's own web views, an Android web view, or Swift installed from the browser. */
export function insideAnApp(userAgent: string, win: { ReactNativeWebView?: unknown }, standalone: boolean): boolean {
  return win.ReactNativeWebView !== undefined || /;\s*wv\)/.test(userAgent) || standalone;
}

/** "Not now" this page load: kept even where the browser keeps nothing, so the bar shows at most once per visit. */
let notNowThisVisit = false;
/** The visitor engaged on an earlier page of this visit: the next page need not wait again. */
let engagedThisVisit = false;

export function snoozed(now: number): boolean {
  if (notNowThisVisit) return true;
  try {
    const saved = localStorage.getItem(GET_APP_SNOOZE_KEY);
    if (saved === null || !/^\d+$/.test(saved)) return false;
    const at = Number(saved);
    return now >= at && now - at < GET_APP_SNOOZE_MS;
  } catch {
    return false;
  }
}

export function snooze(now: number): void {
  notNowThisVisit = true;
  try { localStorage.setItem(GET_APP_SNOOZE_KEY, String(now)); } catch { /* storage blocked: this visit only */ }
}

export function engagedEarlier(): boolean {
  return engagedThisVisit;
}

export function markEngaged(): void {
  engagedThisVisit = true;
}

/** Tests only: a fresh visit. */
export function forgetGetAppVisit(): void {
  notNowThisVisit = false;
  engagedThisVisit = false;
}
