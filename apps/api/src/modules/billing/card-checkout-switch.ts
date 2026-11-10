import type { PrismaClient } from '@prisma/client';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// The per-platform switch for paying the weekly fee by card, its own key so
// the card door can be closed on one platform without touching MMG's:
// {"ios": bool, "android": bool, "web": bool}. [Owner 6 Oct · Apple 3.1.1]
// iOS is OFF unless the row says `"ios": true`; Android and web are ON unless
// the row says `false`. [DS633, as MMG's switch] Only a real boolean counts:
// any other value for a platform switches that platform OFF, and a row that is
// not an object switches every platform OFF, each with a warning, so a kill
// written with the wrong type still kills.
// Two readers decide from it, by this one rule:
//   - card-pay-action.ts: may this partner open a card page on this platform
//     (the CARD pay action, the card routes);
//   - fee-pause.ts: [Review #2453-B B-3] do live cards count as a way to pay
//     at all, for the fee pause (only with EVERY platform on: a partner's app
//     may be any of them).
// A leaf module, so the fee pause can read it without importing the card
// door's module graph (as fee-checkout-switch.ts is for MMG).
// ---------------------------------------------------------------------------

export const CARD_CHECKOUT_PLATFORMS_KEY = 'billing.cardCheckout.platforms';
const PLATFORMS = ['ios', 'android', 'web'] as const;
export type CardPlatformSwitches = Record<(typeof PLATFORMS)[number], boolean>;
/** With no row, or a platform missing from the row. */
const SWITCH_DEFAULTS: CardPlatformSwitches = { ios: false, android: true, web: true };

/** The switch row as read (see the header): defaults, real booleans only, a malformed row closes everything. */
export function cardPlatformSwitches(row: { value: unknown } | null): CardPlatformSwitches {
  if (!row) return { ...SWITCH_DEFAULTS };
  const value = row.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    log().warn({ key: CARD_CHECKOUT_PLATFORMS_KEY }, '[PT-2] the card per-platform switch is not an object of true/false values; paying by card is OFF on every platform until it is corrected');
    return { ios: false, android: false, web: false };
  }
  const switches = { ...SWITCH_DEFAULTS };
  for (const platform of PLATFORMS) {
    if (!Object.prototype.hasOwnProperty.call(value, platform)) continue;
    const on = (value as Record<string, unknown>)[platform];
    if (typeof on === 'boolean') {
      switches[platform] = on;
    } else {
      switches[platform] = false;
      log().warn({ key: CARD_CHECKOUT_PLATFORMS_KEY, platform }, '[PT-2] a card per-platform switch value is not true or false; paying by card is OFF on that platform until it is corrected');
    }
  }
  return switches;
}

/** [fee pause · B-3] Is paying by card switched on for EVERY platform? Read fresh (never the card door's
 *  one-minute cache): the fee pause is never cached. */
export async function cardCheckoutEveryPlatformOn(db: Pick<PrismaClient, 'platformConfig'>): Promise<boolean> {
  const row = await db.platformConfig.findUnique({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY }, select: { value: true } });
  const switches = cardPlatformSwitches(row);
  return switches.ios && switches.android && switches.web;
}
