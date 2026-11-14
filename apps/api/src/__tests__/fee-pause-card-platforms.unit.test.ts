import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { noLivePayPath } from '../modules/billing/fee-pause';
import { FEE_CHECKOUT_PLATFORMS_KEY } from '../modules/billing/fee-checkout-switch';
import { CARD_CHECKOUT_PLATFORMS_KEY, cardCheckoutPlatforms, resetCardCheckoutSwitchCache } from '../modules/billing/card-pay-action';
import * as cardFactory from '../providers/card/card-rail-factory';

// ---------------------------------------------------------------------------
// [Review #2453-B B-3 · CARDS-SWITCH-ON] The fee pause ("no live way to pay",
// fee-pause.ts) is one answer for every partner on the server. Live cards
// count as a way to pay ONLY when the card's own per-platform switch
// (billing.cardCheckout.platforms) is on for EVERY platform — iOS, Android and
// the website — exactly as MMG's checkout counts only with every MMG platform
// on. A partner's app may be any of them, and iOS is OFF unless the row says
// "ios": true (owner 6 Oct, Apple 3.1.1). Before, a live card rail lifted the
// pause for everyone even while iOS partners could not see a card button: with
// MMG off they would have been billed, failed and dunned with no way to pay.
// The switch row is read fresh on every call (never the card door's
// one-minute cache), like MMG's.
// ---------------------------------------------------------------------------

/** A switch-row reader with no database: rows by key; every read is recorded. */
function rows(values: Record<string, unknown>) {
  const reader = {
    reads: [] as string[],
    values,
    platformConfig: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        reader.reads.push(where.key);
        return Object.prototype.hasOwnProperty.call(reader.values, where.key) ? { value: reader.values[where.key] } : null;
      },
    },
  };
  return reader;
}
const paused = (reader: ReturnType<typeof rows>, env: Record<string, string | undefined>) => noLivePayPath(reader as never, env);

/** Real cards on the server: v2 on, not killed, the real provider, live (production's switch-on set; env-only here). */
const CARDS_LIVE = {
  NODE_ENV: 'test', PAYMENT_PROVIDER: 'disabled', CARD_RAIL_KILL: '0', CARD_RAIL_V2: '1',
  CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'live',
};
/** No MMG way to pay at all. */
const NO_MMG = { MMG_DRIVER: 'disabled' };
const ALL_ON = { ios: true, android: true, web: true };

afterEach(() => { vi.restoreAllMocks(); resetCardCheckoutSwitchCache(); });

describe('[B-3] live cards count for the fee pause only when the card is on for EVERY platform', () => {
  it('no card switch row (iOS off by default), MMG off: the fee stays paused — iOS partners could not pay by card', async () => {
    const reader = rows({});
    expect(await paused(reader, { ...CARDS_LIVE, ...NO_MMG })).toBe(true);
    expect(reader.reads).toContain(CARD_CHECKOUT_PLATFORMS_KEY);
  });

  it('the card on every platform, MMG off: a live way to pay, so the fee runs', async () => {
    for (const row of [ALL_ON, { ios: true }, { ios: true, android: true }, { ios: true, web: true }]) {
      expect(await paused(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: row }), { ...CARDS_LIVE, ...NO_MMG }), JSON.stringify(row)).toBe(false);
    }
  });

  it('the card off on ANY one platform, MMG off: paused', async () => {
    for (const row of [
      { ios: false }, { ios: true, android: false }, { ios: true, web: false }, { ios: false, android: true, web: true },
      { ios: true, android: true, web: false }, { ios: false, android: false, web: false },
    ]) {
      expect(await paused(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: row }), { ...CARDS_LIVE, ...NO_MMG }), JSON.stringify(row)).toBe(true);
    }
  });

  it('a switch written with the wrong type kills, as at the card door: paused', async () => {
    for (const row of [{ ios: 'true', android: true, web: true }, { ios: 1, android: true, web: true }, ['ios', 'android', 'web'], 'on', true]) {
      expect(await paused(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: row }), { ...CARDS_LIVE, ...NO_MMG }), JSON.stringify(row)).toBe(true);
    }
  });

  it('the fee pause and the card door read ONE rule: the card counts exactly when the door is open on every platform (and so for an unknown one)', async () => {
    for (const row of [null, ALL_ON, { ios: true }, { ios: false }, { web: false }, { ios: true, android: false }, { ios: 'yes' }, []]) {
      resetCardCheckoutSwitchCache();
      const reader = rows(row === null ? {} : { [CARD_CHECKOUT_PLATFORMS_KEY]: row });
      const door = await cardCheckoutPlatforms(reader as unknown as PrismaClient);
      const everyPlatform = door.ios && door.android && door.web;
      expect(await paused(reader, { ...CARDS_LIVE, ...NO_MMG }), JSON.stringify(row)).toBe(!everyPlatform);
    }
  });

  it('the row is read fresh on every call, never cached: closing a platform pauses at once', async () => {
    const reader = rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: ALL_ON });
    expect(await paused(reader, { ...CARDS_LIVE, ...NO_MMG })).toBe(false);
    reader.values[CARD_CHECKOUT_PLATFORMS_KEY] = { ...ALL_ON, ios: false };
    expect(await paused(reader, { ...CARDS_LIVE, ...NO_MMG })).toBe(true);
    reader.values[CARD_CHECKOUT_PLATFORMS_KEY] = ALL_ON;
    expect(await paused(reader, { ...CARDS_LIVE, ...NO_MMG })).toBe(false);
  });

  it('cards not live (killed, v2 off, sandbox, simulator): the card row is never read and cards never count', async () => {
    const supported = vi.spyOn(cardFactory, 'cardRailProviderNames').mockReturnValue(['simulator', 'powertranz']);
    for (const patch of [{ CARD_RAIL_KILL: '1' }, { CARD_RAIL_V2: '0' }, { CARD_RAIL_ENVIRONMENT: 'sandbox' }, { CARD_RAIL_PROVIDER: 'simulator' }]) {
      const reader = rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: ALL_ON });
      expect(await paused(reader, { ...CARDS_LIVE, ...NO_MMG, ...patch }), JSON.stringify(patch)).toBe(true);
      expect(reader.reads, JSON.stringify(patch)).not.toContain(CARD_CHECKOUT_PLATFORMS_KEY);
    }
    supported.mockRestore();
  });

  it('MMG still covers every partner by itself: with the MMG push rail on, the card\'s iOS switch does not matter', async () => {
    // Off production with no MMG driver set, the MMG push rail is on (fee-pause-pay-path.test.ts).
    expect(await paused(rows({}), { ...CARDS_LIVE })).toBe(false);
    expect(await paused(rows({ [CARD_CHECKOUT_PLATFORMS_KEY]: { ios: false }, [FEE_CHECKOUT_PLATFORMS_KEY]: { ios: false } }), { ...CARDS_LIVE })).toBe(false);
  });
});
