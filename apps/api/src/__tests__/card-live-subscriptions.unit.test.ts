import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  cardLiveSubscriptionAllowed, cardLiveSubscriptionCount, cardLiveSubscriptionsLimited, cardLiveSubscriptionsWellFormed, weeklyFeeCardLive,
} from '../utils/card-rail';
import { cardPayPathLive, noLivePayPath } from '../modules/billing/fee-pause';
import { CARD_CHECKOUT_PLATFORMS_KEY, cardPaymentsOffered } from '../modules/billing/card-checkout-switch';
import { cardSessionsAllowed, resetCardCheckoutSwitchCache } from '../modules/billing/card-pay-action';
import type { CardRailProvider } from '../providers/card/card-provider';

// ---------------------------------------------------------------------------
// [CARDS-GO · owner ruling 14 Nov 2026, 00:31Z] "Connect tonight, ONLY the owner's own account sees cards; everyone
// else after PowerTranz's go-live approval." CARD_RAIL_LIVE_SUBSCRIPTIONS lists the subscriptions REAL cards serve
// while it is set:
//   - the card door refuses every other subscription (today's no-card answer), server-side, not just hidden;
//   - live cards are no way to pay for the fee pause, so every partner who is not listed keeps exactly today's fee
//     (paused or not by MMG alone) — never billed toward a card button they cannot see;
//   - the public site keeps cards "coming soon";
//   - empty or unset: every eligible partner (the later go-live). Set but naming nobody valid: nobody (fails closed).
// ---------------------------------------------------------------------------

/** Real cards on the server: v2 on, not killed, the real provider, live (production's switch-on set). */
const CARDS_LIVE = {
  NODE_ENV: 'test', PAYMENT_PROVIDER: 'disabled', CARD_RAIL_KILL: '0', CARD_RAIL_V2: '1',
  CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'live',
};
const NO_MMG = { MMG_DRIVER: 'disabled' };
const ALL_ON = { ios: true, android: true, web: true };
const OWNER_SUB = 'cmownersub0000000000000001';
const OTHER_SUB = 'cmothersub0000000000000002';

/** A switch-row reader with no database: rows by key; every read is recorded. */
function rows(values: Record<string, unknown>) {
  const reader = {
    reads: [] as string[],
    platformConfig: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        reader.reads.push(where.key);
        return Object.prototype.hasOwnProperty.call(values, where.key) ? { value: values[where.key] } : null;
      },
    },
  };
  return reader;
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetCardCheckoutSwitchCache(); });

describe('[CARDS-GO] the live list: who real cards serve', () => {
  it('unset or empty: every eligible partner (not limited)', () => {
    for (const value of [undefined, '']) {
      const env = { CARD_RAIL_LIVE_SUBSCRIPTIONS: value };
      expect(cardLiveSubscriptionsLimited(env), String(value)).toBe(false);
      expect(cardLiveSubscriptionAllowed(OTHER_SUB, env), String(value)).toBe(true);
      expect(cardLiveSubscriptionsWellFormed(env), String(value)).toBe(true);
      expect(cardLiveSubscriptionCount(env), String(value)).toBe(0);
    }
  });

  it('set: ONLY the listed subscriptions, spaces around an entry allowed', () => {
    for (const value of [OWNER_SUB, ` ${OWNER_SUB} `, `${OWNER_SUB},other_x`, `other_x , ${OWNER_SUB}`]) {
      const env = { CARD_RAIL_LIVE_SUBSCRIPTIONS: value };
      expect(cardLiveSubscriptionsLimited(env), value).toBe(true);
      expect(cardLiveSubscriptionAllowed(OWNER_SUB, env), value).toBe(true);
      expect(cardLiveSubscriptionAllowed(OTHER_SUB, env), value).toBe(false);
      expect(cardLiveSubscriptionsWellFormed(env), value).toBe(true);
    }
    expect(cardLiveSubscriptionCount({ CARD_RAIL_LIVE_SUBSCRIPTIONS: `${OWNER_SUB}, ${OWNER_SUB},other_x` })).toBe(2);
  });

  it('set but naming nobody valid FAILS CLOSED: nobody, never everyone (and it reads as malformed)', () => {
    for (const value of [' ', ',', ' , ', 'not an id', `${OWNER_SUB};${OTHER_SUB}`, `${OWNER_SUB},,`]) {
      const env = { CARD_RAIL_LIVE_SUBSCRIPTIONS: value };
      expect(cardLiveSubscriptionsLimited(env), JSON.stringify(value)).toBe(true);
      expect(cardLiveSubscriptionAllowed(OTHER_SUB, env), JSON.stringify(value)).toBe(false);
      expect(cardLiveSubscriptionsWellFormed(env), JSON.stringify(value)).toBe(false);
    }
    // A malformed entry never matches, even beside a good one (production refuses the whole list at boot).
    expect(cardLiveSubscriptionAllowed('not an id', { CARD_RAIL_LIVE_SUBSCRIPTIONS: `${OWNER_SUB},not an id` })).toBe(false);
    expect(cardLiveSubscriptionAllowed(OWNER_SUB, { CARD_RAIL_LIVE_SUBSCRIPTIONS: `${OWNER_SUB},,` })).toBe(true);
  });
});

describe('[CARDS-GO] the fee pause: partners who are not listed keep exactly today\'s fee', () => {
  it('cards live on every platform, MMG off, the list set: live cards are NO way to pay — the fee stays paused for everyone (never billed toward a card they cannot see)', async () => {
    const env = { ...CARDS_LIVE, ...NO_MMG, CARD_RAIL_LIVE_SUBSCRIPTIONS: OWNER_SUB };
    expect(weeklyFeeCardLive(env)).toBe(false);
    expect(await cardPayPathLive(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: ALL_ON }) as never, env)).toBe(false);
    expect(await noLivePayPath(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: ALL_ON }) as never, env)).toBe(true);
    // The same server with the list emptied (the later go-live): cards count again, so nobody is paused.
    const everyone = { ...env, CARD_RAIL_LIVE_SUBSCRIPTIONS: '' };
    expect(weeklyFeeCardLive(everyone)).toBe(true);
    expect(await noLivePayPath(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: ALL_ON }) as never, everyone)).toBe(false);
  });

  it('the list set, MMG still a live way to pay: the fee runs exactly as today (MMG alone decides; nobody is blocked)', async () => {
    // Off production with no MMG driver set, the MMG push rail is on (fee-pause-pay-path.test.ts).
    const env = { ...CARDS_LIVE, CARD_RAIL_LIVE_SUBSCRIPTIONS: OWNER_SUB };
    expect(await noLivePayPath(rows({}) as never, env)).toBe(false);
    expect(await noLivePayPath(rows({}) as never, { ...env, CARD_RAIL_KILL: '1' })).toBe(false);
  });

  it('a malformed list fails closed here too: cards still never count', async () => {
    const env = { ...CARDS_LIVE, ...NO_MMG, CARD_RAIL_LIVE_SUBSCRIPTIONS: ' , ' };
    expect(weeklyFeeCardLive(env)).toBe(false);
    expect(await noLivePayPath(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: ALL_ON }) as never, env)).toBe(true);
  });

  it('the public site keeps cards "coming soon" while the list is set (cardPaymentsOffered), and nothing is read', async () => {
    const reader = rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: ALL_ON });
    expect(await cardPaymentsOffered(reader as never, { ...CARDS_LIVE, CARD_RAIL_LIVE_SUBSCRIPTIONS: OWNER_SUB })).toBe(false);
    expect(reader.reads).toEqual([]);
    expect(await cardPaymentsOffered(reader as never, CARDS_LIVE)).toBe(true);
  });
});

describe('[CARDS-GO] the card door: refused server-side for every subscription the list does not name', () => {
  /** A REAL provider (never the simulator) taking live cards; the door never asks it for a page. */
  const liveProvider = (): CardRailProvider => ({
    binding: { provider: 'powertranz', environment: 'live', account: 'swift-gy-live' },
    simulator: false,
    savesCards: false,
  } as unknown as CardRailProvider);
  const sub = (id: string) => ({ id, status: 'ACTIVE', feeWaived: false, weeklyRate: 2100, customRate: null }) as never;
  /** No row (Android and the website open); every other read throws, so the door stops at the payer check. */
  const prisma = () => {
    const reader = rows({});
    return { reader, prisma: new Proxy(reader, { get: (t, k) => (k in t ? (t as never)[k] : () => { throw new Error(`not read in this unit test: ${String(k)}`); }) }) as unknown as PrismaClient };
  };
  const stubEnv = (env: Record<string, string | undefined>) => { for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value); };

  it('the list set: a subscription it does not name is refused (NOT_LIVE_SUBSCRIPTION) before the platform row or the payer is read', async () => {
    stubEnv({ ...CARDS_LIVE, CARD_RAIL_LIVE_SUBSCRIPTIONS: OWNER_SUB });
    const { reader, prisma: db } = prisma();
    expect(await cardSessionsAllowed(db, sub(OTHER_SUB), 'android', liveProvider)).toEqual({ allowed: false, reason: 'NOT_LIVE_SUBSCRIPTION' });
    expect(reader.reads).toEqual([]);
  });

  it('the list set: the listed subscription passes the list (the door goes on to its own checks)', async () => {
    stubEnv({ ...CARDS_LIVE, CARD_RAIL_LIVE_SUBSCRIPTIONS: ` ${OWNER_SUB} ` });
    const { reader, prisma: db } = prisma();
    const decision = await cardSessionsAllowed(db, sub(OWNER_SUB), 'android', liveProvider);
    expect(decision).toEqual({ allowed: false, reason: 'NOT_PRODUCTION_PAYER' }); // past the list and the platform row
    expect(reader.reads).toEqual([CARD_CHECKOUT_PLATFORMS_KEY]);
  });

  it('the list empty or unset: no subscription is refused by it (the later go-live)', async () => {
    for (const value of [undefined, '']) {
      vi.unstubAllEnvs();
      resetCardCheckoutSwitchCache();
      stubEnv({ ...CARDS_LIVE, CARD_RAIL_LIVE_SUBSCRIPTIONS: value });
      const { prisma: db } = prisma();
      expect(await cardSessionsAllowed(db, sub(OTHER_SUB), 'android', liveProvider), String(value)).toEqual({ allowed: false, reason: 'NOT_PRODUCTION_PAYER' });
    }
  });

  it('a malformed list refuses everyone (fails closed)', async () => {
    stubEnv({ ...CARDS_LIVE, CARD_RAIL_LIVE_SUBSCRIPTIONS: ',' });
    const { prisma: db } = prisma();
    expect(await cardSessionsAllowed(db, sub(OTHER_SUB), 'android', liveProvider)).toEqual({ allowed: false, reason: 'NOT_LIVE_SUBSCRIPTION' });
  });
});
