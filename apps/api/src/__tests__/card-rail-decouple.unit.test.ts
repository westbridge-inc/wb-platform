import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { cardRailKilled, legacyCardSeamOff, weeklyFeeCardLive } from '../utils/card-rail';
import { cardSessionsAllowed } from '../modules/billing/card-pay-action';
import type { CardRailProvider } from '../providers/card/card-provider';
import { assertSafeBootConfig } from '../utils/boot-config';
import { getPaymentProvider } from '../providers/payment/payment-provider';

// [CARD-DECOUPLE · 9 Nov 2026] Card rail v2 (the PowerTranz hosted page) is
// killed ONLY by CARD_RAIL_KILL=1. PAYMENT_PROVIDER names the LEGACY card seam
// (providers/payment) and turns off that seam alone, so the owner enters the
// PowerTranz credentials once (POWERTRANZ_*) and a test server can run v2
// against the provider's sandbox while the legacy seam stays disabled.
// Production keeps cards off by its own explicit launch lock
// (boot-config.test.ts [LAUNCH-LOCK]).

afterEach(() => vi.unstubAllEnvs());

/** A test server's card set: v2 on the provider's sandbox, the legacy seam off. */
const STAGING_V2 = {
  NODE_ENV: 'loadtest',
  PAYMENT_PROVIDER: 'disabled',
  CARD_RAIL_KILL: '0',
  CARD_RAIL_V2: '1',
  CARD_RAIL_PROVIDER: 'powertranz',
  CARD_RAIL_ENVIRONMENT: 'sandbox',
  API_PUBLIC_URL: 'https://api-staging.example.test',
};

describe('[CARD-DECOUPLE] the legacy PAYMENT_PROVIDER has no say over card rail v2', () => {
  it('PAYMENT_PROVIDER=disabled, CARD_RAIL_KILL=0, CARD_RAIL_V2=1, non-production: the v2 card rail is not killed', () => {
    expect(cardRailKilled(STAGING_V2)).toBe(false);
    expect(weeklyFeeCardLive(STAGING_V2)).toBe(true);
  });

  it('only CARD_RAIL_KILL exactly 1 kills v2, whatever PAYMENT_PROVIDER says', () => {
    for (const provider of [undefined, 'disabled', 'sandbox', 'powertranz', 'stripe']) {
      expect(cardRailKilled({ PAYMENT_PROVIDER: provider, CARD_RAIL_KILL: '1' }), String(provider)).toBe(true);
      for (const kill of [undefined, '', '0', 'true', ' 1']) {
        expect(cardRailKilled({ PAYMENT_PROVIDER: provider, CARD_RAIL_KILL: kill }), `${provider} ${kill}`).toBe(false);
      }
    }
    expect(weeklyFeeCardLive({ ...STAGING_V2, CARD_RAIL_KILL: '1' })).toBe(false);
  });

  it('the legacy seam stays off while its provider is disabled, or while the kill switch is on', () => {
    expect(legacyCardSeamOff({ PAYMENT_PROVIDER: 'disabled', CARD_RAIL_KILL: '0' })).toBe(true);
    expect(legacyCardSeamOff({ PAYMENT_PROVIDER: 'disabled' })).toBe(true);
    expect(legacyCardSeamOff({ PAYMENT_PROVIDER: 'sandbox', CARD_RAIL_KILL: '1' })).toBe(true);
    expect(legacyCardSeamOff({ PAYMENT_PROVIDER: 'sandbox', CARD_RAIL_KILL: '0' })).toBe(false);
    expect(legacyCardSeamOff({ PAYMENT_PROVIDER: 'powertranz' })).toBe(false);
  });

  it('the door that opens a card page (cardSessionsAllowed) passes the kill check with the legacy seam disabled, and stops at it only with CARD_RAIL_KILL=1', async () => {
    for (const [name, value] of Object.entries(STAGING_V2)) vi.stubEnv(name, value);
    const prisma = {} as PrismaClient;
    const sub = { id: 'synthetic-sub', status: 'ACTIVE', feeWaived: false, weeklyRate: 2100, customRate: null } as never;
    // A provider that cannot be built answers NO_PROVIDER: the decision got past FLAG_OFF and KILLED.
    const rail = (): CardRailProvider => { throw new Error('not built in this unit test'); };
    expect(await cardSessionsAllowed(prisma, sub, 'android', rail)).toEqual({ allowed: false, reason: 'NO_PROVIDER' });
    vi.stubEnv('CARD_RAIL_KILL', '1');
    expect(await cardSessionsAllowed(prisma, sub, 'android', rail)).toEqual({ allowed: false, reason: 'KILLED' });
  });

  it('a test server boots with v2 on the sandbox and the legacy seam disabled; the legacy factory gives the disabled provider, which refuses every instruction', async () => {
    expect(() => assertSafeBootConfig(STAGING_V2)).not.toThrow();
    for (const [name, value] of Object.entries(STAGING_V2)) vi.stubEnv(name, value);
    const provider = getPaymentProvider();
    await expect(provider.chargeToken({ token: 'synthetic', amount: 1, currencyCode: 'GYD', idempotencyKey: 'decouple-1' }))
      .resolves.toMatchObject({ status: 'failed', providerRef: '', code: 'CARD_RAIL_DISABLED' });
  });

  it('the sandbox is still never on the public API host (unchanged)', () => {
    expect(() => assertSafeBootConfig({ ...STAGING_V2, API_PUBLIC_URL: 'https://api.swiftgy.com' })).toThrow(/public API host/);
  });
});
