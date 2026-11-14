import { cardRailProviderNames } from '../providers/card/card-rail-factory';
import { isProduction } from './runtime-mode';

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
    && env['CARD_RAIL_ENVIRONMENT'] === 'live'
    // [CARDS-GO · owner 14 Nov 2026] While live cards serve only the listed subscriptions, they are no way to pay for
    // every OTHER partner: the fee pause stays decided by MMG alone and the public site lists no card.
    && !cardLiveSubscriptionsLimited(env);
}

/** [CARDS-GO · owner ruling 14 Nov 2026, 00:31Z: "connect tonight, ONLY the owner's own account sees cards; everyone
 * else after PowerTranz's go-live approval"] CARD_RAIL_LIVE_SUBSCRIPTIONS, a comma-separated list of subscription
 * ids. While it is set (anything but unset or empty), REAL cards serve ONLY the listed subscriptions:
 *   - the card door (card-pay-action.ts cardSessionsAllowed) and the session it opens (card-rail.service.ts
 *     startSession) refuse every other subscription on the server, so its Pay screen shows no card button and a
 *     card request it sends anyway is refused (409 PAY_ACTION_OFF) before any page or row;
 *   - live cards are no way to pay for the fee pause (weeklyFeeCardLive, above): every partner who is not listed
 *     keeps exactly today's no-card fee, paused or not by MMG alone, never billed toward a card they cannot see;
 *   - the public site keeps cards "coming soon" (GET /public/capabilities → cardPayments).
 * `*` (alone): every eligible partner (the go-live, after PowerTranz's approval). [Review #2465-B B-2] Unset or
 * empty is NEVER read as everyone in production: there it serves NOBODY, and the boot guard and pilot-up refuse
 * CARD_RAIL_KILL=0 without the line, so a forgotten, emptied or late line cannot open live cards (and the public
 * site's card marks) to every partner. Off production, where live cards never run, unset keeps meaning everyone.
 * It keys on the SUBSCRIPTION, as the door and the test list (CARD_RAIL_TEST_SUBSCRIPTIONS) do: the weekly fee, the
 * card session, its booking and its refund all belong to one subscription, and the door checks who may pay it (its
 * payer) by itself. For a mover with both a rider and a driver profile, name the CANONICAL subscription (the one
 * the mover fee authority names: the other cannot be priced, review B-4). It never stops what is already open: a
 * card payment opened while listed is still confirmed, booked once and refundable after the list changes. A
 * malformed value fails CLOSED: it never widens past the valid ids it names (one that names no valid id serves
 * nobody, and `*` mixed with ids is never everyone; review #2465-A2 S4-1), and production refuses it at boot
 * (assertProductionCardSwitches). Test card systems keep their own list. */
export const CARD_LIVE_EVERYONE = '*';

/** [B-2] Production posture through the one typed parser (the census forbids comparing the raw NODE_ENV). An
 *  unset or unknown NODE_ENV cannot boot, but if one is ever seen here it counts as production: the list fails CLOSED. */
const productionPostureOrUnknown = (env: Record<string, string | undefined>): boolean => {
  try { return isProduction(env); } catch { return true; }
};

const liveListRaw = (env: Record<string, string | undefined>): string | undefined => {
  const raw = env['CARD_RAIL_LIVE_SUBSCRIPTIONS'];
  return raw === undefined || raw === '' ? undefined : raw;
};

/** [B-2] The list is exactly `*` (spaces around it allowed): every eligible partner. */
export function cardLiveForEveryone(env: Record<string, string | undefined> = process.env): boolean {
  return liveListRaw(env)?.trim() === CARD_LIVE_EVERYONE;
}

/** Do real cards serve only some subscriptions (or none)? Off production an unset list is everyone; in production
 *  only `*` is. */
export function cardLiveSubscriptionsLimited(env: Record<string, string | undefined> = process.env): boolean {
  const raw = liveListRaw(env);
  if (raw === undefined) return productionPostureOrUnknown(env);
  return raw.trim() !== CARD_LIVE_EVERYONE;
}

const SUBSCRIPTION_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
const liveSubscriptionEntries = (raw: string): string[] => raw.split(',').map((s) => s.trim());

/** [CARDS-GO] May REAL cards serve this subscription? Yes when the list does not limit them, else only if it names it. */
export function cardLiveSubscriptionAllowed(subscriptionId: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!cardLiveSubscriptionsLimited(env)) return true;
  const raw = liveListRaw(env);
  if (raw === undefined) return false;
  return liveSubscriptionEntries(raw).some((id) => SUBSCRIPTION_ID_SHAPE.test(id) && id === subscriptionId);
}

/** [CARDS-GO] How many subscriptions the live list names (0 when unset or empty), for the deploy's output; the ids
 *  themselves are never printed. */
export function cardLiveSubscriptionCount(env: Record<string, string | undefined> = process.env): number {
  const raw = liveListRaw(env);
  if (raw === undefined || cardLiveForEveryone(env)) return 0;
  return new Set(liveSubscriptionEntries(raw).filter((id) => SUBSCRIPTION_ID_SHAPE.test(id))).size;
}

/** [CARDS-GO] A set live list is well formed: `*` alone, or one or more subscription ids, comma-separated, spaces
 *  allowed around each, no empty entry. */
export function cardLiveSubscriptionsWellFormed(env: Record<string, string | undefined> = process.env): boolean {
  const raw = liveListRaw(env);
  if (raw === undefined || cardLiveForEveryone(env)) return true;
  return liveSubscriptionEntries(raw).every((id) => SUBSCRIPTION_ID_SHAPE.test(id));
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
 * serve). [CARDS-GO · owner 14 Nov 2026] The live list
 * (CARD_RAIL_LIVE_SUBSCRIPTIONS, cardLiveSubscriptionsLimited) is allowed in
 * every posture when well formed (ids, or * alone); a malformed one is refused,
 * and [review #2465-B B-2] cards ON needs it set (unset is never everyone). Changing any
 * of this is a reviewed code change, never a deploy/.env edit. Each refusal
 * names its setting, never a value. */
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
  // [CARDS-GO · owner 14 Nov 2026] The live list limits real cards to the subscriptions it names. A list that is set
  // but malformed would serve nobody (it fails closed), and a typo must never read as "empty" (everyone): refuse it.
  if (!cardLiveSubscriptionsWellFormed(env)) {
    throw new Error('FATAL: CARD_RAIL_LIVE_SUBSCRIPTIONS must be a comma-separated list of subscription ids (live cards ONLY for them: the owner\'s go-cards ruling of 14 Nov 2026, his own account first) or * alone (every eligible partner, after PowerTranz\'s go-live) — one of its entries is empty or not a subscription id. Correct the list. Refusing to start.');
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
  // [Review #2465-B B-2] Cards on names who real cards serve. A forgotten, emptied or late list line is never read as
  // everyone: that is the explicit `*`, after PowerTranz's go-live.
  if (cardsOn && liveListRaw(env) === undefined) {
    throw new Error('FATAL: CARD_RAIL_KILL=0 (cards on) in production needs CARD_RAIL_LIVE_SUBSCRIPTIONS: the subscription ids live cards serve (the owner\'s own account first: the owner\'s go-cards ruling of 14 Nov 2026), or * for every eligible partner after PowerTranz\'s go-live; unset or empty is never read as everyone. Refusing to start.');
  }
}
