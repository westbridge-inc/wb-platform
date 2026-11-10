import type { PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import { log } from '../../utils/logger';
import { cardEnrollEnabled, cardRailKilled, cardRailV2Enabled, cardSimulatorLiveEnabled, cardTestSubscriptions } from '../../utils/card-rail';
import { OPERABLE_STATUSES } from '../subscription/operate-gate';
import { subscriptionPayer } from '../subscription/mover-fee-authority';
import { weeklyFeeAmount } from './subscription-fee';
import { readFeePaymentDecision } from './fee-payment-authority';
import { payAheadAllows } from './pay-ahead';
import type { ClientPlatform } from './fee-pay-actions';
import { INSTRUMENT_DTO_SELECT, cardTestLabel, type PaymentInstrumentDto } from './card-rail.service';
import type { CardRailProvider, CardRailSource } from '../../providers/card/card-provider';
import { SIMULATOR_PROVIDER } from '../../providers/card/simulator-provider';
import { CARD_CHECKOUT_PLATFORMS_KEY, cardPlatformSwitches, type CardPlatformSwitches } from './card-checkout-switch';

// ---------------------------------------------------------------------------
// [PT-2] May this partner pay the weekly fee by card, here, now? Decided in
// one place (CARD-CHECKOUT-API.md section 3). The card routes and the CARD
// entry of the subscription's payActions read this; no client re-derives it.
//
// Two answers:
//   cardSessionsAllowed  may a card page be opened at all (the routes ask it
//                        before any key, price or page). The simulator passes
//                        it on a test server, so the whole loop can be driven.
//   cardPayAction        what the Pay screen shows. `live` additionally needs
//                        a REAL provider: the simulator makes CARD live only
//                        on a test server that says so (CARD_RAIL_SIMULATOR_LIVE,
//                        refused in production), and then labelled as a test.
//                        `off` is hidden, never a disabled "coming soon".
// ---------------------------------------------------------------------------

/** What a card looks like on the Pay screen: brand, last 4, expiry, status [C9]. */
export type CardView = PaymentInstrumentDto;

export type CardPayAction =
  | { id: 'CARD'; state: 'off' }
  | {
      id: 'CARD';
      state: 'live';
      /** Exactly what a Pay-now session charges right now (the server's price). */
      payNow: { amount: number; currencyCode: string };
      /** May the partner save a card for the weekly fee? False unless the
       *  provider can charge a saved card without the partner present AND
       *  saving cards is switched on (CARD_RAIL_ENROLL). */
      addCard: boolean;
      /** The ACTIVE card, if any. */
      cardOnFile: CardView | null;
      /** True when the card choice is a TEST — the simulator on a test server, or
       *  the provider's sandbox [PT-4]: every screen shows testModeLabel. */
      testMode: boolean;
      testModeLabel?: string;
    };

export const CARD_OFF: CardPayAction = { id: 'CARD', state: 'off' };

/**
 * The per-platform switch for card payment (card-checkout-switch.ts, the one
 * reader of the row: iOS OFF unless the row says `"ios": true`; Android and
 * web ON unless it says `false`; only real booleans count). Read here through
 * a one-minute cache.
 */
export { CARD_CHECKOUT_PLATFORMS_KEY };
const SWITCH_TTL_MS = 60_000;
type PlatformSwitches = CardPlatformSwitches;

/** Paying rejoins a CHURNED account; PAUSED (billing stopped) and CANCELLED do not pay. */
const PAYABLE: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>([...OPERABLE_STATUSES, 'SUSPENDED', 'CHURNED']);

let switchCache: { at: number; switches: PlatformSwitches } | null = null;
/** Tests reset the one-minute cache of the per-platform switch. */
export function resetCardCheckoutSwitchCache(): void {
  switchCache = null;
}

export async function cardCheckoutPlatforms(prisma: Pick<PrismaClient, 'platformConfig'>): Promise<PlatformSwitches> {
  const now = Date.now();
  if (!switchCache || now - switchCache.at > SWITCH_TTL_MS) {
    const row = await prisma.platformConfig.findUnique({ where: { key: CARD_CHECKOUT_PLATFORMS_KEY } });
    switchCache = { at: now, switches: cardPlatformSwitches(row) };
  }
  return { ...switchCache.switches };
}

export type CardSessionsDecision =
  | { allowed: true; provider: CardRailProvider }
  | { allowed: false; reason: 'FLAG_OFF' | 'KILLED' | 'NO_PROVIDER' | 'NOT_TEST_SUBSCRIPTION' | 'PLATFORM_OFF' | 'NOT_PAYABLE' | 'NOT_PRODUCTION_PAYER' };

type PayableSub = Pick<Subscription, 'id' | 'status' | 'feeWaived' | 'weeklyRate' | 'customRate'>;

/**
 * THE rule for opening a card page. In order: the flag, the kill switch, a
 * provider that builds from this server's configuration, the platform switch
 * (an unknown platform counts only when every platform is on), a payable
 * subscription with a fee above zero, and a payer in a production tenant (the
 * store-review demo and the crawler never reach a card page, test or real).
 * [Reviews S2 / S2-1] A TEST card system — the simulator or a provider's
 * sandbox: no real money, yet an approval books a week — serves only the TEST
 * subscriptions listed in CARD_RAIL_TEST_SUBSCRIPTIONS.
 */
export async function cardSessionsAllowed(
  prisma: PrismaClient,
  sub: PayableSub,
  platform: ClientPlatform,
  rail: CardRailSource,
): Promise<CardSessionsDecision> {
  if (!cardRailV2Enabled()) return { allowed: false, reason: 'FLAG_OFF' };
  if (cardRailKilled()) return { allowed: false, reason: 'KILLED' };
  let provider: CardRailProvider;
  try {
    provider = rail();
  } catch (err) {
    log().error({ err }, '[PT-2] the card rail configuration could not be loaded; card payment is off');
    return { allowed: false, reason: 'NO_PROVIDER' };
  }
  if ((provider.simulator || provider.binding.environment !== 'live') && !cardTestSubscriptions().has(sub.id)) return { allowed: false, reason: 'NOT_TEST_SUBSCRIPTION' };
  const switches = await cardCheckoutPlatforms(prisma);
  const platformOn = platform === 'unknown' ? switches.ios && switches.android && switches.web : switches[platform];
  if (!platformOn) return { allowed: false, reason: 'PLATFORM_OFF' };
  if (!PAYABLE.has(sub.status) || sub.feeWaived || !(weeklyFeeAmount(sub) > 0)) return { allowed: false, reason: 'NOT_PAYABLE' };
  if (!(await payerIsProduction(prisma, sub.id))) return { allowed: false, reason: 'NOT_PRODUCTION_PAYER' };
  return { allowed: true, provider };
}

/** Whether the subscription's payer (#1393's: the rider's or driver's user, or
 *  the store owner's) is in a PRODUCTION tenant. Unknown payer: no. */
async function payerIsProduction(prisma: PrismaClient, subscriptionId: string): Promise<boolean> {
  const payer = await subscriptionPayer(prisma, subscriptionId).catch(() => null);
  if (!payer) return false;
  const tenant = await prisma.tenant.findUnique({ where: { id: payer.tenantId }, select: { kind: true } });
  return tenant?.kind === 'PRODUCTION';
}

/**
 * The CARD entry of payActions. `live` needs cardSessionsAllowed AND a real
 * provider (never the simulator) AND a price the server can quote now AND —
 * exactly as MMG_CHECKOUT — #1393's read-only decision allowing a NEW payment
 * (none of this fee's payments is being confirmed, and the billing clock
 * covers the subscription). Reading it never opens a page, takes a lock or
 * changes anything.
 */
export async function cardPayAction(
  prisma: PrismaClient,
  quote: (subscriptionId: string) => Promise<{ amount: number; currencyCode: string }>,
  sub: PayableSub,
  platform: ClientPlatform,
  rail: CardRailSource,
): Promise<CardPayAction> {
  const decision = await cardSessionsAllowed(prisma, sub, platform, rail);
  if (!decision.allowed || (decision.provider.simulator && !cardSimulatorLiveEnabled())) return CARD_OFF;
  let payNow: { amount: number; currencyCode: string };
  try {
    const priced = await quote(sub.id);
    payNow = { amount: priced.amount, currencyCode: priced.currencyCode };
  } catch {
    return CARD_OFF; // nothing to pay (waived, zero), under review, or no price: no button
  }
  if (!(await readFeePaymentDecision(prisma, sub.id)).allowed) return CARD_OFF;
  // [owner 6 Nov 2026 · DS1114 S3] A Pay now pays a whole week: when that would go
  // past the four-week limit the door could only refuse, so there is no card button.
  if (!(await payAheadAllows(prisma, sub.id, payNow.amount, new Date()))) return CARD_OFF;
  const addCard = decision.provider.savesCards && cardEnrollEnabled();
  const cardOnFile = addCard
    ? await prisma.paymentInstrument.findFirst({ where: { subscriptionId: sub.id, status: 'ACTIVE' }, select: INSTRUMENT_DTO_SELECT })
    : null;
  const testModeLabel = decision.provider.simulator
    ? cardTestLabel({ provider: SIMULATOR_PROVIDER, environment: 'sandbox' })
    : cardTestLabel({ provider: decision.provider.binding.provider, environment: decision.provider.binding.environment });
  return { id: 'CARD', state: 'live', payNow, addCard, cardOnFile, testMode: testModeLabel !== undefined, ...(testModeLabel ? { testModeLabel } : {}) };
}
