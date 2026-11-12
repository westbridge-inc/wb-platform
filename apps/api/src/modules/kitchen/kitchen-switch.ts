/**
 * [KITCHEN-INTEGRATION · owner 11 Nov 2026] The switch and the settings of the kitchen-system integration.
 *
 * A store whose kitchen runs Dragontail (Yum! brands' kitchen and dispatch system) can have its Swift orders sent
 * straight to that system instead of ringing the Swift tablet. Built from Dragontail's PUBLIC POS API spec (v1.1.0)
 * before credentials exist; everything the spec does not say (webhook authentication, how a cancel is expressed,
 * whether an accepted insert means the kitchen took the order) is a setting here, marked TODO-CONFIRM, so the
 * answers Dragontail gives with the credentials change configuration, not code.
 *
 * OFF by default, and it ships OFF ("dark"). While it is off: no order is claimed, no store's tablet ring is held
 * back, no call leaves Swift (the console's connection test is refused), the console's writing routes are refused
 * (nothing is written to the kitchen tables), the webhook route does not exist and the poller does not run — every
 * store behaves exactly as before. If it is turned off with claims still waiting (a kill switch in an incident), the
 * tablet backstop (the alert ladder and the hold-release sweep) rings each such order on the store's tablet.
 * A leaf (its only import is the runtime-mode parser) so every reader shares one answer.
 */

import { runtimeMode } from '../../utils/runtime-mode';

type Env = Record<string, string | undefined>;

export const DRAGONTAIL_INTEGRATION_ENV = 'DRAGONTAIL_INTEGRATION';

/** ON only at '1' (blanks ignored). */
export function dragontailIntegrationEnabled(env: Env = process.env): boolean {
  return (env['DRAGONTAIL_INTEGRATION'] ?? '').trim() === '1';
}

const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const value = Number((raw ?? '').trim());
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

/** The spec's server is `api.dragontailsystem.com`; https because the spec requires SSL whenever the kitchen system
 *  and the caller are not on one machine. TODO-CONFIRM: the base URL Dragontail issues with the credentials. */
export const DRAGONTAIL_DEFAULT_API_URL = 'https://api.dragontailsystem.com';

export function dragontailApiUrl(env: Env = process.env): string {
  const raw = (env['DRAGONTAIL_API_URL'] ?? '').trim();
  return (raw || DRAGONTAIL_DEFAULT_API_URL).replace(/\/+$/, '');
}

/** A test run, read through the one runtime-mode parser; an unset or unknown NODE_ENV is never a test run. */
function isTestRun(env: Env): boolean {
  try {
    return runtimeMode(env) === 'test';
  } catch {
    return false;
  }
}

/** [review A S3-3] The kitchen system's host family (the processor register's host). */
export const DRAGONTAIL_HOST_SUFFIX = 'dragontailsystem.com';

/**
 * Why this address may not carry a store login, or null when it may: https, and Dragontail's own host (or a
 * subdomain). A test run (NODE_ENV=test) may also use a loopback http address, for the mock server only.
 * Production refuses to boot on a problem while the switch is on (utils/boot-config.ts); every use re-checks.
 */
export function dragontailApiUrlProblem(raw: string, env: Env = process.env): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'DRAGONTAIL_API_URL is not a URL';
  }
  const host = url.hostname.toLowerCase();
  if (isTestRun(env) && url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) return null;
  if (url.protocol !== 'https:') return 'DRAGONTAIL_API_URL must be https';
  if (url.username || url.password) return 'DRAGONTAIL_API_URL must not carry a credential';
  if (host !== DRAGONTAIL_HOST_SUFFIX && !host.endsWith(`.${DRAGONTAIL_HOST_SUFFIX}`)) {
    return `DRAGONTAIL_API_URL must be ${DRAGONTAIL_HOST_SUFFIX} or a subdomain of it`;
  }
  return null;
}

/** [review A S3-1 · B S3-1] One deadline for a whole send (login + insert, and a re-login), well inside the lease. */
export const KITCHEN_SEND_BUDGET_MS = 45_000;
/** One cancel at the kitchen (a Swift cancel, or settling an UNKNOWN send). */
export const KITCHEN_CANCEL_BUDGET_MS = 15_000;
/** A send's lease: the budget plus a margin, taken from the moment THAT row is leased. */
export const KITCHEN_LEASE_MS = KITCHEN_SEND_BUDGET_MS + 30_000;
/** A claim still QUEUED/SENDING this long after it was made is stuck: the alert ladder rings the tablet. */
export const KITCHEN_STUCK_MS = 2 * KITCHEN_LEASE_MS;
/** [review B S3-2] A tick stops picking new work after this long (its lock outlives it). */
export const KITCHEN_TICK_BUDGET_MS = 60_000;
/** [review B S3-3] An insert that may have landed (UNKNOWN) waits this long for a sign of it at the kitchen (its
 *  events, its row in GetOrderUpdatesForPos) before Swift cancels it there and, once that goes through, rings the
 *  tablet. Never shorter than six polls at the spec's 15 s. */
export const KITCHEN_VERIFY_MS = 90_000;
/** An UNKNOWN order whose cancel did not go through is tried again this much later. */
export const KITCHEN_UNKNOWN_RETRY_MS = 30_000;
/** [review A S4-2] The longest driver route estimate Swift will believe (a longer one is capped to it). */
export const KITCHEN_MAX_ETA_SECONDS = 6 * 60 * 60;

export interface DragontailSettings {
  /** Order.source. The spec: 1 store, 2 online, 3 mobile, and "custom source types can be configured".
   *  TODO-CONFIRM: the custom source id Dragontail assigns to Swift. Default 2 (online) until then. */
  sourceId: number;
  /** Order.paymentMethod for an MMG order (the spec: 0 cash, 1 credit, 2 other1, 3 other2). TODO-CONFIRM. */
  mmgPaymentCode: number;
  /** /login userLevel. The spec's example sends -1. TODO-CONFIRM. */
  userLevel: number;
  /** Per-request timeout (at most 20 s, so a whole send fits KITCHEN_SEND_BUDGET_MS). */
  timeoutMs: number;
  /** Swift's order ids in Dragontail are base + a per-store counter, so they never meet the store's own POS ticket
   *  numbers under the same storeNo. Must stay within int32. TODO-CONFIRM the range with Dragontail. */
  orderIdBase: number;
  /** How the webhook proves it is Dragontail: a shared secret header, an HMAC-SHA256 signature of the raw body,
   *  or both. The spec defines neither. TODO-CONFIRM. */
  webhookCheck: 'shared' | 'signature' | 'both';
  webhookHeader: string;
  webhookSignatureHeader: string;
  /** When Swift counts the order accepted: when Dragontail's insert answers ok (INSERT_OK), or at the first kitchen
   *  action (KITCHEN_ACTION: ReachedTheMakeLine / Prepared / Cook / Pack). TODO-CONFIRM. */
  acceptOn: 'INSERT_OK' | 'KITCHEN_ACTION';
  /** In KITCHEN_ACTION mode: how long an inserted order may wait for its first kitchen action before the store's
   *  tablet is rung after all (and operations told). */
  ackTimeoutMs: number;
  /** How a cancel is sent: every item re-sent as removed (ItemsActions 2, "a deleted item will be displayed on the
   *  KDS as a Cancel command"), or a refund ticket (refundFor = the order: "both tickets would be cancelled").
   *  TODO-CONFIRM. */
  cancelMode: 'REMOVE_ITEMS' | 'REFUND_TICKET';
  /** Poll interval (the spec recommends 15 s). 0 = webhook only. */
  pollSeconds: number;
  /** [review B S2-2] GetPosNotification's consumer `id` ("requested if more than one consumers"): Swift never reads
   *  the store POS's own notifications. TODO-CONFIRM the id Dragontail assigns. */
  consumerId: string;
  /** [review B S2-2] Read the GetPosNotification queue at all? Off by default until Dragontail confirms whether
   *  it is consume-on-read: the poller then uses GetOrderUpdatesForPos only (read-only), plus the webhook. */
  pollQueue: boolean;
  /** [review A S4-1] Webhook replay window, seconds: with a signature check, a body whose signed `time` is older (or
   *  further ahead) than this is refused. 0 = off (default) until Dragontail confirms the signature and the time
   *  zone of `time` (TODO-CONFIRM 5, 9, 20). The spec carries no nonce. */
  webhookMaxAgeSeconds: number;
}

export function dragontailSettings(env: Env = process.env): DragontailSettings {
  const pick = <T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T => {
    const value = (raw ?? '').trim() as T;
    return allowed.includes(value) ? value : fallback;
  };
  return {
    sourceId: int(env['DRAGONTAIL_SOURCE_ID'], 2, 0, 1_000_000),
    mmgPaymentCode: int(env['DRAGONTAIL_MMG_PAYMENT_CODE'], 2, 0, 3),
    userLevel: int(env['DRAGONTAIL_USER_LEVEL'], -1, -1_000_000, 1_000_000),
    timeoutMs: int(env['DRAGONTAIL_TIMEOUT_MS'], 8_000, 500, 20_000),
    orderIdBase: int(env['DRAGONTAIL_ORDER_ID_BASE'], 1_900_000_000, 0, 2_100_000_000),
    webhookCheck: pick(env['DRAGONTAIL_WEBHOOK_CHECK'], ['shared', 'signature', 'both'] as const, 'shared'),
    webhookHeader: ((env['DRAGONTAIL_WEBHOOK_HEADER'] ?? '').trim() || 'x-dragontail-shared').toLowerCase(),
    webhookSignatureHeader: ((env['DRAGONTAIL_WEBHOOK_SIGNATURE_HEADER'] ?? '').trim() || 'x-dragontail-signature').toLowerCase(),
    acceptOn: pick(env['DRAGONTAIL_ACCEPT_ON'], ['INSERT_OK', 'KITCHEN_ACTION'] as const, 'INSERT_OK'),
    ackTimeoutMs: int(env['DRAGONTAIL_ACK_TIMEOUT_SECONDS'], 180, 30, 3_600) * 1000,
    cancelMode: pick(env['DRAGONTAIL_CANCEL_MODE'], ['REMOVE_ITEMS', 'REFUND_TICKET'] as const, 'REMOVE_ITEMS'),
    pollSeconds: int(env['DRAGONTAIL_POLL_SECONDS'], 15, 0, 3_600),
    consumerId: /^[A-Za-z0-9_-]{1,32}$/.test((env['DRAGONTAIL_CONSUMER_ID'] ?? '').trim()) ? (env['DRAGONTAIL_CONSUMER_ID'] ?? '').trim() : 'swift',
    pollQueue: (env['DRAGONTAIL_POLL_QUEUE'] ?? '').trim() === '1',
    webhookMaxAgeSeconds: int(env['DRAGONTAIL_WEBHOOK_MAX_AGE_SECONDS'], 0, 0, 3_600),
  };
}

/**
 * [review A S3-3] Boot guard, every mode: with the switch ON, the kitchen-system address must be https on
 * Dragontail's own host (a store login is sent to it), or nothing starts. Off: nothing is checked.
 */
export function assertKitchenIntegrationConfig(env: Env = process.env): void {
  if (!dragontailIntegrationEnabled(env)) return;
  const problem = dragontailApiUrlProblem(dragontailApiUrl(env), env);
  if (problem) throw new Error(`FATAL: DRAGONTAIL_INTEGRATION=1 but ${problem}. Refusing to start.`);
}
