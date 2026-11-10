import type { LaunchState } from '@/site.config';
import { guestRead } from '@/lib/browse-server';

/**
 * [CARDS-SWITCH-ON · review #2465-B F4] May the public site say partners can pay the weekly fee by Visa or
 * Mastercard? Only while the API says a partner can actually pay by card right now (GET /api/v1/public/capabilities
 * → cardPayments, decided by the server's own card switches: v2 on, not killed, the real provider, live cards, and
 * the card's platform switch). It follows the server: no build or site flag to flip, and the kill switch takes the
 * cards off the site within this short cache. Any failure, an unreadable answer, or the build (which asks nothing)
 * is 'soon': a card is never claimed on a guess.
 */
export const CARD_PAYMENTS_REVALIDATE_SECONDS = 60;

export async function cardPaymentsState(): Promise<LaunchState> {
  const read = await guestRead<{ cardPayments?: unknown }>(
    '/api/v1/public/capabilities', CARD_PAYMENTS_REVALIDATE_SECONDS, ['capabilities'],
    (data) => Boolean(data) && typeof data === 'object',
  );
  return read?.data.cardPayments === 'live' ? 'live' : 'soon';
}
