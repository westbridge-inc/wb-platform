/**
 * [WEB-APPBAR · owner 7 Nov 2026 · COORD ruling: no new cookie] Who skips the welcome page at `/`.
 *
 * A browser that has opened ordering here before (the ordering app's frame records it: ORDERING_FLAG_KEY = "1"
 * in this site's own local storage, nothing else, no person, account or tracking) goes from `/` straight to
 * ordering at /order. So does an installed app's launch (`?source=pwa`). `/?welcome` always shows the welcome page.
 *
 * The decision runs in the browser BEFORE the page is painted: WELCOME_REDIRECT_SCRIPT is a tiny inline script in
 * every page's <head> (app/layout.tsx), allowed by the site's existing policy (script-src 'self' 'unsafe-inline';
 * lib/browser-api-origin.ts), which is not changed. On any other page, or for a new visitor, it does nothing, and
 * a new visitor's first paint waits for nothing else. No cookie is set: the server never sees the flag.
 */
export const ORDERING_FLAG_KEY = 'swift.ordering';

/** The ordering app's frame calls this on every ordering page it shows. Storage may be blocked: then nothing. */
export function rememberOrdering(): void {
  try { localStorage.setItem(ORDERING_FLAG_KEY, '1'); } catch { /* storage unavailable: the welcome page shows */ }
}

/**
 * Runs as written (no build step): bare `location` and `localStorage`, ES5, and every failure ends in "stay".
 * `?welcome` (with or without a value) keeps the welcome page; the query and the hash otherwise travel on to /order.
 */
export const WELCOME_REDIRECT_SCRIPT = `(function(){try{var l=location,q=l.search;if(l.pathname!=='/'||/[?&]welcome(=|&|$)/.test(q))return;if(/[?&]source=pwa(&|$)/.test(q)||localStorage.getItem('${ORDERING_FLAG_KEY}')==='1')l.replace('/order'+q+l.hash)}catch(e){}})();`;
