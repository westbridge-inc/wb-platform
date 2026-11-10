import { cardPaymentsState } from '@/lib/card-payments-state';

/**
 * [CARDS-SWITCH-ON · review #2465-B F4] Whether the public site may list Visa and Mastercard right now, as the API
 * says (lib/card-payments-state.ts), for the browser-side card marks (components/cards-live.tsx). Never cached here:
 * the server's own read is at most a minute old.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return Response.json({ cardPayments: await cardPaymentsState() }, { headers: { 'Cache-Control': 'no-store' } });
}
