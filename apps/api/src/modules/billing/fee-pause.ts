import type { PrismaClient } from '@prisma/client';
import { mmgDisabled, mmgPushRailOn } from '../../providers/mmg/mmg-provider';
import { getMmgCheckoutProvider, mmgCheckoutEnabled } from '../../providers/mmg/mmg-checkout';
import { weeklyFeeCardLive } from '../../utils/card-rail';
import { feeCheckoutEveryPlatformOn } from './fee-checkout-switch';
import { cardCheckoutEveryPlatformOn } from './card-checkout-switch';

// ---------------------------------------------------------------------------
// [PROD-PATH] THE rule for "the weekly fee is paused" (coordinator ruling of
// 6 Oct 2026, applying the owner's 5 Oct "MMG off: bill the current week
// only; weeks Swift could not take payment are not back-billed"):
//
//   while a partner has NO live way to pay — no live MMG way to pay and no
//   live card rail (agent cash and admin top-ups are hidden) — their fee is
//   PAUSED, for EVERY billing method, cash included: no charge, no failure,
//   no dunning, no PAST_DUE or grace lapse, no suspension, no churn.
//
// It is decided by the SERVER's own switches only: the MMG driver, the MMG
// push rail, the MMG checkout and its per-platform switch, and the card-rail
// switches. Nothing a partner sets enters it — not their billing method, not
// whether they have a card on file (removing a card never pauses a fee), not
// anything their app sends. So it is the same answer for every partner on
// this server, and a partner can neither cause nor dodge it.
//
// [22 Oct, COORD ruling on REVIEW-M's note] MMG counts as a way to pay only
// when a partner can actually pay with it:
//   - the push rail is on (mmgPushRailOn: Swift sends the charge request;
//     never in production), OR
//   - the MMG checkout is truly live: MMG_CHECKOUT_ENABLED=1 with a complete
//     configuration (its provider loads), AND the per-platform switch
//     (billing.feeCheckout.platforms) is on for EVERY platform, since a
//     partner's app may be any of them.
// "MMG driver on" alone is not a way to pay: with the push rail off (as in
// production) and the checkout off, or killed on one platform, no partner
// could pay with MMG, so the fee is paused rather than failed toward a
// suspension nobody could pay their way out of. Production also refuses to
// boot MMG_DRIVER=live without MMG_CHECKOUT_ENABLED=1 (utils/boot-config.ts).
//
// The card rail counts as a live way to pay only when a partner can open it
// (cardPayPathLive):
//   - the server switches (weeklyFeeCardLive: v2 on, not killed, a real
//     provider taking real cards; never a test system — the simulator or a
//     provider's sandbox — which serves only listed test subscriptions), AND
//   - [Review #2453-B B-3] the card's own per-platform switch
//     (billing.cardCheckout.platforms, card-checkout-switch.ts) on for EVERY
//     platform, exactly as MMG's checkout counts: a partner's app may be any
//     of them, and iOS is OFF unless the row says "ios": true (Apple 3.1.1).
//     Before, live cards lifted the pause for everyone while an iOS partner
//     saw no card button: with MMG off they would have been billed, failed
//     and dunned with no way to pay.
// With it live, a partner can pay now by card on whatever app they use, so
// nobody is paused, MMG on or off. With the card off on any platform the
// pause is decided by MMG alone (paying by card still works where it is on).
//   - [CARDS-GO · owner 14 Nov 2026] And never while live cards serve only the
//     subscriptions listed in CARD_RAIL_LIVE_SUBSCRIPTIONS (the owner's own
//     account first, everyone after PowerTranz's go-live): weeklyFeeCardLive is
//     false then, so every partner who is not listed keeps exactly today's fee,
//     paused or not by MMG alone — never billed, failed or dunned toward a card
//     button they cannot see. One answer for the server, as always.
//
// This switch rule is one part of the persisted hold predicate in mmg-pause.
// Billing and both operate gates also wait for clock repair after switches return.
// ---------------------------------------------------------------------------

/** The switch row the MMG checkout's per-platform rule reads. */
export type PayPathReader = Pick<PrismaClient, 'platformConfig'>;

/** Every setting the MMG checkout's configuration is read from (providers/mmg/mmg-checkout.ts).
 *  fee-pause-pay-path.test.ts keeps this list equal to what that file reads. */
export const CHECKOUT_CONFIG_ENV = [
  'NODE_ENV', 'MMG_DRIVER', 'MMG_CHECKOUT_ENABLED', 'MMG_CHECKOUT_URL', 'MMG_CHECKOUT_MERCHANT_ID', 'MMG_CHECKOUT_CLIENT_ID',
  'MMG_CHECKOUT_MERCHANT_NAME', 'MMG_CHECKOUT_SECRET_KEY', 'MMG_CHECKOUT_RETURN_ORIGIN', 'MMG_CHECKOUT_PUBLIC_KEY',
  'MMG_CHECKOUT_PRIVATE_KEY', 'MMG_CHECKOUT_CREATION_ZONE',
] as const;
/** The last answer, with the exact settings it was computed from: the fee pause is read on hot paths
 *  (catalogue, order gates), and loading the live configuration parses two RSA keys. A setting that
 *  changes (a test, or a restart) misses the cache and is computed again. */
let configuredCache: { settings: readonly (string | undefined)[]; configured: boolean } | null = null;

/** Tests clear the remembered checkout-configuration answer. */
export function resetMmgCheckoutConfiguredCache(): void {
  configuredCache = null;
}

/** MMG_CHECKOUT_ENABLED=1 with a configuration its provider loads (never the disabled provider). */
function mmgCheckoutConfigured(env: Record<string, string | undefined>): boolean {
  if (!mmgCheckoutEnabled(env)) return false;
  const settings = CHECKOUT_CONFIG_ENV.map((name) => env[name]);
  if (configuredCache && configuredCache.settings.every((value, i) => value === settings[i])) return configuredCache.configured;
  let configured: boolean;
  try {
    configured = getMmgCheckoutProvider(env).driver !== 'disabled';
  } catch {
    configured = false; // an incomplete configuration is no way to pay (the boot guard refuses it first)
  }
  configuredCache = { settings, configured };
  return configured;
}

/** Can a partner pay the weekly fee with MMG on this server right now? */
export async function mmgPayPathLive(db: PayPathReader, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (mmgDisabled(env)) return false;
  if (mmgPushRailOn(env)) return true;
  if (!mmgCheckoutConfigured(env)) return false;
  return feeCheckoutEveryPlatformOn(db);
}

/** [B-3] Can a partner pay the weekly fee by card on this server right now, on EVERY platform? The server's card
 *  switches first (env only); the card's per-platform row is read, fresh, only when they say yes. */
export async function cardPayPathLive(db: PayPathReader, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (!weeklyFeeCardLive(env)) return false;
  return cardCheckoutEveryPlatformOn(db);
}

export async function noLivePayPath(db: PayPathReader, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (await cardPayPathLive(db, env)) return false;
  return !await mmgPayPathLive(db, env);
}
