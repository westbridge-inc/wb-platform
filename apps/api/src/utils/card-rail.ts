import { cardRailProviderNames } from '../providers/card/card-rail-factory';

/** [CARD-DECOUPLE] The operational kill switch, CARD_RAIL_KILL exactly '1',
 * stops NEW card instructions on card rail v2 (hosted Pay now, enrolment,
 * instrument charges). Reconciliation of what the provider already did keeps
 * running. Only this switch kills v2: PAYMENT_PROVIDER names the LEGACY card
 * seam (providers/payment) and has no say over v2, so the PowerTranz
 * credentials are entered once (POWERTRANZ_*) and a test server can run v2
 * against the provider's sandbox while the legacy seam stays disabled.
 * Production holds it at exactly 1 (cards off) or 0 (cards on, only beside
 * the complete live setup) by assertProductionCardSwitches, below. */
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
 * card on file, their billing method, their app) enters it. [Review #2453-B
 * B-3] It is the env half of the fee pause's card answer: fee-pause.ts
 * cardPayPathLive also requires the card's per-platform switch
 * (billing.cardCheckout.platforms) on for EVERY platform. */
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

const switchSet = (value: string | undefined): boolean => value !== undefined && value !== '' && value !== '0';

/** [CARDS-SWITCH-ON] PRODUCTION ONLY (the callers check the mode): the card
 * switches production may run, held in one place by the API boot guard
 * (boot-config.ts assertProductionLaunchLocks), the legacy provider factory
 * (getPaymentProvider, built while routes register) and — in shell —
 * pilot-up.sh, which also runs this very guard in the new image before the
 * swap (dist/boot/boot-guard.js).
 *   Cards ON rests on the owner's go-cards ruling (OWNER-DECISIONS, dated at
 *   the go), the owner's explicit word this reviewed change waits for. History:
 *   owner ruling 13 Oct (#34) refused cards "until an attorney signs off";
 *   7 Oct option A described this change's shape; 15 Oct kept cards OFF until
 *   a lawyer verifies, which the go-cards ruling supersedes for Pay now only.
 *   Saved cards and automatic weekly card charges stay refused (GUARDRAILS §8;
 *   owner rulings 13 and 15 Oct).
 * So production boots in exactly one of three postures:
 *   cards OFF   CARD_RAIL_KILL=1, CARD_RAIL_V2 unset or 0 (the default);
 *   cards ON    CARD_RAIL_KILL=0, CARD_RAIL_V2=1, CARD_RAIL_PROVIDER=powertranz,
 *               CARD_RAIL_ENVIRONMENT=live — Pay now on the provider's hosted
 *               page, real cards (the complete live setup is PT-4's check in
 *               boot-config.ts, for any CARD_RAIL_V2=1);
 *   PAUSED      CARD_RAIL_KILL=1 with CARD_RAIL_V2=1 left on: the rollback. No
 *               new card payment starts; the ones already open are still
 *               confirmed, looked up and refunded.
 * And always refuses: the legacy card seam (PAYMENT_PROVIDER anything but
 * disabled), saving cards (CARD_RAIL_ENROLL: saved cards and automatic weekly
 * card charges), the drain switch (CARD_RAIL_V2_DRAIN: the rollback keeps v2
 * on instead) and [review #2465-A F2] a test-subscription list
 * (CARD_RAIL_TEST_SUBSCRIPTIONS: it only ever names what a TEST card system may
 * serve). Changing any of this is a reviewed code change, never a deploy/.env
 * edit. Each refusal names its setting, never a value. */
export function assertProductionCardSwitches(env: Record<string, string | undefined>): void {
  if (env['PAYMENT_PROVIDER'] !== 'disabled') {
    throw new Error('FATAL: PAYMENT_PROVIDER must be exactly disabled in production — the legacy card seam (a stored card token Swift charges itself) stays off; production takes cards only as Pay now on the provider\'s hosted page (card rail v2, on the owner\'s go-cards ruling: OWNER-DECISIONS, dated at the go). Turning the legacy seam on is a reviewed code change, not a setting. Refusing to start.');
  }
  if (switchSet(env['CARD_RAIL_ENROLL'])) {
    throw new Error('FATAL: CARD_RAIL_ENROLL must be unset or 0 in production — saved cards and automatic weekly card charges stay off until a lawyer confirms them (GUARDRAILS §8; owner rulings, 13 and 15 Oct); turning it on is a reviewed code change, not a setting. Refusing to start.');
  }
  if (switchSet(env['CARD_RAIL_V2_DRAIN'])) {
    throw new Error('FATAL: CARD_RAIL_V2_DRAIN must be unset or 0 in production — to stop card payments set CARD_RAIL_KILL=1 and leave CARD_RAIL_V2=1, which keeps confirming the card payments already open; draining with card rail v2 off is a reviewed code change, not a setting. Refusing to start.');
  }
  if (env['CARD_RAIL_TEST_SUBSCRIPTIONS'] !== undefined && env['CARD_RAIL_TEST_SUBSCRIPTIONS'] !== '') {
    throw new Error('FATAL: CARD_RAIL_TEST_SUBSCRIPTIONS must be empty in production — it names the only subscriptions a TEST card system may serve, and production runs none; a listed id would let a test record be booked or refunded as a test. Remove the value. Refusing to start.');
  }
  // The switch is OFF exactly at '1', everywhere (cardRailKilled; the dark-features census). Production also
  // refuses every near miss of ON: only exactly '0' turns cards on here (the one '0' comparison the census allows).
  const cardsOff = cardRailKilled(env);
  const cardsOn = env['CARD_RAIL_KILL'] === '0';
  if (!cardsOff && !cardsOn) {
    throw new Error('FATAL: CARD_RAIL_KILL must be exactly 1 (cards off) or exactly 0 (cards on) in production — cards go on only beside the complete live card setup, on the owner\'s go-cards ruling (OWNER-DECISIONS, dated at the go); anything else is a reviewed code change, not a setting. Refusing to start.');
  }
  if (cardsOn && !(env['CARD_RAIL_V2'] === '1' && env['CARD_RAIL_PROVIDER'] === 'powertranz' && env['CARD_RAIL_ENVIRONMENT'] === 'live')) {
    throw new Error('FATAL: CARD_RAIL_KILL=0 (cards on) in production needs CARD_RAIL_V2=1, CARD_RAIL_PROVIDER=powertranz and CARD_RAIL_ENVIRONMENT=live — production takes cards only as Pay now on the provider\'s hosted page, with real cards and the complete live setup, on the owner\'s go-cards ruling (OWNER-DECISIONS, dated at the go); anything else is a reviewed code change, not a setting. Refusing to start.');
  }
}
