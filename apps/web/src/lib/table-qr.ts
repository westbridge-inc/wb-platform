/**
 * [WEB-APPBAR review · ruling: table QR = menu only] A visit that came from a table's QR code (`?src=qr` on a store
 * page, or a /qr/ address) never sees the bar, for the rest of the visit: kept for this page load, and for the tab
 * (session storage) where the browser keeps it.
 */
const QR_VISIT_KEY = 'swift.qr-visit';
let qrVisitThisLoad = false;

export function noteQrVisit(pathname: string | null | undefined, search: string): void {
  const path = pathname ?? '';
  const fromQr = path.startsWith('/qr/') || path === '/qr' || ((path.startsWith('/store/') || path.startsWith('/order/vendor/')) && new URLSearchParams(search).get('src') === 'qr');
  if (!fromQr) return;
  qrVisitThisLoad = true;
  try { sessionStorage.setItem(QR_VISIT_KEY, '1'); } catch { /* this page load only */ }
}

export function qrVisit(): boolean {
  if (qrVisitThisLoad) return true;
  try { return sessionStorage.getItem(QR_VISIT_KEY) === '1'; } catch { return false; }
}

/** Tests only: a fresh visit. */
export function forgetQrVisit(): void {
  qrVisitThisLoad = false;
  try { sessionStorage.removeItem(QR_VISIT_KEY); } catch { /* nothing kept */ }
}
