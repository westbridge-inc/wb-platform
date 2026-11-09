import { cardRailProviderNames } from '../providers/card/card-rail-factory';

/** [CARD-DECOUPLE] The operational kill switch, CARD_RAIL_KILL exactly '1',
 * stops NEW card instructions on card rail v2 (hosted Pay now, enrolment,
 * instrument charges). Reconciliation of what the provider already did keeps
 * running. Only this switch kills v2: PAYMENT_PROVIDER names the LEGACY card
 * seam (providers/payment) and has no say over v2, so the PowerTranz
 * credentials are entered once (POWERTRANZ_*) and a test server can run v2
 * against the provider's sandbox while the legacy seam stays disabled.
 * Production keeps CARD_RAIL_KILL=1 by its launch lock
 * (assertProductionCardKillSwitch, below). */
export function cardRailKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_KILL'] === '1';
}

/** [CARD-DECOUPLE] The LEGACY card seam (a bare token on the subscription,
 * charged through providers/payment) issues no new instruction while the
 * kill switch is on OR its provider is explicitly disabled: the disabled
 * provider refuses every instruction, and billing defers rather than turn
 * that refusal into a decline. Never consulted for card rail v2. */
export function legacyCardSeamOff(env: Record<string, string | undefined> = process.env): boolean {
  return env['PAYMENT_PROVIDER'] === 'disabled' || cardRailKilled(env);
}

/** [PT-1] Card rail v2 — hosted enrolment, bound instruments, hosted Pay now —
 * is dormant unless CARD_RAIL_V2 is exactly '1'. OFF (the default) leaves the
 * legacy card path byte-identical, and the billing worker does no v2 work at
 * all: it builds no v2 provider and sweeps no session [AX297 F5]. */
export function cardRailV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_V2'] === '1';
}

/** [PROD-PATH] A partner can pay the weekly fee by card on this server: card
 * rail v2 (hosted Pay now and enrolment, the only card paths a partner can
 * open) is on, the kill switch does not stop it (the legacy PAYMENT_PROVIDER
 * has no say over v2 [CARD-DECOUPLE]), a REAL provider is configured, and it
 * takes REAL cards (CARD_RAIL_ENVIRONMENT exactly live). A TEST card system
 * never counts — the simulator, or a provider's sandbox: it serves only the
 * test subscriptions listed in CARD_RAIL_TEST_SUBSCRIPTIONS and moves no
 * money, so it is no way for a real partner to pay (card-pay-action.ts
 * cardSessionsAllowed). [Review #2453 A-F1 / B-1] Counting the sandbox lifted
 * the fee pause for EVERY partner on a test server, who then had no way to
 * pay. Live cards run only on production (boot-config.ts), so off production
 * this is always false. Server switches only: nothing about a partner (their
 * card on file, their billing method, their app) enters it. */
export function weeklyFeeCardLive(env: Record<string, string | undefined> = process.env): boolean {
  const provider = env['CARD_RAIL_PROVIDER'] ?? '';
  return cardRailV2Enabled(env) && !cardRailKilled(env) && provider !== 'simulator' && cardRailProviderNames().includes(provider)
    && env['CARD_RAIL_ENVIRONMENT'] === 'live';
}

/** [PT-1 · AX297 F5] With CARD_RAIL_V2 off, drain what v2 left in flight:
 * CARD_RAIL_V2_DRAIN exactly '1' (default 0) lets the billing worker keep
 * confirming open card sessions and retrieving v2 charges already sent, and
 * nothing else — no new session and no new charge (those still need
 * CARD_RAIL_V2=1). Switching v2 off and draining it are separate decisions. */
export function cardRailV2DrainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_V2_DRAIN'] === '1';
}

/** [PT-2] Saving a card for the weekly fee (an ENROLL session) is OFF unless
 * CARD_RAIL_ENROLL is exactly '1' — independent of the provider's ability:
 * the on-screen consent wording waits for the owner's sign-off. Off: the
 * CARD entry offers Pay now only and an ENROLL request is refused. */
export function cardEnrollEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_ENROLL'] === '1';
}

/** [PT-2] STAGING ONLY: CARD_RAIL_SIMULATOR_LIVE exactly '1' lets the
 * simulator make the CARD pay action live — labelled as a test — so the whole
 * card choice can be exercised on a test server. Production refuses to boot
 * with it set (boot-config.ts), and the simulator itself never builds there. */
export function cardSimulatorLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_SIMULATOR_LIVE'] === '1';
}

/** [PT-2 · PT-4 · reviews S2 / S2-1] A TEST card system — the simulator, or
 * a provider's sandbox — moves no real money, yet a test "approval" books a
 * paid week. So a test system opens pages, and books, ONLY for the TEST
 * subscriptions listed by id in CARD_RAIL_TEST_SUBSCRIPTIONS
 * (comma-separated): a real partner on a test server never sees or settles
 * a test payment. Empty or unset: no subscription may use one. */
export function cardTestSubscriptions(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  return new Set((env['CARD_RAIL_TEST_SUBSCRIPTIONS'] ?? '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)));
}

/** [PT-2 · review S2 · GUARD-FIX] Every public name of the production API
 * (and, until the DNS cutover, of what Apple's reviewers reach): no test
 * switch or test page may ever run on any of them. Production is served as
 * api-live.swiftgy.com and keeps that name after launch, when api.swiftgy.com
 * is added beside it as a second name. A guard keyed on one name alone never
 * fires on the other. Production also refuses a test card system whatever its
 * name (boot-config.ts). */
export const PUBLIC_API_HOSTS: readonly string[] = ['api.swiftgy.com', 'api-live.swiftgy.com'];

/** [LAUNCH-LOCK · owner ruling 13 Oct · CARD-DECOUPLE] PRODUCTION ONLY (the
 * callers check the mode): the card kill switch is exactly '1'. Until
 * 9 Nov 2026 this rode on "PAYMENT_PROVIDER=disabled requires
 * CARD_RAIL_KILL=1" in every mode; card rail v2 no longer reads
 * PAYMENT_PROVIDER, so production holds the switch itself, explicitly — the
 * API boot guard (boot-config.ts assertProductionLaunchLocks), the legacy
 * provider factory (getPaymentProvider) and pilot-up.sh. Turning cards on in
 * production is a reviewed change to these, never a deploy/.env edit.
 * Names the setting, never a value. */
export function assertProductionCardKillSwitch(env: Record<string, string | undefined>): void {
  if (env['CARD_RAIL_KILL'] !== '1') {
    throw new Error('FATAL: CARD_RAIL_KILL must be exactly 1 in production — no card payment until an attorney signs off (owner ruling, 13 Oct); turning cards on is a reviewed code change, not a setting. Refusing to start.');
  }
}
