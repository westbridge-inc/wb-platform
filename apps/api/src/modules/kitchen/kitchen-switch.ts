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
 * back, no call leaves Swift, the webhook answers 404 and the poller does nothing — every store behaves exactly as
 * before. A leaf (no imports) so every reader shares one answer.
 */

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

export interface DragontailSettings {
  /** Order.source. The spec: 1 store, 2 online, 3 mobile, and "custom source types can be configured".
   *  TODO-CONFIRM: the custom source id Dragontail assigns to Swift. Default 2 (online) until then. */
  sourceId: number;
  /** Order.paymentMethod for an MMG order (the spec: 0 cash, 1 credit, 2 other1, 3 other2). TODO-CONFIRM. */
  mmgPaymentCode: number;
  /** /login userLevel. The spec's example sends -1. TODO-CONFIRM. */
  userLevel: number;
  /** Per-request timeout. */
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
  /** GetPosNotification poll interval (the spec recommends 15 s). 0 = webhook only. */
  pollSeconds: number;
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
    timeoutMs: int(env['DRAGONTAIL_TIMEOUT_MS'], 8_000, 500, 60_000),
    orderIdBase: int(env['DRAGONTAIL_ORDER_ID_BASE'], 1_900_000_000, 0, 2_100_000_000),
    webhookCheck: pick(env['DRAGONTAIL_WEBHOOK_CHECK'], ['shared', 'signature', 'both'] as const, 'shared'),
    webhookHeader: ((env['DRAGONTAIL_WEBHOOK_HEADER'] ?? '').trim() || 'x-dragontail-shared').toLowerCase(),
    webhookSignatureHeader: ((env['DRAGONTAIL_WEBHOOK_SIGNATURE_HEADER'] ?? '').trim() || 'x-dragontail-signature').toLowerCase(),
    acceptOn: pick(env['DRAGONTAIL_ACCEPT_ON'], ['INSERT_OK', 'KITCHEN_ACTION'] as const, 'INSERT_OK'),
    ackTimeoutMs: int(env['DRAGONTAIL_ACK_TIMEOUT_SECONDS'], 180, 30, 3_600) * 1000,
    cancelMode: pick(env['DRAGONTAIL_CANCEL_MODE'], ['REMOVE_ITEMS', 'REFUND_TICKET'] as const, 'REMOVE_ITEMS'),
    pollSeconds: int(env['DRAGONTAIL_POLL_SECONDS'], 15, 0, 3_600),
  };
}
