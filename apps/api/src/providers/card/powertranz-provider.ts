import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { isProduction } from '../../utils/runtime-mode';
import { currencyInfo, isKnownCurrency } from '../../utils/currency-amount';
import {
  assertBinding,
  rawDigest,
  type CardChargeOutcome,
  type CardLookupOutcome,
  type CardRefundLookupOutcome,
  COMPLETION_CLAIM_WAIT_MS,
  type CardCompletionEvidence,
  type CardRailBinding,
  type CardRailEnvironment,
  type CardRailProvider,
  type CardRefundOutcome,
  type CardReturnObservation,
  type CardSessionOutcome,
  type CompletionClaim,
  type CreateCardSessionOutcome,
} from './card-provider';

// ---------------------------------------------------------------------------
// [PT-4] The card provider for real cards: PowerTranz, built ONLY from
// PowerTranz's own "Ecommerce API Guide v2.7 — Simplified 3DS Integration"
// (19 Sep 2023), and PowerTranz's own written answers to Swift (4 Nov 2026,
// the transaction lookup: 5. below). Every path, field and code below cites
// its section ("sec.") or that answer. Nothing here comes from a third-party
// SDK, plugin or forum.
//
// The flow (sec. 2.1, 2.2, Appendix 2), for a Pay now of the weekly fee:
//   1. createSession: a Sale with ThreeDSecure true and the hosted payment
//      page (HostedPage PageSet/PageName) -> IsoResponseCode "SP4",
//      RedirectData (a self-posting form) and an SpiToken (sec. 2.2 1.3-1.4,
//      7.2). Swift keeps both server-side; the partner gets Swift's own page,
//      which shows RedirectData inside an iframe (sec. 2.2 1.5, Appendix 2).
//      The card is typed ONLY on the provider's hosted page: no card number,
//      security code or PIN ever reaches Swift [C1].
//   2. The bank's 3-D Secure check runs in that iframe; the result comes back
//      THROUGH THE BROWSER to MerchantResponseUrl, Swift's public return (sec.
//      2.2 1.6). The guide gives the merchant no other channel for it before
//      completion and no signature on it, and PowerTranz confirmed in writing
//      that this post carries no signature or hash and must never be relied
//      on. So it is NEVER trusted: it is recorded as an observation and
//      may only STOP Swift from completing (a result that is not 3D0 with Y/A,
//      or that names another page) — it can never start money, mark anything
//      paid, or change the session [C5].
//      [CARD-STAGING-TEST 10 Nov 2026] PowerTranz's real sandbox posts it as an
//      x-www-form-urlencoded form of THREE fields: Response (the whole result,
//      as JSON text), TransactionIdentifier and SpiToken. The guide's samples
//      show the result itself (its fields at the top level); both are read
//      (readAuthenticationReturn), and the two copies of an identifier must agree.
//   3. confirm: the merchant completes with POST /spi/payment and the SpiToken
//      (sec. 2.2 1.7, 7.3). Before that call "there has been no financial
//      authorization and no funds have been held" (sec. 7.3), and PowerTranz
//      itself refuses a completion whose authentication was N or R (sec. 8.3;
//      the HPP guide: "The payment completion request will be declined by
//      default if the 3DS authentication is unsuccessful"). The Sale is always
//      sent with ThreeDSecure true, and a page whose record does not say so is
//      never completed. The answer to that server-to-server call is the ONLY
//      money truth. [OWNER RULING 10 Nov 2026] Swift books it only on
//      PowerTranz's own APPROVAL of the completion: Approved with
//      IsoResponseCode "00" for THIS transaction and order, a Sale, at Swift's
//      exact amount and currency. PowerTranz's own sample of that answer
//      carries no RiskManagement, and the real sandbox's carries none either,
//      so none is required; one that IS present and says the cardholder was
//      not authenticated contradicts the approval and is never booked. The
//      browser's 3D0 / Y / ECI is untrusted context only, never enough. An
//      approval Swift cannot book is voided at once (or held for a person),
//      never dropped. Swift sends the completion at most ONCE per page (an
//      atomic claim), and never repeats it (Appendix 1, 787 "Duplicate call
//      received"). When its outcome is not known (no answer, an unreadable
//      one), Swift reads the transaction's record instead (5. below), never
//      sends it again.
//   4. Refund (sec. 5.2, 7.5) and void (sec. 5.2, 7.6) take the ORIGINAL
//      TransactionIdentifier. [LEGAL-CARDS 12 Nov 2026] PowerTranz's written
//      answer supersedes the guide's "settlement (controlled by PowerTranz)"
//      (sec. 2.2 1.9) and its 4 Nov "Captured or Sale -> Refund": settlement
//      is done by the acquiring BANK (since the Sept 2026 migration), typically
//      in 2-3 business days, with no PowerTranz end-of-day batch; VOID while
//      the bank has not settled a sale, REFUND once it has (refund after
//      settlement recommended); a DECLINED transaction can never be refunded
//      (Response Code 12). Swift has no settlement signal, so it uses a
//      conservative time rule (card-settlement.ts SETTLED_CERTAIN): younger,
//      void (whole only); older, refund. A refused reversal goes to a person.
//   5. [CARD-LOOKUP] The transaction lookup is not in guide v2.7; it comes from
//      PowerTranz's written answer to Swift (4 Nov 2026): GET <root>/api/
//      Transactions/{TransactionIdentifier} with the PowerTranzId / Password
//      headers, ONLY when an outcome is unknown (timeout, interruption), never
//      as the normal flow; VoidDateTime present = reversed; OrderSummary has
//      SettledAmount, TotalCaptureAmount, TotalCreditAmount. lookupTransaction
//      reads it strictly; the service decides what it may book.
//      [CARD-STAGING-TEST 10 Nov 2026] The REAL records (staging sandbox):
//      no Approved and no top-level OrderIdentifier at all; the order is
//      OrderSummary.OrderIdentifier, and VoidDateTime sits ONLY in
//      OrderSummary (IsoResponseCode stays "00" after a void, and
//      TotalCaptureAmount keeps the sale's amount); TransactionType is a
//      number; dates carry no zone (Atlantic time, PowerTranz 12 Nov 2026); a transaction PowerTranz does not
//      know answers HTTP 204 with no body. readTransactionRecord reads that
//      shape (see there).
//   6. [CARD-REFUND-LOOKUP] PowerTranz's written answer to Swift (9 Nov 2026):
//      the lookup works for every transaction type, and refunds
//      (partial ones and Merchant Portal ones included) are supported. So a
//      refund Swift sent whose answer is not known is checked by reading the
//      ORIGINAL transaction's record (lookupRefund): its OrderSummary
//      TotalCreditAmount (or VoidDateTime) says whether exactly what Swift
//      asked back (the whole payment, or the part) went back. Only when a person asks (two people), never as the normal flow;
//      the refund is never sent again.
//   7. [OWNER 10 Nov 2026 · PARTLY USED CARD PAYMENT] A refund may be PART of
//      the payment: "Powertranz supports partial capture and refund ... You
//      cannot void a transaction partially", and "Partial capture, partial
//      refund and void after capture, are features that should be supported by
//      acquiring banks" (PowerTranz developer docs, Authorization Result); its
//      written answer to Swift (9 Nov 2026) says the same. It is the same call
//      (sec. 5.2 / 7.5) with the part as TotalAmount, and refund() counts only
//      an approval of exactly the amount asked; a refusal is `failed`. The
//      lookup judges a partial refund against that part (judgeRefundRecord).
//
// What the guide does NOT document, so this provider does not do it:
//   - charging a saved card without the cardholder present: a token charge
//     still needs the browser for 3-D Secure (sec. 7.8). So `savesCards` is
//     false, no ENROLL page is made, and an off-session charge answers
//     requires_action (no penalty, "Confirm your card") without any call;
//   - a card's last 4 digits or expiry in any response (sec. 6);
//   - the 3-D Secure proof on the transaction lookup (5.): the real records
//     carry none, so the lookup alone never books — the service also needs the
//     completion's own approval, stored when it arrived (readCompletion);
//   - whether OrderSummary.TotalCreditAmount counts only APPROVED refunds (never
//     a pending, declined or reversed attempt): Swift ASSUMES it does (6.), and
//     real staging records of refunds pin it before cards go live (the records
//     of 10 Nov 2026 hold a sale and a void, no refund yet);
//   - whether the original transaction's record lists the refunds made on it,
//     each with its own TransactionIdentifier (asked): Swift reads no refund
//     id from it. A refund confirmed by the lookup (6.) is recorded under a
//     reference Swift makes from the original transaction (ASSUMED enough for
//     the books until PowerTranz says; the portal shows the refund's own id);
//   - the time zone of the record's dates: none is named in the record;
//     PowerTranz says its times are ADT (12 Nov 2026), and the staging records
//     of 10 Nov 2026 read as UTC-4 (Atlantic time in November). Swift reads them
//     as Atlantic time (RECORD_TIME_ZONE); whether production keeps UTC-3 all
//     year is asked; every date window keeps a day's margin (VOID_DATE_SKEW_MS);
//   - which code a void of a SETTLED sale, or a refund of an UNSETTLED one,
//     answers (Appendix 1 has 386 "Trxn is closed" and 384 "Invalid refund",
//     undocumented for these): Swift never branches on them; any refusal is
//     `failed` and a person checks the payment with the card provider.
// Any answer the guide does not document is `unknown`, never success.
//
// Secrets (sec. 4 headers) come from the secrets store through the process
// environment and are never logged, echoed or put in an error message.
// ---------------------------------------------------------------------------

export const POWERTRANZ_PROVIDER = 'powertranz';
/** sec. 2.1 diagram ("base url"), sec. 2.3: the staging API root. Production's is "TBD — provided to merchant once
 *  staging tests are validated" (sec. 2.3), so production always names its own. */
export const POWERTRANZ_SANDBOX_ROOT = 'https://staging.ptranz.com';

/** sec. 3 endpoint table: <API Root>/api/... */
const PATH = {
  alive: '/api/alive',          // sec. 3: GET, non-financial
  sale: '/api/spi/sale',        // sec. 3; sec. 7.2 HPP example
  riskMgmt: '/api/spi/riskmgmt', // sec. 3: non-financial
  payment: '/api/spi/payment',  // sec. 3; sec. 7.3
  refund: '/api/refund',        // sec. 3; sec. 7.5
  void: '/api/void',            // sec. 3; sec. 7.6
  /** [CARD-LOOKUP] PowerTranz's written answer to Swift (4 Nov 2026): GET <root>/api/Transactions/{id}. */
  transactions: '/api/Transactions/',
} as const;

/** [CARD-LOOKUP] The first read of a transaction may run at once; each later read waits twice as long as the last
 *  (1, 2, 4 ... minutes), never more than 30 minutes. Per transaction, shared by every server (Redis). */
export const LOOKUP_BACKOFF_FIRST_MS = 60_000;
export const LOOKUP_BACKOFF_MAX_MS = 30 * 60_000;
/** [REVIEW-2460-B B8] A transaction's backoff record outlives its longest window by far: one day. */
const LOOKUP_GATE_TTL_MS = 24 * 60 * 60_000;
/** [REVIEW-2460-B B7] The lookup runs inside a partner's request (after a completion that may have taken 30 s):
 *  shorter than the other calls, so the page answers well inside any proxy's patience. */
export const LOOKUP_TIMEOUT_MS = 10_000;
/** [REVIEW-2460-A S2-1 · B B2 · DELTA D1] A VoidDateTime counts only when it is a real date between the session's start
 *  and the read, each widened by this margin: the answer names no time zone (read as Atlantic time, RECORD_TIME_ZONE), and a day
 *  covers any zone error. Earlier dates ("0001-01-01", a default) and later ones ("9999-12-31", a "no date" maximum)
 *  are not a reversal. */
export const VOID_DATE_SKEW_MS = 24 * 60 * 60_000;
/** [VOID-REFUND-CHECK F8 · PowerTranz 12 Nov 2026: "PowerTranz times are ADT"] The zone PowerTranz's record dates are
 *  written in (they name none): Atlantic time, read through the IANA zone (Bermuda, PowerTranz's home: UTC-4 in winter,
 *  UTC-3 in summer), never a fixed offset. The staging records of 10 Nov 2026 (read at 05:04Z, dated 01:03, a void
 *  Swift sent moments before) are UTC-4, as Atlantic time is in November. Whether production keeps ADT (UTC-3) all
 *  year is asked (VOID-REFUND-CHECK Q-d): VOID_DATE_SKEW_MS covers that hour either way. */
export const RECORD_TIME_ZONE = 'Atlantic/Bermuda';

/** The zone's UTC offset at an instant, in ms (the wall clock read back as UTC, minus the instant). */
function zoneOffsetMs(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((x) => x.type === type)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
}

/** A wall-clock time in RECORD_TIME_ZONE (given as if it were UTC) as the instant it names. */
function recordWallClockToInstant(naiveUtcMs: number): number {
  let instant = naiveUtcMs - zoneOffsetMs(RECORD_TIME_ZONE, naiveUtcMs);
  instant = naiveUtcMs - zoneOffsetMs(RECORD_TIME_ZONE, instant);
  return instant;
}

const REQUEST_TIMEOUT_MS = 15_000;
/** The completion goes on to the issuing bank (sec. 2.2 1.7): give it longer. */
const COMPLETION_TIMEOUT_MS = 30_000;
// [CARDS S2] A claimed completion is answering until its own deadline plus a
// margin to record the answer (card-provider.ts); never shorter than the call.
if (COMPLETION_CLAIM_WAIT_MS < COMPLETION_TIMEOUT_MS + 5_000) throw new Error('COMPLETION_CLAIM_WAIT_MS is shorter than the completion deadline');
/** sec. 2.2 1.7: "The payment completion needs to be sent within 5 minutes." */
export const SPI_TOKEN_LIFETIME_MS = 5 * 60_000;
/** A page's facts outlive it long enough for any reconciliation (as the simulator's). */
const RECORD_RETAIN_MS = 30 * 24 * 60 * 60_000;
/** [REVIEW-G S4-2 on #1524] The sandbox self-check's page record is only proof
 *  that the page set up: it is abandoned at once and kept one hour, never the
 *  30-day card record retention. Nothing reads it afterwards. */
export const SELF_CHECK_RECORD_TTL_MS = 60 * 60_000;
/** The sandbox self-check's preprocessing line: what SP4 proves, and no more (selfCheck). */
export const SELF_CHECK_PAGE_LINE = 'a sale with this hosted page is preprocessed (SP4)';
/** [CARD-STAGING-TEST 10 Nov 2026] The sandbox self-check's page line: the page itself, opened as the partner's
 *  browser opens it (openHostedPage). SP4 alone said OK for a page set PowerTranz then refused (757). */
export const SELF_CHECK_PAGE_OPENS: Readonly<Record<HostedPageCheck, string>> = {
  shown: 'the hosted payment page opens (PowerTranz shows its card form)',
  not_found: 'the hosted payment page opens (PowerTranz cannot find this page: check POWERTRANZ_PAGE_SET, with PTZ/, and POWERTRANZ_PAGE_NAME)',
  refused: 'the hosted payment page opens (PowerTranz refused the page)',
  could_not_tell: 'the hosted payment page opens (could not tell: no readable page came back)',
};

/** ISO 4217 numeric codes (sec. 5.1 CurrencyCode "Must use numeric currency code (ISO 4217)"). */
export const CURRENCY_NUMERIC: Readonly<Record<string, string>> = {
  GYD: '328', USD: '840', TTD: '780', JMD: '388', BBD: '052', XCD: '951',
};
const CURRENCY_ALPHA: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(CURRENCY_NUMERIC).map(([a, n]) => [n, a]));

/** sec. 5.1 ThreeDSecure: every Sale Swift sends asks for 3-D Secure (OWNER RULING 10 Nov 2026: the completion's
 *  approval books only because the Sale was a 3-D Secure one; confirm checks the page record says so). */
const SALE_THREE_D_SECURE = true as const;
/** sec. 5.1 ExtendedData.ThreeDSecure.ChallengeWindowSize: 5 = 100% (the page fills the phone or the card frame). */
const CHALLENGE_WINDOW_FULL = 5;
/** sec. 5.1 ChallengeIndicator 01 = no preference (the issuer decides, sec. 9.3). */
const CHALLENGE_NO_PREFERENCE = '01';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PowerTranzConfig {
  /** Swift's label for the merchant account tokens and sessions are bound to [C2]. */
  account: string;
  environment: CardRailEnvironment;
  /** The <API Root> of sec. 3, with no path: https://staging.ptranz.com in the sandbox. */
  apiRoot: string;
  /** sec. 4 PowerTranz-PowerTranzId (M, AN 25). */
  powerTranzId: string;
  /** sec. 4 PowerTranz-PowerTranzPassword (M, AN 100). */
  password: string;
  /** sec. 4 PowerTranz-GatewayKey (C, GUID 36): "Do not send until value is provided by PowerTranz". */
  gatewayKey?: string;
  /** sec. 5.1 ExtendedData.HostedPage.PageSet / PageName (AN 50 each). The set always starts with "PTZ/" (PAGE_SET_PREFIX). */
  pageSet: string;
  pageName: string;
  /** Swift's public API origin: its hosted card page and MerchantResponseUrl live there. */
  publicBaseUrl: string;
}

const ACCOUNT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * PowerTranz's hosted page guides (SPI-HPP and SPI-3DS-HPP, "Note !"): "Pages created in Powertranz Merchant Portal
 * MUST contain the 'PTZ/' prefix in the Page Set request. If this prefix is missing, the transaction will fail, and
 * the Hosted Payment Page will not be loaded correctly." Every hosted page is made in the portal (the same guides), so
 * the set is always written with it — e.g. the portal's set SWIFT is written PTZ/SWIFT. [CARD-STAGING-TEST 10 Nov
 * 2026] Without it the sandbox preprocessed the Sale (SP4) and then answered the page itself with IsoResponseCode 12,
 * error 757 "Hosted page not found". Swift never adds the prefix for the owner (what is set is what is sent): a set
 * without it is refused, naming the setting, at the setup tool, the self-check and the boot.
 */
export const PAGE_SET_PREFIX = 'PTZ/';
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The environment names this provider reads (the setup tool asks for exactly these). */
export const POWERTRANZ_ENV = {
  secrets: ['POWERTRANZ_ID', 'POWERTRANZ_PASSWORD', 'POWERTRANZ_GATEWAY_KEY'],
  settings: ['POWERTRANZ_API_URL', 'POWERTRANZ_PAGE_SET', 'POWERTRANZ_PAGE_NAME'],
} as const;

/** A configuration error names the setting, never its value. */
export class PowerTranzConfigError extends Error {
  override readonly name = 'PowerTranzConfigError';
}

function httpsOrigin(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PowerTranzConfigError(`${what} must be an https:// origin`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new PowerTranzConfigError(`${what} must be a bare https:// origin (no path, query or credentials)`);
  }
  return url.origin;
}

/** Looks like a test system: never acceptable for live money. */
const TEST_HOST = /staging|sandbox|test|uat|dev\.|localhost/i;
/** [Review S4] The guide's API lives under ptranz.com (sec. 2.3: staging.ptranz.com, production <TBD>.ptranz.com). */
const PTRANZ_HOST = /^(?:[a-z0-9-]+\.)*ptranz\.com$/i;

export function powerTranzConfigFromEnv(env: Record<string, string | undefined> = process.env): PowerTranzConfig {
  const environment = env['CARD_RAIL_ENVIRONMENT'];
  if (environment !== 'sandbox' && environment !== 'live') {
    throw new PowerTranzConfigError('CARD_RAIL_ENVIRONMENT must be sandbox or live for the card provider');
  }
  if (isProduction(env) && environment !== 'live') {
    throw new PowerTranzConfigError('Production takes real cards only: CARD_RAIL_ENVIRONMENT must be live');
  }
  // [Review S3] Live cards run only on the production server: a test server
  // never charges real cards, whatever it is told.
  if (environment === 'live' && !isProduction(env)) {
    throw new PowerTranzConfigError('Live cards run only on the production server: CARD_RAIL_ENVIRONMENT must be sandbox here');
  }
  const account = env['CARD_RAIL_ACCOUNT'] ?? '';
  if (!ACCOUNT_LABEL.test(account)) {
    throw new PowerTranzConfigError('CARD_RAIL_ACCOUNT must be a short label (letters, digits, dot, dash, underscore; at most 64)');
  }
  const rawRoot = env['POWERTRANZ_API_URL'] || (environment === 'sandbox' ? POWERTRANZ_SANDBOX_ROOT : '');
  if (!rawRoot) throw new PowerTranzConfigError('POWERTRANZ_API_URL is required for live cards (the guide gives production its own address, sec. 2.3)');
  const apiRoot = httpsOrigin(rawRoot, 'POWERTRANZ_API_URL');
  if (!PTRANZ_HOST.test(new URL(apiRoot).hostname)) {
    throw new PowerTranzConfigError('POWERTRANZ_API_URL must be the card provider\'s own address (a ptranz.com host, sec. 2.3)');
  }
  if (environment === 'live' && TEST_HOST.test(apiRoot)) {
    throw new PowerTranzConfigError('POWERTRANZ_API_URL points at a test system, but CARD_RAIL_ENVIRONMENT is live');
  }
  if (environment === 'sandbox' && !TEST_HOST.test(apiRoot)) {
    throw new PowerTranzConfigError('CARD_RAIL_ENVIRONMENT is sandbox, but POWERTRANZ_API_URL is not a test system');
  }
  const powerTranzId = env['POWERTRANZ_ID'] ?? '';
  if (powerTranzId.length < 1 || powerTranzId.length > 25) throw new PowerTranzConfigError('POWERTRANZ_ID is missing or longer than 25 characters (sec. 4)');
  const password = env['POWERTRANZ_PASSWORD'] ?? '';
  if (password.length < 1 || password.length > 100) throw new PowerTranzConfigError('POWERTRANZ_PASSWORD is missing or longer than 100 characters (sec. 4)');
  const gatewayKey = env['POWERTRANZ_GATEWAY_KEY'] || undefined;
  if (gatewayKey !== undefined && !GUID.test(gatewayKey)) throw new PowerTranzConfigError('POWERTRANZ_GATEWAY_KEY must be the GUID PowerTranz provided (sec. 4), or unset');
  const pageSet = env['POWERTRANZ_PAGE_SET'] ?? '';
  const pageName = env['POWERTRANZ_PAGE_NAME'] ?? '';
  if (pageSet.length < 1 || pageSet.length > 50 || pageName.length < 1 || pageName.length > 50) {
    throw new PowerTranzConfigError('POWERTRANZ_PAGE_SET and POWERTRANZ_PAGE_NAME are required (sec. 5.1, at most 50 characters): cards are typed only on the hosted page');
  }
  if (!pageSet.startsWith(PAGE_SET_PREFIX) || pageSet.trim().length <= PAGE_SET_PREFIX.length || pageSet !== pageSet.trim()) {
    throw new PowerTranzConfigError('POWERTRANZ_PAGE_SET must start with PTZ/ and then the set\'s name, as the merchant portal\'s pages are sent (PowerTranz\'s hosted page guide; without it the page is not found, error 757): e.g. PTZ/SWIFT for the set SWIFT');
  }
  const publicBaseUrl = httpsOrigin(env['API_PUBLIC_URL'] ?? '', 'API_PUBLIC_URL (where the bank sends the browser back)');
  return { account, environment, apiRoot, powerTranzId, password, ...(gatewayKey ? { gatewayKey } : {}), pageSet, pageName, publicBaseUrl };
}

// ---------------------------------------------------------------------------
// Pure readers (exported for the contract tests)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Major units for TotalAmount (sec. 5.1 DEC 18,3), from Swift's minor units. */
export function totalAmountOf(amountMinor: number, currencyCode: string): number {
  const exponent = currencyInfo(currencyCode).exponent;
  return amountMinor / 10 ** exponent;
}

/** Minor units from a TotalAmount (sec. 6 DEC 18,3) — null unless it is exact in the currency's minor unit. */
export function minorOfTotalAmount(value: unknown, currencyCode: string): number | null {
  if (!isKnownCurrency(currencyCode)) return null;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,15})(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const exponent = currencyInfo(currencyCode).exponent;
  const fraction = (m[2] ?? '').padEnd(3, '0');
  if (fraction.slice(exponent).replace(/0/g, '') !== '') return null; // finer than the currency's minor unit
  const minor = Number(m[1]) * 10 ** exponent + Number(fraction.slice(0, exponent) || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

/** sec. 6 CurrencyCode is numeric; Swift speaks ISO alpha. Unknown numeric -> null. */
export function alphaOfCurrency(value: unknown): string | null {
  const code = typeof value === 'number' ? String(value).padStart(3, '0') : str(value)?.trim();
  return code ? CURRENCY_ALPHA[code] ?? null : null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The fields a payload may carry that are tokens or personal data: digested, never kept in a digest's preimage in the
 *  clear. [CARD-STAGING-TEST 10 Nov 2026] The real return post also carries CardSuffix (the card's last digits) and
 *  RiskManagement.ThreeDSecure.CardholderInfo (the issuer's message to the cardholder), beside PanToken and BillingAddress. */
const BLINDED = new Set(['SpiToken', 'PanToken', 'RedirectData', 'BillingAddress', 'ShippingAddress', 'CardholderName', 'Cavv', 'Xid', 'FcDetails',
  'CardSuffix', 'CardholderInfo']);
/** A provider payload with its tokens and personal fields replaced by their own digests: the only form of a payload
 *  that is ever digested (and nothing of it is ever stored but the digest). */
export function blinded(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(blinded);
  if (isObject(payload)) {
    return Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, BLINDED.has(k) ? sha256(JSON.stringify(v ?? null)) : blinded(v)]));
  }
  return payload;
}

/** The sha256 of a provider payload with its tokens and personal fields replaced by their own digests. */
export function blindedDigest(payload: unknown): string {
  return rawDigest(blinded(payload));
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** [CARD-STAGING-TEST 10 Nov 2026] The real return post's field that holds the whole result as JSON text. */
export const RETURN_RESPONSE_FIELD = 'Response';
/** The identifiers the real post carries both beside "Response" and inside it: the two copies must agree. */
const RETURN_ECHOES = ['SpiToken', 'TransactionIdentifier', 'OrderIdentifier'] as const;
/** What says "this is a result" in the guide's own samples (sec. 2.2 1.6; HPP guides). */
const looksLikeResult = (o: Record<string, unknown>) => 'IsoResponseCode' in o || 'SpiToken' in o || 'RiskManagement' in o;

export type AuthenticationReading = { result: Record<string, unknown>; note?: undefined } | { result: null; note: string };

/**
 * The 3-D Secure authentication result the browser brought back to MerchantResponseUrl (sec. 2.2 1.6). Two shapes:
 *   - [CARD-STAGING-TEST 10 Nov 2026] the REAL sandbox post: an x-www-form-urlencoded form of three fields, Response
 *     (the whole result as JSON text: IsoResponseCode, RiskManagement.ThreeDSecure, the identifiers, PanToken,
 *     BillingAddress ...), TransactionIdentifier and SpiToken. The result is read from Response. Its SpiToken,
 *     TransactionIdentifier and OrderIdentifier must equal the copies beside it whenever both are there (an
 *     identifier only beside it is carried into the result, so it is still checked against the page Swift holds);
 *     an identifier inside it that is not text is unreadable. A Response that is not a JSON object, or a post that
 *     ALSO carries a result beside it (IsoResponseCode or RiskManagement), is unreadable — never a result;
 *   - PowerTranz's documented samples (the HPP guides; sec. 2.2 1.6, Appendix 2: posted "as Json"): the result's
 *     fields at the top level; nested objects arrive as JSON text (the return route flattens them).
 * Anything else reads as no result, with a note saying why. A result grants nothing: authenticationDecision.
 */
export function readAuthenticationReturn(params: Readonly<Record<string, string>>): AuthenticationReading {
  const top: Record<string, unknown> = { ...params };
  const response = params[RETURN_RESPONSE_FIELD];
  if (response !== undefined) {
    const inner = jsonObject(response);
    if (!inner || !looksLikeResult(inner)) return { result: null, note: 'RETURN_RESPONSE_UNREADABLE' };
    if ('IsoResponseCode' in top || 'RiskManagement' in top) return { result: null, note: 'RETURN_RESPONSE_AMBIGUOUS' };
    const result: Record<string, unknown> = { ...inner };
    for (const name of RETURN_ECHOES) {
      const outer = params[name];
      const own = inner[name];
      if (own !== undefined && own !== null && typeof own !== 'string') return { result: null, note: `RETURN_${name.toUpperCase()}_UNREADABLE` };
      if (outer === undefined) continue;
      if (typeof own !== 'string') { result[name] = outer; continue; }
      const same = name === 'TransactionIdentifier' ? own.toLowerCase() === outer.toLowerCase() : name === 'OrderIdentifier' ? own.trim() === outer.trim() : own === outer;
      if (!same) return { result: null, note: `RETURN_${name.toUpperCase()}_DISAGREES` };
    }
    return { result };
  }
  if (looksLikeResult(top)) {
    const rm = str(top['RiskManagement']);
    return { result: { ...top, ...(rm !== undefined ? { RiskManagement: jsonObject(rm) ?? rm } : {}) } };
  }
  return { result: null, note: 'NO_AUTHENTICATION_RESULT' };
}

// ---------------------------------------------------------------------------
// [CARD-STAGING-TEST 10 Nov 2026] Opening the hosted page, for the owner's sandbox self-check only (never a payment).
// PowerTranz's guides: RedirectData is "an HTML form accompanied by JavaScript code" that the cardholder's browser
// posts to PowerTranz, which then shows the hosted page (their samples: one <form action=... method="POST"> of hidden
// inputs and a script that submits it). The staging test saw exactly that: the form posts to the API root's
// /api/spi/Conductor, which answers the card form (CardholderName, CardNo, ...) — or, for a page set PowerTranz does
// not know, a page that posts straight back to MerchantResponseUrl the three-field result of section 7 with
// Errors 757 "Hosted page not found". Swift does what the browser does, once, and reads which of the two came back.
// Anything else is "could not tell", a FAIL: never an OK.
// ---------------------------------------------------------------------------

export type HostedPageCheck = 'shown' | 'not_found' | 'refused' | 'could_not_tell';

const HTML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", '#34': '"', '#x27': "'", '#x22': '"' };
function htmlText(text: string): string {
  return text.replace(/&(amp|quot|apos|lt|gt|#39|#34|#x27|#x22);/gi, (_m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? _m);
}
function htmlAttr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? htmlText(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}
type HtmlForm = { action: string | undefined; method: string; inputs: Array<[string, string]> };
function htmlForms(html: string): HtmlForm[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((m) => ({
    action: htmlAttr(m[1] ?? '', 'action'),
    method: (htmlAttr(m[1] ?? '', 'method') ?? 'GET').toUpperCase(),
    inputs: [...(m[2] ?? '').matchAll(/<input\b([^>]*)>/gi)]
      .map((i): [string, string] => [htmlAttr(i[1] ?? '', 'name') ?? '', htmlAttr(i[1] ?? '', 'value') ?? ''])
      .filter(([name]) => name !== ''),
  }));
}

/** The one POST form RedirectData carries (its action and fields), or null when it is not exactly that. */
export function redirectForm(html: string): { action: string; fields: Array<[string, string]> } | null {
  const forms = htmlForms(html);
  if (forms.length !== 1 || !forms[0]!.action || forms[0]!.method !== 'POST') return null;
  return { action: forms[0]!.action, fields: forms[0]!.inputs };
}

/** What PowerTranz answered the opened page with: its card form (`shown`: the CardNo and CardCVV2 fields), or a post
 *  straight back to the return address (`not_found` for error 757, `refused` otherwise); anything else `could_not_tell`. */
export function hostedPageAnswer(html: string, returnUrl: string, base: string): HostedPageCheck {
  let back: URL;
  try { back = new URL(returnUrl); } catch { return 'could_not_tell'; }
  const toReturn = (action: string | undefined) => {
    try {
      const at = new URL(action ?? '', base);
      return at.origin === back.origin && at.pathname === back.pathname;
    } catch { return false; }
  };
  for (const form of htmlForms(html)) {
    const response = form.inputs.find(([name]) => name === RETURN_RESPONSE_FIELD);
    const result = response ? jsonObject(response[1]) : null;
    if (!toReturn(form.action) && !result) continue;
    const codes = result && Array.isArray(result['Errors']) ? result['Errors'].filter(isObject).map((e) => String(e['Code'] ?? '')) : [];
    return codes.includes('757') ? 'not_found' : 'refused';
  }
  // [REVIEW-2466-B F5] Shown only when PowerTranz's own card form is there: its card-number and security-code fields
  // (CardNo, CardCVV2: the hosted page's field names on staging). Any other page, inputs or not, is "could not tell".
  const fields = new Set([...html.matchAll(/<input\b([^>]*)>/gi)].map((m) => htmlAttr(m[1] ?? '', 'name') ?? ''));
  return fields.has('CardNo') && fields.has('CardCVV2') ? 'shown' : 'could_not_tell';
}

/** The result alone (null when there is none): readAuthenticationReturn. */
export function authenticationResultOf(params: Readonly<Record<string, string>>): Record<string, unknown> | null {
  return readAuthenticationReturn(params).result;
}

/**
 * [CARD-STAGING-TEST 10 Nov 2026] What a return's digest is taken of: every field, a field holding JSON read as its
 * object (so the tokens and personal data INSIDE the real post's Response — PanToken, BillingAddress, CardSuffix,
 * CardholderInfo, Cavv, Xid, SpiToken — are blinded like any other), and a Response that is not JSON replaced by its own
 * digest. Only the sha256 of this is ever kept; the post itself is never stored, logged or echoed.
 */
export function returnEvidence(params: Readonly<Record<string, string>>): unknown {
  return blinded(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, jsonObject(v) ?? (k === RETURN_RESPONSE_FIELD ? sha256(v) : v)])));
}

export type AuthenticationDecision =
  | { proceed: true; note: string }
  | { proceed: false; note: string };

/**
 * Swift's decision on the browser's authentication result (sec. 2.2 1.7: "the
 * merchant determines if they want to proceed with payment completion"):
 *   - proceed ONLY when the 3-D Secure check completed (ResponseCode "3D0",
 *     sec. 8.1) with AuthenticationStatus Y (verified) or A (attempted) (sec. 8.3);
 *   - never when it is N or R (sec. 8.3: "payment completion will not be
 *     permitted"), U (could not be performed), 3D1 (3-D Secure not available
 *     for the card: sec. 9.1 lets the merchant choose; Swift declines — no
 *     liability shift without authentication), 3D3 (error), or anything else;
 *   - never when the result names another page: its SpiToken, transaction or
 *     order differ from the ones Swift holds.
 * The browser's result is untrusted (no signature, no server-side copy,
 * sec. 2.2 1.6, sec. 3): this decision can only make Swift DECLINE. A
 * "proceed" grants nothing — it lets Swift ask PowerTranz, server to server,
 * whose completion answer (with its own 3-D Secure proof) is the money truth.
 */
export function authenticationDecision(
  result: Record<string, unknown> | null,
  held: { spiToken?: string; txnId: string; orderId: string },
): AuthenticationDecision {
  if (!result) return { proceed: false, note: 'NO_AUTHENTICATION_RESULT' };
  const echoedToken = str(result['SpiToken']);
  if (echoedToken !== undefined && held.spiToken !== undefined && echoedToken !== held.spiToken) return { proceed: false, note: 'OTHER_PAGE_TOKEN' };
  const echoedTxn = str(result['TransactionIdentifier']);
  if (echoedTxn !== undefined && echoedTxn.toLowerCase() !== held.txnId.toLowerCase()) return { proceed: false, note: 'OTHER_TRANSACTION' };
  const echoedOrder = str(result['OrderIdentifier']);
  if (echoedOrder !== undefined && echoedOrder.trim() !== held.orderId) return { proceed: false, note: 'OTHER_ORDER' };
  const rm = isObject(result['RiskManagement']) ? result['RiskManagement'] : null;
  const tds = rm && isObject(rm['ThreeDSecure']) ? rm['ThreeDSecure'] : null;
  const code = str(tds?.['ResponseCode']) ?? str(result['IsoResponseCode']);
  const status = str(tds?.['AuthenticationStatus']);
  if (code === '3D0' && (status === 'Y' || status === 'A')) return { proceed: true, note: `3D0_${status}` };
  // The browser's words are untrusted: only a short code of letters and digits reaches the note (and its failure reason).
  const shown = (v: string | undefined) => (v ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'NONE';
  // [CARD-STAGING-TEST 10 Nov 2026] PowerTranz refusing its OWN page is no bank check: a set-up error (the page set
  // without PTZ/ came back as IsoResponseCode 12 with Errors 757 "Hosted page not found", and no 3-D Secure block).
  // Never shown to the partner as "your bank's check didn't go through": PAGE_REFUSED (confirm, failureCodeOf).
  const iso = str(result['IsoResponseCode']);
  const errors = Array.isArray(result['Errors']) ? result['Errors'].filter(isObject).map((e) => shown(String(e['Code'] ?? ''))).filter((c) => c !== 'NONE') : [];
  if (!tds && (errors.length > 0 || (iso !== undefined && !/^(?:3D|HP)\d$/.test(iso)))) {
    return { proceed: false, note: `PAGE_REFUSED_${shown(iso)}${errors.length ? `_${errors.slice(0, 3).join('_')}` : ''}` };
  }
  return { proceed: false, note: `NOT_AUTHENTICATED_${shown(code)}_${shown(status)}` };
}

/**
 * [Opus S4-c] sec. 8.4 "ECI value", as an ALLOW-list: the values that say 3-D
 * Secure authentication was successful or attempted —
 *   A) Visa and American Express: 05 successful, 06 attempted (07 failed or not
 *      available: considered non-3DS);
 *   B) Mastercard: 02 successful, 01 attempted (00 failed or not available:
 *      considered non-3DS). N2 / N0 are NPA (non-payment authentication)
 *      results, never a Sale's proof.
 * When the answer names the card's brand, only that brand's values count; when
 * it does not, the values of every brand (they do not collide). Anything else —
 * 07, 00, N2, N0, an undocumented value — is not authenticated.
 */
const AUTHENTICATED_ECI = {
  visaAmex: new Set(['05', '06']),
  mastercard: new Set(['02', '01']),
  anyBrand: new Set(['05', '06', '02', '01']),
} as const;

function eciSetFor(brand: unknown): ReadonlySet<string> {
  const name = str(brand)?.trim().toLowerCase().replace(/[\s_-]+/g, '') ?? '';
  if (name === 'visa' || name === 'amex' || name === 'americanexpress') return AUTHENTICATED_ECI.visaAmex;
  if (name === 'mastercard' || name === 'mc') return AUTHENTICATED_ECI.mastercard;
  return AUTHENTICATED_ECI.anyBrand;
}

/** The answer's ECI as two characters: a number (5) reads like its text ("05"). Undefined when absent or not an ECI. */
function eciOf(raw: unknown): string | undefined {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 0 && raw <= 99 ? String(raw).padStart(2, '0') : undefined;
  const text = str(raw)?.trim();
  return text ? text : undefined;
}

/**
 * [OWNER RULING 10 Nov 2026 · CARD-STAGING-TEST B2] PowerTranz's OWN completion answer is NOT required to carry 3-D
 * Secure fields: its documented sample (the HPP guides, "/Payment Response") has no RiskManagement, the real sandbox
 * answer had none, and PowerTranz declines a completion whose authentication failed ("declined by default", sec. 8.3).
 * Requiring them voided a real approval. But when the answer DOES carry RiskManagement.ThreeDSecure, it must not
 * contradict the approval: a ResponseCode other than 3D0 (sec. 8.1), an AuthenticationStatus other than Y or A
 * (sec. 8.3), or an ECI that is not a success or attempt value for the card's brand (sec. 8.4), or a block that
 * cannot be read. Returns that contradiction's note,
 * or null. Nothing the browser sent counts here.
 */
export function serverAuthenticationContradiction(json: Record<string, unknown>): string | null {
  const rm = json['RiskManagement'];
  if (rm === undefined || rm === null) return null;
  const tds = isObject(rm) ? rm['ThreeDSecure'] : rm;
  if (tds === undefined || tds === null) return null;
  if (!isObject(tds)) return 'SERVER_3DS_UNREADABLE';
  const shown = (v: unknown) => String(v).replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'UNREADABLE';
  // [REVIEW-2466-A F1] Its own ResponseCode, when there, must be the completed check (3D0, sec. 8.1): 3D1 (3-D Secure
  // not available), 3D3 (an error) or any other code says no authentication took place, whatever else is missing.
  const code = tds['ResponseCode'];
  if (code !== undefined && code !== null && code !== '3D0') return `SERVER_3DS_${shown(code)}`;
  const status = tds['AuthenticationStatus'];
  if (status !== undefined && status !== null && status !== 'Y' && status !== 'A') return `SERVER_3DS_${shown(status)}`;
  const raw = tds['Eci'];
  if (raw === undefined || raw === null) return null;
  const eci = eciOf(raw);
  if (eci === undefined || !eciSetFor(json['CardBrand']).has(eci)) return `SERVER_ECI_${shown(raw)}`;
  return null;
}

/** Appendix 1 numeric response codes that say an earlier identical call may have been taken. */
const DUPLICATE_CODES = new Set(['787', '788', '387']);
/** Payment ISO codes (Appendix 1) that do not say the bank declined: the money may or may not have moved. */
const AMBIGUOUS_ISO = new Set(['06', '09', '68', '91', '94', '96', '98', '99']);

function errorCodes(json: Record<string, unknown>): string[] {
  const errors = json['Errors'];
  if (!Array.isArray(errors)) return [];
  return errors.filter(isObject).map((e) => String(e['Code'] ?? '')).filter(Boolean);
}

export type CompletionReading =
  | { status: 'succeeded'; amountMinor: number; currencyCode: string; completionEvidence: CardCompletionEvidence }
  | { status: 'failed'; reason: string }
  /** [Review S2-2] Money may have been taken (an approval, or an answer that
   *  may be one) and Swift cannot book it: it is voided at once (sec. 5.2,
   *  7.6 — before the Sale settles, sec. 7.4), or held for a person. */
  | { status: 'unbookable'; reason: string };

/** What Swift asked for, to check an approval against. */
export interface HeldCompletion { txnId: string; orderId: string; amountMinor: number; currencyCode: string }

/**
 * The completion answer (sec. 6, 7.3, Appendix 1), read for money:
 *   - succeeded ONLY on Approved true AND IsoResponseCode "00" AND naming THIS
 *     page (its TransactionIdentifier — ours or as the original —, its
 *     OrderIdentifier SWIFT-<session>, and TransactionType 2, a Sale, sec. 6)
 *     AND exactly the amount and currency Swift asked for, AND no 3-D Secure
 *     block of its own that contradicts the approval
 *     (serverAuthenticationContradiction; none is required — OWNER RULING
 *     10 Nov 2026: PowerTranz's own approval of the completion of a Sale sent
 *     with ThreeDSecure true is the proof). The answer is only ever read for a
 *     page whose Sale was sent with ThreeDSecure true (confirm checks the page
 *     record before the completion is sent);
 *   - any other approval, a contradictory answer (Approved false with "00"),
 *     a possible duplicate (787 / 788 / 387), a code that is not the bank's
 *     answer (timeouts, system errors), or no Approved flag at all: money may
 *     have been taken that cannot be booked — unbookable (void it);
 *   - Approved false with any other code: the bank declined — failed.
 */
export function readCompletion(json: unknown, held: HeldCompletion): CompletionReading {
  const unbookable = (reason: string): CompletionReading => ({ status: 'unbookable', reason });
  if (!isObject(json)) return unbookable('COMPLETION_UNREADABLE');
  const approved = json['Approved'];
  const iso = str(json['IsoResponseCode']) ?? '';
  const codes = errorCodes(json);
  if (approved === true) {
    if (iso !== '00') return unbookable(`APPROVED_WITH_${iso || 'NO_CODE'}`);
    const mine = held.txnId.toLowerCase();
    const txn = str(json['TransactionIdentifier'])?.toLowerCase();
    const original = str(json['OriginalTrxnIdentifier'])?.toLowerCase();
    if (txn !== mine && original !== mine) return unbookable('APPROVAL_DOES_NOT_NAME_THIS_TRANSACTION');
    if (str(json['OrderIdentifier'])?.trim() !== held.orderId) return unbookable('APPROVAL_DOES_NOT_NAME_THIS_ORDER');
    if (String(json['TransactionType'] ?? '') !== '2') return unbookable('APPROVAL_IS_NOT_A_SALE');
    const contradiction = serverAuthenticationContradiction(json);
    if (contradiction) return unbookable(`APPROVED_UNAUTHENTICATED_${contradiction}`);
    const currencyCode = alphaOfCurrency(json['CurrencyCode']);
    const amountMinor = currencyCode ? minorOfTotalAmount(json['TotalAmount'], currencyCode) : null;
    if (!currencyCode || amountMinor === null) return unbookable('APPROVED_AMOUNT_UNREADABLE');
    if (amountMinor !== held.amountMinor || currencyCode !== held.currencyCode) return unbookable('APPROVED_AMOUNT_MISMATCH');
    const brand = str(json['CardBrand'])?.trim();
    // [OWNER RULING 10 Nov 2026] The stored proof IS this approval: its whitelisted fields, nothing the browser sent,
    // no token and nothing personal (PanToken, RRN, AuthorizationCode stay out).
    return { status: 'succeeded', amountMinor, currencyCode, completionEvidence: {
      Approved: true, IsoResponseCode: '00', TransactionType: 2,
      TransactionIdentifier: held.txnId, OrderIdentifier: held.orderId,
      TotalAmount: totalAmountOf(amountMinor, currencyCode), CurrencyCode: CURRENCY_NUMERIC[currencyCode]!,
      // The brand is kept when the answer named it, so a later re-check judges any ECI the same way.
      ...(brand ? { CardBrand: brand.slice(0, 32) } : {}),
    } };
  }
  if (approved === false) {
    if (iso === '00') return unbookable('DECLINED_WITH_APPROVAL_CODE');
    if (codes.some((c) => DUPLICATE_CODES.has(c))) return unbookable(`POSSIBLE_DUPLICATE_${codes.join('_')}`);
    if (AMBIGUOUS_ISO.has(iso)) return unbookable(`NOT_THE_BANKS_ANSWER_${iso}`);
    return { status: 'failed', reason: `DECLINED_${iso || 'NO_CODE'}${codes.length ? `_${codes.join('_')}` : ''}` };
  }
  return unbookable('NO_APPROVED_FLAG');
}

/**
 * [CARD-LOOKUP] PowerTranz's record of ONE transaction (GET <root>/api/Transactions/{id}), read strictly.
 * DOCUMENTED for this call (PowerTranz's written answer to Swift, 4 Nov 2026): VoidDateTime ("present = reversed")
 * and OrderSummary { SettledAmount, TotalCaptureAmount, TotalCreditAmount }.
 * [CARD-STAGING-TEST 10 Nov 2026] The REAL records of PowerTranz's staging sandbox (redacted copies are the test
 * fixtures) replace the field names Swift had assumed:
 *   - top level: TransactionIdentifier, TransactionType (a number: 2 = Sale), IsoResponseCode, ResponseMessage,
 *     CurrencyCode ("328"), TotalAmount (major units), Tax/Tip/OtherAmount, TransactionDateTime, and on a completed
 *     sale AuthorizationCode and Rrn. NO Approved and NO OrderIdentifier: Approved is read only if it ever appears
 *     (and must then be true), the order only from OrderSummary (a top-level one, if it ever appears, must agree);
 *   - OrderSummary: CaptureCount, CreditCount, TotalCaptureAmount, TotalCreditAmount, SettledAmount (major units),
 *     OriginalTrxnDateTime; on a completed sale also OrderIdentifier ("SWIFT-<session>"), CurrencyCode,
 *     OriginalTrxnIdentifier and LastCaptureDateTime; and VoidDateTime ONLY once voided — never at the top level.
 *     IsoResponseCode stays "00" after a void and TotalCaptureAmount keeps the sale's amount, so VoidDateTime is
 *     the only sign of the void: it is read from OrderSummary (and from the top level too, should it ever appear);
 *   - a page only preprocessed or authenticated (IsoResponseCode SP4 / 3D0) has no order, currency or void in its
 *     OrderSummary, and OriginalTrxnDateTime "0001-01-01T00:00:00";
 *   - dates name no zone: Atlantic time (RECORD_TIME_ZONE; PowerTranz 12 Nov 2026: "ADT").
 * Every field above that every real record carries must be present and of its type (SettledAmount may be absent);
 * one that only some records carry must, when present, be of its type and agree with the rest (OrderSummary's
 * CurrencyCode with the top level's, OriginalTrxnIdentifier with TransactionIdentifier). Anything missing, mistyped,
 * finer than the currency or disagreeing makes the whole answer unreadable — null, never a guess. A VoidDateTime is a
 * reversal only when it is a real date between `voidNotBeforeMs` and `voidNotAfterMs` (voidDateOf); any other value is
 * unreadable.
 */
export interface PowerTranzTransactionRecord {
  transactionIdentifier: string;
  /** OrderSummary.OrderIdentifier; null on a record that names no order (a page never completed: SP4 / 3D0). */
  orderIdentifier: string | null;
  transactionType: string;
  /** The real records carry no Approved: null. When one is present it is read (and must be true to book). */
  approved: boolean | null;
  isoResponseCode: string;
  currencyCode: string;
  totalAmountMinor: number;
  captureCount: number;
  creditCount: number;
  voided: boolean;
  totalCaptureMinor: number;
  totalCreditMinor: number;
}

/** A record date as an instant: ISO date and time (a space allowed for the T), optional fraction and zone; no zone
 *  is read as RECORD_TIME_ZONE (Atlantic time). Null for anything else — a placeholder, a default date, an impossible date. */
export function voidDateOf(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null; // 30 February and the like
  const ms = m[7] ? Date.parse(text.trim().replace(' ', 'T')) : recordWallClockToInstant(Date.parse(`${text.trim().replace(' ', 'T')}Z`));
  return Number.isFinite(ms) ? ms : null;
}

/** A count in OrderSummary: a whole number, zero or more. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function readTransactionRecord(json: unknown, voidNotBeforeMs = Date.UTC(2000, 0, 1), voidNotAfterMs = Date.now() + VOID_DATE_SKEW_MS): PowerTranzTransactionRecord | null {
  if (!isObject(json)) return null;
  const summary = json['OrderSummary'];
  if (!isObject(summary)) return null;
  const transactionIdentifier = str(json['TransactionIdentifier'])?.trim();
  const type = json['TransactionType'];
  const transactionType = typeof type === 'number' && Number.isInteger(type) ? String(type) : str(type)?.trim();
  const isoResponseCode = str(json['IsoResponseCode'])?.trim();
  const currencyCode = alphaOfCurrency(json['CurrencyCode']);
  if (!transactionIdentifier || !transactionType || !/^\d{1,2}$/.test(transactionType) || isoResponseCode === undefined || !currencyCode) return null;
  const approvedRaw = json['Approved'];
  if (approvedRaw !== undefined && approvedRaw !== null && typeof approvedRaw !== 'boolean') return null;
  const approved = typeof approvedRaw === 'boolean' ? approvedRaw : null;
  const totalAmountMinor = minorOfTotalAmount(json['TotalAmount'], currencyCode);
  if (totalAmountMinor === null) return null;
  // The summary's own currency, when it names one, is the record's.
  if (summary['CurrencyCode'] !== undefined && summary['CurrencyCode'] !== null && alphaOfCurrency(summary['CurrencyCode']) !== currencyCode) return null;
  // The order: OrderSummary's (the real records), or a top-level one; both present must agree; present must be text.
  const orders: string[] = [];
  for (const raw of [summary['OrderIdentifier'], json['OrderIdentifier']]) {
    if (raw === undefined || raw === null) continue;
    const text = str(raw)?.trim();
    if (!text) return null;
    orders.push(text);
  }
  if (orders.length === 2 && orders[0] !== orders[1]) return null;
  const original = summary['OriginalTrxnIdentifier'];
  if (original !== undefined && original !== null && str(original)?.trim().toLowerCase() !== transactionIdentifier.toLowerCase()) return null;
  const captureCount = countOf(summary['CaptureCount']);
  const creditCount = countOf(summary['CreditCount']);
  if (captureCount === null || creditCount === null) return null;
  // Absent or null: no reversal. A real date on or after the session began: reversed. Anything else cannot be read.
  // [CARD-STAGING-TEST 10 Nov 2026] VoidDateTime sits in OrderSummary; a top-level one is read the same way.
  let voided = false;
  for (const voidAt of [summary['VoidDateTime'], json['VoidDateTime']]) {
    if (voidAt === undefined || voidAt === null) continue;
    const at = typeof voidAt === 'string' ? voidDateOf(voidAt) : null;
    // [REVIEW-2460-DELTA D1] ... and never after the read (plus the zone margin): a "no date" maximum
    // ("9999-12-31T23:59:59.9999999", "2079-06-06") or any future date is no reversal.
    if (at === null || at < voidNotBeforeMs || at > voidNotAfterMs) return null;
    voided = true;
  }
  const totalCaptureMinor = minorOfTotalAmount(summary['TotalCaptureAmount'], currencyCode);
  const totalCreditMinor = minorOfTotalAmount(summary['TotalCreditAmount'], currencyCode);
  if (totalCaptureMinor === null || totalCreditMinor === null) return null;
  if (summary['SettledAmount'] !== undefined && summary['SettledAmount'] !== null && minorOfTotalAmount(summary['SettledAmount'], currencyCode) === null) return null;
  return {
    transactionIdentifier, orderIdentifier: orders[0] ?? null, transactionType, approved, isoResponseCode, currencyCode, totalAmountMinor,
    captureCount, creditCount, voided, totalCaptureMinor, totalCreditMinor,
  };
}

type LookupVerdict =
  | { status: 'confirmed' }
  | { status: 'not_taken'; reason: string; stage: 'declined' | 'never_completed' }
  | { status: 'reversed' | 'part_credited' | 'not_bookable' | 'unknown'; reason: string };

const codeShown = (code: string) => code.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'NO_CODE';

/**
 * [CARD-LOOKUP] The record, judged against what Swift asked for:
 *   - another transaction or order, or not a Sale (TransactionType 2 — a void is its own type-4 transaction, whose
 *     record also reads "00" with a capture): the answer is not about this payment — unknown;
 *   - VoidDateTime present (a real date), or a credit of the WHOLE capture: reversed — never booked;
 *   - a credit smaller than the capture: part refunded, the rest still taken — never booked, never "nothing taken";
 *     a credit above the capture, with nothing captured, or with no credit counted, contradicts itself — unknown;
 *   - [VOID-REFUND-CHECK F2] not approved, a code that is not "00" and not ambiguous, and nothing captured, credited or
 *     voided: proven NOT taken (a decline, or a page that never completed) — not_taken, never voided;
 *   - not "00" (or an Approved that is false): not an approved sale — never booked (a page only preprocessed or
 *     authenticated reads SP4 / 3D0 / 3D6 here: PowerTranz's portal lists those as "Sale" rows, with nothing taken);
 *   - a record that names no order: unknown;
 *   - another currency, nothing captured (CaptureCount 0), a credit counted, or a TotalAmount or TotalCaptureAmount
 *     that is not Swift's price to the minor unit: not a confirmed sale at Swift's price — never booked;
 *   - otherwise confirmed. Even then this is NOT booking authority on its own: the service books only when the
 *     session also holds PowerTranz's own approval of the completion, stored when it arrived (readCompletion).
 */
export function judgeTransactionRecord(record: PowerTranzTransactionRecord, held: HeldCompletion): LookupVerdict {
  if (record.transactionIdentifier.toLowerCase() !== held.txnId.toLowerCase()) return { status: 'unknown', reason: 'LOOKUP_OTHER_TRANSACTION' };
  // [CARD-STAGING-TEST 10 Nov 2026] A Sale (TransactionType 2) before anything else: a void is its OWN transaction
  // (type 4) whose record also reads "00", a capture and an order — never read as the sale Swift asked about.
  if (record.transactionType !== '2') return { status: 'unknown', reason: 'LOOKUP_NOT_A_SALE' };
  if (record.orderIdentifier !== null && record.orderIdentifier !== held.orderId) return { status: 'unknown', reason: 'LOOKUP_OTHER_ORDER' };
  if (record.voided) return { status: 'reversed', reason: 'LOOKUP_VOIDED' };
  if (record.totalCreditMinor !== 0) {
    if (record.totalCaptureMinor <= 0 || record.totalCreditMinor > record.totalCaptureMinor || record.creditCount < 1) return { status: 'unknown', reason: 'LOOKUP_CREDIT_UNREADABLE' };
    if (record.totalCreditMinor === record.totalCaptureMinor) return { status: 'reversed', reason: 'LOOKUP_CREDITED' };
    return { status: 'part_credited', reason: 'LOOKUP_PARTIAL_CREDIT' };
  }
  // [VOID-REFUND-CHECK F2 · LEGAL-CARDS 12 Nov 2026] Proven NOT taken: not approved, a code that is the bank's own
  // answer (not "00", not ambiguous), and nothing captured, credited or voided. A definitive decline, or a page only
  // preprocessed or authenticated (SP4 / 3D0: the staging sandbox refused to void one, WRITES.md:63). PowerTranz (12 Nov
  // 2026): a declined transaction cannot be refunded (Response Code 12); a void needs an approved authorization (guide
  // sec. 3). So it is never voided: the session closes as unpaid. Anything short of all of these keeps the old path.
  const iso = record.isoResponseCode;
  if (record.approved !== true && iso !== '00' && /^[A-Za-z0-9]{2,3}$/.test(iso) && !AMBIGUOUS_ISO.has(iso)
    && record.captureCount === 0 && record.totalCaptureMinor === 0 && record.creditCount === 0 && record.totalCreditMinor === 0 && !record.voided) {
    return /^(SP|3D)/i.test(iso)
      ? { status: 'not_taken', reason: `LOOKUP_NEVER_COMPLETED_${codeShown(iso)}`, stage: 'never_completed' }
      : { status: 'not_taken', reason: `LOOKUP_DECLINED_${codeShown(iso)}`, stage: 'declined' };
  }
  if (record.approved === false || record.isoResponseCode !== '00') return { status: 'not_bookable', reason: `LOOKUP_NOT_APPROVED_${codeShown(record.isoResponseCode)}` };
  if (record.orderIdentifier === null) return { status: 'unknown', reason: 'LOOKUP_NO_ORDER' };
  if (record.currencyCode !== held.currencyCode) return { status: 'not_bookable', reason: 'LOOKUP_CURRENCY_MISMATCH' };
  if (record.creditCount !== 0) return { status: 'unknown', reason: 'LOOKUP_CREDIT_UNREADABLE' };
  if (record.captureCount < 1) return { status: 'not_bookable', reason: 'LOOKUP_NOT_CAPTURED' };
  if (record.totalCaptureMinor !== held.amountMinor || record.totalAmountMinor !== held.amountMinor) return { status: 'not_bookable', reason: 'LOOKUP_AMOUNT_MISMATCH' };
  return { status: 'confirmed' };
}

type RefundVerdict = { status: 'refunded'; how: 'credit' | 'void'; reason: string } | { status: 'part_credited' | 'not_refunded' | 'unknown'; reason: string };

/**
 * [CARD-REFUND-LOOKUP] The ORIGINAL transaction's record, judged for a refund Swift sent whose answer is not known
 * (PowerTranz's written answer to Swift, 9 Nov 2026: the lookup covers every transaction type; refunds, partial and
 * portal ones included, are supported):
 *   - another transaction, order or currency, no order named, or not a Sale (TransactionType 2): the answer is not
 *     about this payment — unknown;
 *   - VoidDateTime a real date (voidDateOf, the same window as the completion lookup): voided — refunded (void).
 *     [CARD-STAGING-TEST 10 Nov 2026] A void reads exactly so on the real record: OrderSummary.VoidDateTime set,
 *     the capture kept, no credit;
 *   - no credit on it: not refunded (yet);
 *   - a credit above the capture, with nothing captured, or with no credit or no capture counted: contradicts
 *     itself — unknown;
 *   - not approved ("00", an Approved that is not false): a credit on it cannot be read as this payment's — unknown;
 *   - TotalCreditAmount = TotalCaptureAmount = Swift's price, to the minor unit: the WHOLE payment went back — refunded;
 *     ASSUMED until PowerTranz confirms [REVIEW-2461-A S3-1]: TotalCreditAmount (with CreditCount) counts only refunds
 *     PowerTranz APPROVED (never a pending, declined or reversed attempt). The staging records of 10 Nov 2026 hold no
 *     refund yet: a real refund's record pins this before cards go live;
 *   - any other credit (part of it, or a capture that is not Swift's price): never "refunded" — held for the owner.
 *
 * [OWNER 10 Nov 2026 · PARTLY USED CARD PAYMENT] `refundMinor` below the payment (held.amountMinor) is a PARTIAL refund
 * Swift sent (the payment's weeks that had not started; PowerTranz's docs: "Powertranz supports partial capture and
 * refund"). It is `refunded` only when the capture is Swift's price and TotalCreditAmount is EXACTLY that part. More
 * back (the whole payment, or a void — a void can only be whole), less, or any other credit is held for the owner; no
 * credit yet is not refunded. Absent, or equal to the payment, it is the whole-payment rule above, unchanged.
 */
export function judgeRefundRecord(record: PowerTranzTransactionRecord, held: HeldCompletion, refundMinor: number = held.amountMinor): RefundVerdict {
  if (record.transactionIdentifier.toLowerCase() !== held.txnId.toLowerCase()) return { status: 'unknown', reason: 'LOOKUP_OTHER_TRANSACTION' };
  // A Sale before anything else (a void's or a refund's own record is never the payment's).
  if (record.transactionType !== '2') return { status: 'unknown', reason: 'LOOKUP_NOT_A_SALE' };
  if (record.orderIdentifier === null) return { status: 'unknown', reason: 'LOOKUP_NO_ORDER' };
  if (record.orderIdentifier !== held.orderId) return { status: 'unknown', reason: 'LOOKUP_OTHER_ORDER' };
  if (record.currencyCode !== held.currencyCode) return { status: 'unknown', reason: 'LOOKUP_CURRENCY_MISMATCH' };
  const partial = refundMinor < held.amountMinor;
  // A void returns the whole payment: for a partial refund that is more than Swift asked back.
  if (record.voided) return partial ? { status: 'part_credited', reason: 'LOOKUP_VOIDED_NOT_THE_PART' } : { status: 'refunded', how: 'void', reason: 'LOOKUP_VOIDED' };
  if (record.totalCreditMinor === 0) return { status: 'not_refunded', reason: 'LOOKUP_NO_CREDIT' };
  if (record.totalCaptureMinor <= 0 || record.totalCreditMinor > record.totalCaptureMinor || record.creditCount < 1 || record.captureCount < 1) {
    return { status: 'unknown', reason: 'LOOKUP_CREDIT_UNREADABLE' };
  }
  if (record.approved === false || record.isoResponseCode !== '00') return { status: 'unknown', reason: 'LOOKUP_NOT_AN_APPROVED_SALE' };
  if (partial) {
    if (record.totalCaptureMinor !== held.amountMinor) return { status: 'part_credited', reason: 'LOOKUP_CREDIT_NOT_THE_PAYMENT' };
    if (record.totalCreditMinor === refundMinor) return { status: 'refunded', how: 'credit', reason: 'LOOKUP_CREDITED' };
    return { status: 'part_credited', reason: 'LOOKUP_CREDIT_NOT_THE_PART' };
  }
  if (record.totalCreditMinor === record.totalCaptureMinor && record.totalCaptureMinor === held.amountMinor) return { status: 'refunded', how: 'credit', reason: 'LOOKUP_CREDITED' };
  return { status: 'part_credited', reason: record.totalCreditMinor < record.totalCaptureMinor ? 'LOOKUP_PARTIAL_CREDIT' : 'LOOKUP_CREDIT_NOT_THE_PAYMENT' };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

type HttpAnswer =
  | { shape: 'json'; status: number; json: unknown }
  | { shape: 'http'; status: number }
  | { shape: 'transport'; reason: 'timeout' | 'network' };

export interface PowerTranzDeps {
  /** The HTTP client (tests pass a fake that speaks the guide's examples). */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Redis namespace: `ptz:` (default) or `ptz:<name>:` for a test run. */
  keyPrefix?: string;
}

type LookupInput = { binding: CardRailBinding; providerRef: string; orderRef: string; amountMinor: number; refundMinor?: number; currencyCode: string; notBefore?: Date };

const KEY_PREFIX_SHAPE = /^ptz:(?:[A-Za-z0-9_-]{1,64}:)?$/;
const REF_SHAPE = /^ptz_[0-9a-f]{24}$/;

export interface PowerTranzHostedPage {
  redirectData: string;
  amountMinor: number;
  currencyCode: string;
  expired: boolean;
  finished: boolean;
  sandbox: boolean;
}

export class PowerTranzCardRailProvider implements CardRailProvider {
  readonly simulator = false;
  /** The guide documents no charge without the cardholder (sec. 7.8) and no last 4 / expiry (sec. 6). */
  readonly savesCards = false;
  readonly binding: CardRailBinding;
  readonly keyPrefix: string;
  private readonly http: typeof fetch;
  private readonly now: () => Date;
  private readonly key = {
    session: (ref: string) => `${this.keyPrefix}s:${ref}`,
    refund: (idempotencyKey: string) => `${this.keyPrefix}r:${this.binding.account}:${idempotencyKey}`,
    lookup: (txnId: string) => `${this.keyPrefix}l:${this.binding.account}:${txnId.toLowerCase()}`,
  };

  constructor(private readonly redis: Redis, private readonly config: PowerTranzConfig, deps: PowerTranzDeps = {}) {
    this.binding = { provider: POWERTRANZ_PROVIDER, environment: config.environment, account: config.account };
    this.http = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
    const keyPrefix = deps.keyPrefix ?? 'ptz:';
    if (!KEY_PREFIX_SHAPE.test(keyPrefix)) throw new PowerTranzConfigError('The card provider key prefix is ptz: or ptz:<name>:');
    this.keyPrefix = keyPrefix;
  }

  /** Swift's page that hosts the bank's card form (served by card-rail.routes.ts). */
  hostedUrlFor(providerSessionRef: string): string {
    return `${this.config.publicBaseUrl}/api/v1/billing/card/pay/${providerSessionRef}`;
  }

  // -------------------------------------------------------------------------
  // HTTP (sec. 4: JSON over HTTPS; credentials in headers; never logged)
  // -------------------------------------------------------------------------

  private headers(withCredentials: boolean): Record<string, string> {
    return {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      ...(withCredentials ? {
        'PowerTranz-PowerTranzId': this.config.powerTranzId,
        'PowerTranz-PowerTranzPassword': this.config.password,
        ...(this.config.gatewayKey ? { 'PowerTranz-GatewayKey': this.config.gatewayKey } : {}),
      } : {}),
    };
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: string; headers: Record<string, string>; timeoutMs?: number }): Promise<HttpAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const res = await this.http(`${this.config.apiRoot}${path}`, {
        method: init.method, headers: init.headers, signal: controller.signal, redirect: 'error',
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      const text = await res.text();
      try {
        return { shape: 'json', status: res.status, json: text ? JSON.parse(text) : null };
      } catch {
        return { shape: 'http', status: res.status };
      }
    } catch (err) {
      return { shape: 'transport', reason: (err as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // createSession — sec. 2.2 1.3-1.4, 5.1, 7.2
  // -------------------------------------------------------------------------

  async createSession(input: Parameters<CardRailProvider['createSession']>[0]): Promise<CreateCardSessionOutcome> {
    assertBinding(this.binding, input.binding);
    // Every "no page" below is definitive: without Swift's completion call no
    // money can move (sec. 7.3), and the SpiToken it would need never reached Swift.
    const refuse = (reason: string): CreateCardSessionOutcome => ({ status: 'failed', reason, rawSha256: rawDigest({ refused: reason }) });
    if (input.purpose !== 'PAY_NOW') return refuse('SAVING_CARDS_NOT_OFFERED');
    const currencyCode = input.currencyCode ?? '';
    const numeric = CURRENCY_NUMERIC[currencyCode];
    if (!numeric || !isKnownCurrency(currencyCode)) return refuse('CURRENCY_NOT_SUPPORTED');
    if (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor ?? 0) <= 0) return refuse('AMOUNT_INVALID');
    // sec. 5.1 MerchantResponseURL: M, AN 255.
    if (!input.returnUrl.startsWith('https://') || input.returnUrl.length > 255) return refuse('RETURN_URL_INVALID');

    const providerSessionRef = `ptz_${randomBytes(12).toString('hex')}`;
    const txnId = randomUUID(); // sec. 5.1 TransactionIdentifier (M, GUID); sec. 9.2 unique
    const orderId = `SWIFT-${input.sessionRef}`; // sec. 5.1 OrderIdentifier (M, AN 255); sec. 9.2 unique per approved transaction
    const body = {
      TransactionIdentifier: txnId,
      TotalAmount: totalAmountOf(input.amountMinor!, currencyCode), // sec. 5.1 M, DEC 18,3
      CurrencyCode: numeric,                                        // sec. 5.1 M, ISO 4217 numeric
      ThreeDSecure: SALE_THREE_D_SECURE,                            // sec. 5.1 M; sec. 2: a 3-D Secure request (always)
      Source: {},                                                   // sec. 7.2: with the hosted page the card is typed there, never here [C1]
      OrderIdentifier: orderId,
      BillingAddress: {},                                           // sec. 5.1 nested object; the hosted page collects the cardholder's details
      AddressMatch: false,                                          // sec. 5.1 O, as sec. 7.2
      ExtendedData: {                                               // sec. 5.1 M
        ThreeDSecure: { ChallengeWindowSize: CHALLENGE_WINDOW_FULL, ChallengeIndicator: CHALLENGE_NO_PREFERENCE },
        MerchantResponseUrl: input.returnUrl,                       // sec. 5.1 M; Appendix 2 step 2
        HostedPage: { PageSet: this.config.pageSet, PageName: this.config.pageName }, // sec. 5.1, 7.2
      },
    };
    const answer = await this.call(PATH.sale, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    if (answer.shape !== 'json' || !isObject(answer.json)) {
      return { status: 'failed', reason: answer.shape === 'transport' ? `NO_ANSWER_${answer.reason}` : `HTTP_${answer.status}`, rawSha256: rawDigest({ createFailed: answer.shape, status: 'status' in answer ? answer.status : null }) };
    }
    const json = answer.json;
    const rawSha256 = blindedDigest(json);
    const redirectData = str(json['RedirectData']);
    const spiToken = str(json['SpiToken']);
    const echoed = str(json['TransactionIdentifier']);
    // sec. 2.2 1.4: "An IsoResponseCode of SP4 is returned if the request passes basic validation."
    if (str(json['IsoResponseCode']) !== 'SP4' || !redirectData || !spiToken || (echoed !== undefined && echoed.toLowerCase() !== txnId.toLowerCase())) {
      return { status: 'failed', reason: `NOT_PREPROCESSED_${str(json['IsoResponseCode']) ?? 'NO_CODE'}${errorCodes(json).length ? `_${errorCodes(json).join('_')}` : ''}`, rawSha256 };
    }
    const k = this.key.session(providerSessionRef);
    try {
      await this.redis.hset(k, {
        sessionRef: input.sessionRef, purpose: input.purpose, txnId, orderId,
        // [OWNER RULING 10 Nov 2026] What the Sale was sent with, from the body itself: the completion is sent only
        // for a page whose Sale asked for 3-D Secure (confirm), so PowerTranz's approval of it is the proof.
        threeDSecure: String(body.ThreeDSecure),
        amountMinor: String(input.amountMinor), currencyCode,
        expiresAtMs: String(input.expiresAt.getTime()), createdAtMs: String(this.now().getTime()),
        spiToken, redirectData,
      });
      await this.redis.pexpireat(k, input.expiresAt.getTime() + RECORD_RETAIN_MS);
    } catch {
      // [Review S4] The page could not be kept: its SpiToken is gone, so Swift
      // can never send the completion — and until it does, nothing is
      // authorized and no funds are held (sec. 7.3). Definitively no page.
      await this.redis.del(k).catch(() => 0);
      return { status: 'failed', reason: 'PAGE_NOT_KEPT', rawSha256 };
    }
    return { status: 'succeeded', providerSessionRef, hostedUrl: this.hostedUrlFor(providerSessionRef), rawSha256 };
  }

  /** What Swift's hosted page shows for one session: the bank's form and the server's price. Null when unknown. */
  async hostedPageFor(providerSessionRef: string): Promise<PowerTranzHostedPage | null> {
    if (!REF_SHAPE.test(providerSessionRef)) return null;
    const rec = await this.redis.hgetall(this.key.session(providerSessionRef));
    if (!rec['sessionRef'] || rec['purpose'] !== 'PAY_NOW') return null;
    const now = this.now().getTime();
    return {
      redirectData: rec['redirectData'] ?? '',
      amountMinor: Number(rec['amountMinor']),
      currencyCode: rec['currencyCode'] ?? '',
      expired: now > Number(rec['expiresAtMs']),
      finished: Boolean(rec['returnedAtMs'] || rec['completion']) || !rec['redirectData'],
      sandbox: this.binding.environment === 'sandbox',
    };
  }

  // -------------------------------------------------------------------------
  // The browser comes back — sec. 2.2 1.6 (not a financial result)
  // -------------------------------------------------------------------------

  parseReturn(params: Readonly<Record<string, string>>): CardReturnObservation {
    const { result } = readAuthenticationReturn(params);
    // [CARD-STAGING-TEST 10 Nov 2026] The digest is of the post with its tokens and personal data blinded, inside the
    // real post's Response too (returnEvidence): PanToken, BillingAddress, CardSuffix, CardholderInfo never reach it.
    const rawSha256 = rawDigest(returnEvidence(params));
    if (!result) return { rawSha256, claimedStatus: 'invalid' };
    // Pure: no held facts here, so the echo checks wait for noteReturn.
    const decision = authenticationDecision(result, { txnId: str(result['TransactionIdentifier']) ?? '', orderId: str(result['OrderIdentifier'])?.trim() ?? '' });
    return { rawSha256, claimedStatus: decision.proceed ? 'pending' : 'failed' };
  }

  /**
   * [PT-4] Called by the service for the session's FIRST VALID return only
   * (the one-use state already checked). Keeps Swift's completion decision
   * beside the page's facts; the first decision stands. Moves no money.
   */
  async noteReturn(input: { binding: CardRailBinding; providerSessionRef: string; params: Readonly<Record<string, string>> }): Promise<void> {
    assertBinding(this.binding, input.binding);
    const k = this.key.session(input.providerSessionRef);
    const rec = await this.redis.hgetall(k);
    if (!rec['sessionRef']) return;
    const reading = readAuthenticationReturn(input.params);
    const decision: AuthenticationDecision = reading.result
      ? authenticationDecision(reading.result, { ...(rec['spiToken'] ? { spiToken: rec['spiToken'] } : {}), txnId: rec['txnId'] ?? '', orderId: rec['orderId'] ?? '' })
      : { proceed: false, note: reading.note };
    await this.redis.eval(NOTE_ONCE, 1, k, String(this.now().getTime()), decision.proceed ? 'proceed' : 'refused', decision.note);
  }

  // -------------------------------------------------------------------------
  // confirm — sec. 2.2 1.7-1.8, 7.3: the completion, at most once
  // -------------------------------------------------------------------------

  async confirm(input: Parameters<CardRailProvider['confirm']>[0]): Promise<CardSessionOutcome> {
    assertBinding(this.binding, input.binding);
    if (input.purpose !== 'PAY_NOW') return { status: 'failed', reason: 'SAVING_CARDS_NOT_OFFERED', rawSha256: rawDigest({ refused: 'enroll' }) };
    const k = this.key.session(input.providerSessionRef);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rec = await this.redis.hgetall(k);
      const digest = (extra: Record<string, unknown>) => rawDigest({ ref: input.providerSessionRef, ...extra });
      if (!rec['sessionRef']) return { status: 'unknown', reason: 'NO_RECORD_OF_THIS_PAGE', rawSha256: digest({ missing: true }) };
      if (rec['purpose'] !== input.purpose) return { status: 'failed', reason: 'PURPOSE_MISMATCH', rawSha256: digest({ purpose: rec['purpose'] }) };
      if (rec['completion'] === 'done') return this.outcomeOf(rec);
      if (rec['completion'] === 'sending') {
        const claimedAt = Number(rec['completionClaimedAtMs']);
        if (Number.isFinite(claimedAt) && this.now().getTime() <= claimedAt + COMPLETION_CLAIM_WAIT_MS) {
          return { status: 'pending', rawSha256: digest({ completion: 'sending', claimedAt }) };
        }
        // Only past the deadline + persistence margin is an answer lost.
        // Legacy claims without a timestamp are uncertain too; never resend.
        return { status: 'unknown', reason: 'COMPLETION_SENT_ANSWER_LOST', voidable: { providerRef: rec['txnId'] ?? '' }, rawSha256: digest({ completion: 'sending' }) };
      }
      if (rec['completion'] === 'abandoned') return { status: 'failed', reason: rec['abandonReason'] || 'NOT_COMPLETED', rawSha256: digest({ completion: 'abandoned', why: rec['abandonReason'] }) };

      const now = this.now().getTime();
      if (!rec['returnedAtMs']) {
        // The partner has not finished on the bank's page (or the browser never came back).
        if (now <= Number(rec['expiresAtMs'])) return { status: 'pending', rawSha256: digest({ waiting: true }) };
        if (await this.abandon(k, 'PAGE_NOT_FINISHED')) {
          return { status: 'failed', reason: 'PAGE_NOT_FINISHED', rawSha256: digest({ completion: 'abandoned', why: 'PAGE_NOT_FINISHED' }) };
        }
        continue; // another process decided first: read its decision
      }
      // [Review S4] sec. 2.2 1.7: the completion must be sent within 5 minutes,
      // after which the SpiToken is unavailable: never sent late.
      if (now - Number(rec['returnedAtMs']) > SPI_TOKEN_LIFETIME_MS) {
        if (await this.abandon(k, 'SPI_TOKEN_EXPIRED')) return { status: 'failed', reason: 'SPI_TOKEN_EXPIRED', rawSha256: digest({ completion: 'abandoned', why: 'SPI_TOKEN_EXPIRED' }) };
        continue;
      }
      // [OWNER RULING 10 Nov 2026] Never completed unless the browser's result passed (it can only stop Swift) AND the
      // page's Sale was sent with ThreeDSecure true (a record that does not say so — or an older one — is not completed).
      if (rec['authDecision'] !== 'proceed' || rec['threeDSecure'] !== 'true') {
        const note = rec['authNote'] ?? '';
        // [CARD-STAGING-TEST] A page PowerTranz refused (a set-up error) is no failed bank check: PAGE_REFUSED.
        const why = rec['threeDSecure'] !== 'true' ? 'NOT_AUTHENTICATED:SALE_NOT_3DS'
          : note.startsWith('PAGE_REFUSED') ? `PAGE_REFUSED:${note}` : `NOT_AUTHENTICATED:${note}`;
        if (await this.abandon(k, why)) return { status: 'failed', reason: why, rawSha256: digest({ completion: 'abandoned', why }) };
        continue;
      }
      // Claim the one completion this page may ever have (timestamped [CARDS S2]).
      if (Number(await this.redis.eval(CLAIM_COMPLETION, 1, k, String(now))) !== 1) continue;
      // [CARDS S1] Claim it durably on the session, immediately before asking
      // the bank: finance never closes a session whose completion is claimed.
      let claim: CompletionClaim = 'send';
      try {
        if (input.beforeCompletion) claim = await input.beforeCompletion(rec['txnId'] ?? '');
      } catch (err) {
        // Nothing was sent, and it never will be for this page.
        await this.notSent(k, 'COMPLETION_CLAIM_FAILED');
        throw err;
      }
      if (claim === 'closed') {
        // The session closed first: the completion is never sent; nothing was taken.
        await this.notSent(k, 'SESSION_CLOSED_BEFORE_COMPLETION');
        return { status: 'failed', reason: 'SESSION_CLOSED_BEFORE_COMPLETION', rawSha256: digest({ completion: 'abandoned', why: 'SESSION_CLOSED_BEFORE_COMPLETION' }) };
      }
      // [race audit] The durable claim may have waited on a lock: the five
      // minutes (sec. 2.2 1.7) are checked again right before sending.
      if (claim === 'send' && this.now().getTime() - Number(rec['returnedAtMs']) > SPI_TOKEN_LIFETIME_MS) {
        await this.notSent(k, 'SPI_TOKEN_EXPIRED');
        return { status: 'failed', reason: 'SPI_TOKEN_EXPIRED', rawSha256: digest({ completion: 'abandoned', why: 'SPI_TOKEN_EXPIRED' }) };
      }
      if (claim === 'claimed') {
        // A durable claim already exists (this store lost its own): a completion
        // may already have been sent. Never sent again; voided by the service.
        await this.redis.hset(k, { completion: 'done', result: JSON.stringify({ status: 'unbookable', reason: 'COMPLETION_ALREADY_CLAIMED', rawSha256: digest({ completion: 'not-resent' }) }) });
        await this.redis.hdel(k, 'spiToken', 'redirectData');
        return this.outcomeOf(await this.redis.hgetall(k));
      }
      return this.complete(k, rec);
    }
    return { status: 'unknown', reason: 'COMPLETION_STATE_CHANGING', rawSha256: rawDigest({ ref: input.providerSessionRef, racing: true }) };
  }

  /** [CARDS S1] This process holds the page's completion claim and never sent
   *  it: the page is closed as not completed (the SpiToken is dropped). */
  private async notSent(k: string, why: string): Promise<void> {
    await this.redis.hset(k, { completion: 'abandoned', abandonReason: why });
    await this.redis.hdel(k, 'spiToken', 'redirectData');
  }

  private async abandon(k: string, why: string): Promise<boolean> {
    const claimed = Number(await this.redis.hsetnx(k, 'completion', 'abandoned')) === 1;
    if (claimed) {
      await this.redis.hset(k, 'abandonReason', why);
      await this.redis.hdel(k, 'spiToken', 'redirectData');
    }
    return claimed;
  }

  /** sec. 7.3: POST /spi/payment, the body "simply the SpiToken value and not Json" (the example sends it quoted),
   *  and no PowerTranzId / Password headers. */
  private async complete(k: string, rec: Record<string, string>): Promise<CardSessionOutcome> {
    const spiToken = rec['spiToken'] ?? '';
    const answer = await this.call(PATH.payment, {
      method: 'POST',
      headers: { 'content-type': 'application/json-patch+json', accept: 'application/json, text/plain' },
      body: JSON.stringify(spiToken),
      timeoutMs: COMPLETION_TIMEOUT_MS,
    });
    let reading: CompletionReading;
    let rawSha256: string;
    const held: HeldCompletion = {
      txnId: rec['txnId'] ?? '', orderId: rec['orderId'] ?? '', amountMinor: Number(rec['amountMinor']), currencyCode: rec['currencyCode'] ?? '',
    };
    if (answer.shape === 'json') {
      rawSha256 = blindedDigest(answer.json);
      reading = answer.status >= 500 || answer.status === 408 || answer.status === 429
        ? { status: 'unbookable', reason: `COMPLETION_HTTP_${answer.status}` }
        : answer.status >= 400 && !isObject(answer.json)
          ? { status: 'failed', reason: `HTTP_${answer.status}` }
          : readCompletion(answer.json, held);
    } else if (answer.shape === 'http' && answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 429) {
      rawSha256 = rawDigest({ completionHttp: answer.status });
      reading = { status: 'failed', reason: `HTTP_${answer.status}` };
    } else {
      // No answer, or an answer that cannot be read: the bank may have taken
      // it. Never repeated; recorded so every later read asks for the void.
      rawSha256 = rawDigest({ completion: answer.shape });
      reading = { status: 'unbookable', reason: answer.shape === 'transport' ? `COMPLETION_${answer.reason.toUpperCase()}` : 'COMPLETION_UNREADABLE' };
    }
    await this.redis.hset(k, { completion: 'done', result: JSON.stringify({ ...reading, rawSha256 }), completedAtMs: String(this.now().getTime()) });
    await this.redis.hdel(k, 'spiToken', 'redirectData');
    return this.outcomeOf(await this.redis.hgetall(k));
  }

  private outcomeOf(rec: Record<string, string>): CardSessionOutcome {
    let stored: (CompletionReading & { rawSha256?: string }) | null = null;
    try {
      stored = JSON.parse(rec['result'] ?? 'null') as CompletionReading & { rawSha256?: string };
    } catch {
      stored = null;
    }
    const rawSha256 = stored?.rawSha256 ?? rawDigest({ result: rec['result'] ?? null });
    if (!stored) return { status: 'unknown', reason: 'COMPLETION_RECORD_UNREADABLE', rawSha256 };
    switch (stored.status) {
      case 'succeeded': {
        // Old cached success markers without the provider's proof cannot
        // restore booking authority. Re-validate the stored completion.
        const verified = readCompletion(stored.completionEvidence, {
          txnId: rec['txnId'] ?? '', orderId: rec['orderId'] ?? '', amountMinor: Number(rec['amountMinor']), currencyCode: rec['currencyCode'] ?? '',
        });
        if (verified.status !== 'succeeded') return { status: 'unknown', reason: 'COMPLETION_EVIDENCE_UNVERIFIED', voidable: { providerRef: rec['txnId'] ?? '' }, rawSha256 };
        return { status: 'succeeded', purpose: 'PAY_NOW', providerRef: rec['txnId'] ?? '', amountMinor: verified.amountMinor, currencyCode: verified.currencyCode, completionEvidence: verified.completionEvidence, rawSha256 };
      }
      case 'failed':
        return { status: 'failed', reason: stored.reason, rawSha256 };
      case 'unbookable':
        return { status: 'unknown', reason: stored.reason, voidable: { providerRef: rec['txnId'] ?? '' }, rawSha256 };
      default:
        return { status: 'unknown', reason: (stored as { reason?: string }).reason ?? 'COMPLETION_RECORD_UNREADABLE', rawSha256 };
    }
  }

  // -------------------------------------------------------------------------
  // Off-session — not documented (sec. 7.8), so never attempted
  // -------------------------------------------------------------------------

  async chargeInstrument(input: Parameters<CardRailProvider['chargeInstrument']>[0]): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    // No call is made: a token charge still needs the cardholder's browser for
    // 3-D Secure (sec. 7.8). The partner is asked to confirm with Pay now — no penalty [C4].
    return { status: 'requires_action', reason: 'CARDHOLDER_MUST_CONFIRM', rawSha256: rawDigest({ offSession: 'not-documented' }) };
  }

  async retrieve(input: { binding: CardRailBinding; idempotencyKey: string; providerRef?: string }): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    // chargeInstrument never sends anything, so no off-session instruction exists to look up.
    return { status: 'unknown', reason: 'NO_OFF_SESSION_INSTRUCTION_IS_EVER_SENT', absent: true, rawSha256: rawDigest({ retrieve: input.idempotencyKey }) };
  }

  // -------------------------------------------------------------------------
  // Refund and void — sec. 5.2, 7.5, 7.6; at most one call per key
  // -------------------------------------------------------------------------

  async refund(input: Parameters<CardRailProvider['refund']>[0]): Promise<CardRefundOutcome> {
    assertBinding(this.binding, input.binding);
    if (!CURRENCY_NUMERIC[input.currencyCode] || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !GUID.test(input.providerRef)) {
      return { status: 'failed', reason: 'REFUND_REQUEST_INVALID', rawSha256: rawDigest({ refused: 'refund' }) };
    }
    return this.adjust('refund', input.idempotencyKey, {
      Refund: true,                                                      // sec. 5.2: mandatory for refunds, true
      TransactionIdentifier: input.providerRef,                          // sec. 5.2: of the ORIGINAL transaction
      TotalAmount: totalAmountOf(input.amountMinor, input.currencyCode), // sec. 5.2: required for refund
      CurrencyCode: CURRENCY_NUMERIC[input.currencyCode],                // sec. 7.5 example
    }, { ref: input.providerRef, amountMinor: input.amountMinor, currencyCode: input.currencyCode });
  }

  /** sec. 5.2, 7.6: cancel an approved payment before it settles — the whole amount only ("partial voids are not supported"). */
  async voidPayment(input: { binding: CardRailBinding; providerRef: string; idempotencyKey: string }): Promise<CardRefundOutcome> {
    assertBinding(this.binding, input.binding);
    if (!GUID.test(input.providerRef)) return { status: 'failed', reason: 'VOID_REQUEST_INVALID', rawSha256: rawDigest({ refused: 'void' }) };
    return this.adjust('void', input.idempotencyKey, { TransactionIdentifier: input.providerRef }, { ref: input.providerRef });
  }

  /**
   * One void or refund call per key. [Review S2-2 · S3] An approval counts
   * only when it is about THIS transaction: the answer names it (as the
   * original, or as itself — sec. 6 OriginalTrxnIdentifier / sec. 7.6), its
   * TransactionType is a Void (4) or a Refund (5) (sec. 6), and a refund's
   * TotalAmount is the amount asked. Anything else is unknown, never done:
   * a void that "succeeded" closes the payment as not taken.
   */
  private async adjust(
    action: 'refund' | 'void',
    idempotencyKey: string,
    body: Record<string, unknown>,
    expect: { ref: string; amountMinor?: number; currencyCode?: string },
  ): Promise<CardRefundOutcome> {
    const k = this.key.refund(`${action}:${idempotencyKey}`);
    if (Number(await this.redis.hsetnx(k, 'state', 'sending')) !== 1) {
      const rec = await this.redis.hgetall(k);
      if (rec['state'] === 'done' && rec['result']) return JSON.parse(rec['result']) as CardRefundOutcome;
      // Sent once already and its answer never arrived: never sent again. A person checks it with the card provider
      // (lookupRefund, two people) or settles it with PowerTranz.
      return { status: 'unknown', reason: `${action.toUpperCase()}_SENT_ANSWER_LOST`, rawSha256: rawDigest({ [action]: idempotencyKey }) };
    }
    await this.redis.pexpire(k, RECORD_RETAIN_MS);
    const answer = await this.call(action === 'refund' ? PATH.refund : PATH.void, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    let outcome: CardRefundOutcome;
    if (answer.shape === 'json' && isObject(answer.json) && answer.status < 500) {
      const json = answer.json;
      const rawSha256 = blindedDigest(json);
      const iso = str(json['IsoResponseCode']) ?? '';
      const codes = errorCodes(json);
      if (json['Approved'] === true && iso === '00') {
        const mine = expect.ref.toLowerCase();
        // [VOID-REFUND-CHECK F7 · PowerTranz 12 Nov 2026: "refund/void responses include the original transaction
        // details"] An answer that names an original names OURS; only one that names none may name ours as itself (the
        // sec. 7.6 void sample answers with the original's own TransactionIdentifier).
        const named = str(json['OriginalTrxnIdentifier'])?.trim();
        const namesIt = named ? named.toLowerCase() === mine : str(json['TransactionIdentifier'])?.toLowerCase() === mine;
        const typeIt = String(json['TransactionType'] ?? '') === (action === 'void' ? '4' : '5');
        const amountIt = action === 'void' || (expect.currencyCode !== undefined
          && alphaOfCurrency(json['CurrencyCode']) === expect.currencyCode
          && minorOfTotalAmount(json['TotalAmount'], expect.currencyCode) === expect.amountMinor);
        outcome = namesIt && typeIt && amountIt
          ? { status: 'succeeded', providerRef: str(json['TransactionIdentifier']) ?? '', rawSha256 }
          : { status: 'unknown', reason: `${action.toUpperCase()}_APPROVAL_NOT_FOR_THIS_${!namesIt ? 'TRANSACTION' : !typeIt ? 'TYPE' : 'AMOUNT'}`, rawSha256 };
      } else if (json['Approved'] === false && !AMBIGUOUS_ISO.has(iso) && !codes.some((c) => DUPLICATE_CODES.has(c))) {
        outcome = { status: 'failed', reason: `${action.toUpperCase()}_REFUSED_${iso || 'NO_CODE'}${codes.length ? `_${codes.join('_')}` : ''}`, rawSha256 };
      } else {
        outcome = { status: 'unknown', reason: `${action.toUpperCase()}_UNCLEAR_${iso || 'NO_CODE'}`, rawSha256 };
      }
    } else if (answer.shape !== 'transport' && answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 429) {
      outcome = { status: 'failed', reason: `${action.toUpperCase()}_HTTP_${answer.status}`, rawSha256: rawDigest({ [action]: answer.status }) };
    } else {
      // Leave the claim in place: the answer is lost, and a second call could refund twice.
      return { status: 'unknown', reason: `${action.toUpperCase()}_NO_ANSWER`, rawSha256: rawDigest({ [action]: 'no-answer' }) };
    }
    await this.redis.hset(k, { state: 'done', result: JSON.stringify(outcome) });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // [CARD-LOOKUP] The transaction lookup — PowerTranz's written answer to Swift (4 Nov 2026)
  // -------------------------------------------------------------------------

  /**
   * GET <root>/api/Transactions/{TransactionIdentifier}, with the PowerTranz-PowerTranzId / -PowerTranzPassword
   * headers. PowerTranz: use it ONLY when an outcome is unknown (timeout, interruption), never as the normal flow —
   * so the service asks only about a completion whose outcome is not known, and nothing else in this provider calls
   * it. A read moves no money and sends no instruction. At most one read per transaction per backoff window
   * (LOOKUP_BACKOFF_*), shared by every server; inside the window the answer is `unknown` with `backoff`, and no
   * call is made. Any answer that is not a readable record of THIS transaction and order is `unknown`.
   */
  async lookupTransaction(input: LookupInput): Promise<CardLookupOutcome> {
    const read = await this.readRecord(input);
    if (!('record' in read)) return read;
    const { record, rawSha256 } = read;
    const verdict = judgeTransactionRecord(record, { txnId: input.providerRef, orderId: input.orderRef, amountMinor: input.amountMinor, currencyCode: input.currencyCode });
    if (verdict.status === 'confirmed') {
      return { status: 'confirmed', providerRef: input.providerRef, amountMinor: record.totalCaptureMinor, currencyCode: record.currencyCode, rawSha256 };
    }
    if (verdict.status === 'not_taken') return { status: 'not_taken', reason: verdict.reason, stage: verdict.stage, rawSha256 };
    return { status: verdict.status, reason: verdict.reason, rawSha256 };
  }

  /**
   * [CARD-REFUND-LOOKUP] The same read (GET <root>/api/Transactions/{the ORIGINAL TransactionIdentifier}, the same
   * backoff window per transaction), judged for a refund Swift sent whose answer is not known (judgeRefundRecord).
   * Called only when a person asks, two people; it never sends a refund or anything else.
   */
  async lookupRefund(input: LookupInput): Promise<CardRefundLookupOutcome> {
    const read = await this.readRecord(input);
    if (!('record' in read)) return read;
    const verdict = judgeRefundRecord(read.record, { txnId: input.providerRef, orderId: input.orderRef, amountMinor: input.amountMinor, currencyCode: input.currencyCode }, input.refundMinor);
    return { ...verdict, rawSha256: read.rawSha256 };
  }

  /** One read of a transaction's record, gated and read strictly: the record, or why there is none (unknown). */
  private async readRecord(input: LookupInput): Promise<{ record: PowerTranzTransactionRecord; rawSha256: string } | { status: 'unknown'; reason: string; backoff?: true; rawSha256: string }> {
    assertBinding(this.binding, input.binding);
    const digest = (extra: Record<string, unknown>) => rawDigest({ lookup: input.providerRef, ...extra });
    if (!GUID.test(input.providerRef) || !CURRENCY_NUMERIC[input.currencyCode] || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0
      // [OWNER 10 Nov 2026] A refund part is a positive whole number of minor units, never more than the payment.
      || (input.refundMinor !== undefined && (!Number.isSafeInteger(input.refundMinor) || input.refundMinor <= 0 || input.refundMinor > input.amountMinor))) {
      return { status: 'unknown', reason: 'LOOKUP_REQUEST_INVALID', rawSha256: digest({ refused: true }) };
    }
    // [REVIEW-2460-A S4-2] Timed by Redis's own clock (inside the script), one clock for every server.
    const waitMs = Number(await this.redis.eval(LOOKUP_GATE, 1, this.key.lookup(input.providerRef),
      String(LOOKUP_BACKOFF_FIRST_MS), String(LOOKUP_BACKOFF_MAX_MS), String(LOOKUP_GATE_TTL_MS)));
    if (!(waitMs > 0)) return { status: 'unknown', reason: 'LOOKUP_BACKOFF', backoff: true, rawSha256: digest({ backoff: true }) };
    // [REVIEW-2460-B B8] A GET with no body: the credentials and `accept`, no content-type.
    const headers = this.headers(true);
    delete headers['content-type'];
    const answer = await this.call(`${PATH.transactions}${encodeURIComponent(input.providerRef)}`, { method: 'GET', headers, timeoutMs: LOOKUP_TIMEOUT_MS });
    if (answer.shape === 'transport') return { status: 'unknown', reason: `LOOKUP_NO_ANSWER_${answer.reason.toUpperCase()}`, rawSha256: digest({ transport: answer.reason }) };
    if (answer.status < 200 || answer.status >= 300) return { status: 'unknown', reason: `LOOKUP_HTTP_${answer.status}`, rawSha256: digest({ http: answer.status }) };
    // [CARD-STAGING-TEST 10 Nov 2026] A transaction PowerTranz does not know: HTTP 204 with no body. Unknown, never "nothing taken".
    if (answer.status === 204) return { status: 'unknown', reason: 'LOOKUP_NOT_FOUND', rawSha256: digest({ http: 204 }) };
    const record = answer.shape === 'json' ? readTransactionRecord(answer.json, input.notBefore?.getTime(), this.now().getTime() + VOID_DATE_SKEW_MS) : null;
    const rawSha256 = answer.shape === 'json' ? blindedDigest(answer.json) : digest({ unreadable: true });
    if (!record) return { status: 'unknown', reason: 'LOOKUP_UNREADABLE', rawSha256 };
    return { record, rawSha256 };
  }

  // -------------------------------------------------------------------------
  // The owner's self-check (PT-5): OK / FAIL only, never a value
  // -------------------------------------------------------------------------

  /** [CARD-STAGING-TEST 10 Nov 2026] Self-check only: post RedirectData's one form, as the partner's browser does,
   *  to the API root's own origin (never anywhere else), and read what PowerTranz answered (hostedPageAnswer). */
  private async openHostedPage(redirectData: string, returnUrl: string): Promise<HostedPageCheck> {
    const form = redirectForm(redirectData);
    if (!form) return 'could_not_tell';
    let target: URL;
    try { target = new URL(form.action, this.config.apiRoot); } catch { return 'could_not_tell'; }
    if (target.protocol !== 'https:' || target.origin !== this.config.apiRoot) return 'could_not_tell';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.http(target.href, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body: new URLSearchParams(form.fields).toString(),
      });
      const html = await res.text();
      return res.status >= 200 && res.status < 300 ? hostedPageAnswer(html, returnUrl, target.href) : 'could_not_tell';
    } catch {
      return 'could_not_tell';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * - alive: GET /api/alive answers (sec. 3);
   * - credentials: a request the gateway must authenticate (sec. 2.2 1.4) is
   *   not refused as "Invalid credentials" (Appendix 1: 89 / 312). It carries
   *   no card and no amount and fails validation by design — nothing is created;
   * - hostedPage (sandbox only, `preprocess`): a Sale for the smallest amount
   *   is preprocessed (SP4) with this PageSet/PageName. Preprocessing is no
   *   authorization (sec. 7.3) and Swift never completes it: no money moves.
   *   [CARD-STAGING-TEST 10 Nov 2026] SP4 does NOT prove the page exists: the
   *   sandbox preprocessed a Sale whose page set lacked "PTZ/" and refused the
   *   page itself only when the browser opened it (757). So the check then
   *   opens the page as the browser does (openHostedPage) and FAILs unless
   *   PowerTranz shows its card form; the prefix is also checked with the
   *   settings (PAGE_SET_PREFIX). Opening it shows a form: still no money.
   */
  async selfCheck(opts: { preprocess: boolean; returnUrl: string }): Promise<Array<{ check: string; ok: boolean }>> {
    const out: Array<{ check: string; ok: boolean }> = [];
    const alive = await this.call(PATH.alive, { method: 'GET', headers: { accept: 'application/json' } });
    out.push({ check: 'gateway reachable', ok: alive.shape !== 'transport' && alive.status >= 200 && alive.status < 300 });
    const probe = await this.call(PATH.riskMgmt, { method: 'POST', headers: this.headers(true), body: '{}' });
    const refusedCredentials = probe.shape !== 'transport' && (probe.status === 401 || probe.status === 403
      || (probe.shape === 'json' && isObject(probe.json) && (str(probe.json['IsoResponseCode']) === '89' || errorCodes(probe.json).includes('312'))));
    // [DS845 S3] Accepted ONLY on a readable gateway answer (2xx, a JSON object,
    // not a system-error code — Appendix 1) that is not the credentials refusal:
    // the gateway authenticated, then refused the empty body by design. No answer,
    // another HTTP status (404, 5xx), an unreadable body or a system error says
    // nothing about the credentials: FAIL, "could not tell".
    const readable = probe.shape === 'json' && probe.status >= 200 && probe.status < 300 && isObject(probe.json)
      && !AMBIGUOUS_ISO.has(str(probe.json['IsoResponseCode']) ?? '');
    out.push(refusedCredentials || readable
      ? { check: 'credentials accepted', ok: !refusedCredentials }
      : { check: 'credentials accepted (could not tell: the gateway gave no readable answer)', ok: false });
    if (opts.preprocess && this.binding.environment === 'sandbox') {
      const created = await this.createSession({
        binding: this.binding, sessionRef: `selfcheck-${randomBytes(6).toString('hex')}`, purpose: 'PAY_NOW',
        returnUrl: opts.returnUrl, expiresAt: new Date(this.now().getTime() + 60_000), amountMinor: 100, currencyCode: 'GYD',
      });
      out.push({ check: SELF_CHECK_PAGE_LINE, ok: created.status === 'succeeded' });
      if (created.status === 'succeeded') {
        const record = this.key.session(created.providerSessionRef);
        try {
          const opened = await this.openHostedPage(await this.redis.hget(record, 'redirectData') ?? '', opts.returnUrl).catch((): HostedPageCheck => 'could_not_tell');
          out.push({ check: SELF_CHECK_PAGE_OPENS[opened], ok: opened === 'shown' });
          await this.abandon(record, 'SELF_CHECK');
        } finally {
          await this.redis.pexpire(record, SELF_CHECK_RECORD_TTL_MS).catch(() => 0);
        }
      }
    }
    return out;
  }
}

/** The first accepted return's decision stands: written once, never rewritten. */
const CLAIM_COMPLETION = `
if redis.call('HEXISTS', KEYS[1], 'completion') == 1 then return 0 end
redis.call('HSET', KEYS[1], 'completion', 'sending', 'completionClaimedAtMs', ARGV[1])
return 1
`;

/** [CARD-LOOKUP] One read per transaction per window, on Redis's clock (TIME): refuses (0) inside the window;
 *  otherwise counts the read and opens the next window, twice the last (first ARGV[1] ms, at most ARGV[2] ms), and
 *  returns it. The record expires ARGV[3] ms after the last read. */
const LOOKUP_GATE = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local nextAt = tonumber(redis.call('HGET', KEYS[1], 'nextAtMs') or '0')
if now < nextAt then return 0 end
local n = redis.call('HINCRBY', KEYS[1], 'reads', 1)
local wait = tonumber(ARGV[1]) * (2 ^ (n - 1))
if wait > tonumber(ARGV[2]) then wait = tonumber(ARGV[2]) end
redis.call('HSET', KEYS[1], 'nextAtMs', string.format('%.0f', now + wait))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return wait`;

const NOTE_ONCE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HSETNX', KEYS[1], 'returnedAtMs', ARGV[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'authDecision', ARGV[2], 'authNote', ARGV[3])
return 1`;
