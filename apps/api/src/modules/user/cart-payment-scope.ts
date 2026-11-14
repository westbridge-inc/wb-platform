import { createHmac } from 'node:crypto';
import { isProduction } from '../../utils/runtime-mode';

/**
 * [SEC-AUDIT 13 Nov 2026 · F1] The cart's payment `scope` is a change marker the app compares, so a
 * method chosen for one vendor set + destination never survives a change. Its input includes the
 * store's MMG number, which only the customer of an ACCEPTED order may see. A plain hash of it is
 * brute-forceable offline (there are only ~2 million Guyana mobiles), so the marker is KEYED with a
 * server secret the caller never has: same stability for the app, nothing recoverable from it.
 */
function scopeKey(): Buffer {
  const secret = process.env['JWT_SECRET'];
  if (!secret) {
    if (isProduction()) throw new Error('JWT_SECRET is required in production');
    return createHmac('sha256', 'swift-local-cart-scope-key-not-for-production').update('swift:cart-payment-scope:v1').digest();
  }
  return createHmac('sha256', secret).update('swift:cart-payment-scope:v1').digest();
}

/** 24 hex characters of an HMAC over the scope material; never a bare hash of a non-public value. */
export function cartPaymentScope(material: unknown): string {
  return createHmac('sha256', scopeKey()).update(JSON.stringify(material)).digest('hex').slice(0, 24);
}
