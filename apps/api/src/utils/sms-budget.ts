import type Redis from 'ioredis';
import { guyanaDayKey } from './guyana-day';
import { publicLaunchCountryFromPhone } from '../modules/auth/launch-market';
import { log } from './logger';
import { otpBudgetRefusalCounter } from '../plugins/observability';

// Cost guardrails for outbound OTP SMS — the dominant, unauthenticated, abusable
// SMS-cost vector. The per-minute limit (utils/otp.ts) stops bursts; these are
// the HARD DAILY CEILINGS so a sustained spam/abuse spike can't run up an insane
// Twilio bill. Each ceiling is tunable via env.
//
// Audit High #2 (S0): the shared global counter was spendable with throwaway
// random/foreign numbers — every distinct number owns its per-phone counters,
// so a flood burned the one global budget and 429'd real logins nationwide.
// Defense in depth, ordered so the SMALLEST bucket trips first:
//   1. per-phone  — one number cannot be bombed forever (8/day);
//   2. per-IP     — one actor cannot drain anything shared (100/day); this
//                   counter is for UNKNOWN numbers only, see below;
//   3. global     — junk/new numbers share one circuit breaker (5000/day);
//   4. known      — EXISTING verified accounts (and admins) draw from a
//                   SEPARATE budget, so a flood of new-number requests can
//                   never lock them out (5000/day).
// Known numbers deliberately skip the per-IP counter. Guyana's mobile
// subscribers sit behind carrier-grade NAT, so an attacker (or simply a busy
// day) on the same carrier IP would otherwise lock every existing account on
// that NAT pool out of login — the exact outage this budget exists to prevent.
// A known number is already bounded per phone (1/min, hourly, 8/day) and by
// the known budget; the per-IP counter's one job is to stop a single actor
// draining the shared junk budget with throwaway numbers.
// A provider failure refunds this call's increments, so failed sends don't
// permanently burn the day's budget.
//
// [AUD-L4-008] Two more rules:
//   • DESTINATION: nothing budgeted here is ever counted or allowed for a
//     number outside a public launch market (auth/launch-market.ts, the list
//     the login guard reads). A number without its leading + is refused too,
//     so one destination is always one counter.
//   • SAFETY TEXTS (a passenger's trip link, an emergency contact's
//     confirmation code) have a budget of their own, checkSafetySmsBudget
//     below, and never touch the login counters above. They used to share
//     them, so a flood of login codes to unknown numbers refused them for the
//     rest of the day. The SOS text to a verified contact is not budgeted at
//     all (safety/sos-escalation.ts) and never waits on any of this.
//
// NOTE: the definitive total-spend ceiling is a Twilio account spending limit +
// geo-permissions (restrict to the launch market's dial code). Set those too.

const PHONE_DAILY_PREFIX = 'otp_phone_day:';
const IP_DAILY_PREFIX = 'otp_ip_day:';
const GLOBAL_DAILY_PREFIX = 'sms_global_day:';
const KNOWN_DAILY_PREFIX = 'sms_known_day:';
// [AUDIT-20261113 FABLE-03 S3-5] Known numbers per address, and the admins' own reserve.
const KNOWN_IP_DAILY_PREFIX = 'otp_known_ip_day:';
const ADMIN_DAILY_PREFIX = 'sms_admin_day:';
// Safety texts count only against these. None of them is a login counter.
const SAFETY_SENDER_DAILY_PREFIX = 'sms_safety_sender_day:';
const SAFETY_RECIPIENT_DAILY_PREFIX = 'sms_safety_recipient_day:';
const SAFETY_DAILY_PREFIX = 'sms_safety_day:';
const DAY_TTL = 86400; // 24h

const DEFAULT_PHONE_DAILY_CAP = 8;
const DEFAULT_IP_DAILY_CAP = 100;
const DEFAULT_GLOBAL_DAILY_CAP = 5000;
const DEFAULT_KNOWN_DAILY_CAP = 5000;
/** Generous on purpose: many real customers share one carrier-NAT address. One source can no longer spend the
 *  whole known budget; it can spend this much of it. Tunable (OTP_KNOWN_IP_DAILY_CAP). */
const DEFAULT_KNOWN_IP_DAILY_CAP = 200;
/** Admin numbers draw from this reserve, never the known budget a flood can exhaust (OTP_ADMIN_DAILY_CAP). */
const DEFAULT_ADMIN_DAILY_CAP = 100;
const DEFAULT_SAFETY_SENDER_DAILY_CAP = 30;
const DEFAULT_SAFETY_RECIPIENT_DAILY_CAP = 10;
const DEFAULT_SAFETY_DAILY_CAP = 2000;

function dayStamp(): string {
  // The reset is midnight GYT (America/Guyana), not UTC — the day a
  // Guyanese subscriber means.
  return guyanaDayKey(new Date());
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export type SmsBudgetReason =
  | 'destination_country'
  | 'phone_daily' | 'ip_daily' | 'global_daily' | 'known_daily' | 'known_ip_daily' | 'admin_daily'
  | 'sender_daily' | 'recipient_daily' | 'safety_daily';

/**
 * [AUD-L4-008] The ONE destination rule for every budgeted text: the number is
 * in a public launch market. It reads the same authority as the login guard
 * (auth/launch-market.ts), so the two can never disagree. A number without its
 * leading + resolves to no country and is refused.
 */
export function smsDestinationAllowed(phone: string): boolean {
  return publicLaunchCountryFromPhone(phone) !== null;
}

export interface SmsBudgetOptions {
  /** The proxy-resolved client IP. When present, a per-IP daily budget trips
   *  long before the shared global counter can be drained by one actor.
   *  Not consulted for known phones (carrier-NAT note in the header). */
  ip?: string;
  /** True when the number belongs to an existing verified account/admin.
   *  Such numbers draw from the separate known-phone budget. */
  knownPhone?: boolean;
  /** [AUDIT-20261113 S3-5] The number belongs to an account holding an admin role: it draws from the admins'
   *  own reserve, so a flood that spends the known budget never locks the console out. */
  adminPhone?: boolean;
}

/**
 * [AUDIT-20261113 FABLE-03 S4] The address a per-address counter is keyed on. An IPv6 client controls a whole
 * /64 (2^64 addresses), so every address in one /64 is one address here; IPv4 is used as is.
 */
export function addressBucket(ip: string): string {
  const addr = ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
  if (!addr.includes(':')) return addr;
  const [head = '', tail = ''] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  const prefix = groups.slice(0, 4).map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''));
  return `${prefix.join(':')}::/64`;
}

/** Log once when a shared daily counter crosses 80% of its cap, so operations hear before it trips. */
function warnNearCap(count: number, cap: number, lane: string): void {
  if (count === Math.ceil(cap * 0.8)) log().error({ lane, cap }, `[sms-budget] ${lane} daily SMS budget is 80% spent`);
}

export interface SmsBudgetResult {
  allowed: boolean;
  reason?: SmsBudgetReason;
  /** Undo THIS call's counter increments (a provider failure must not burn
   *  the day's budget). Present only when the call was allowed. */
  refund?: () => Promise<void>;
}

/**
 * [REVIEW-2499-B S3-2] An OTP budget refusal is never silent: every one is counted on
 * swift_otp_budget_refusals_total{lane}, and the per-address known share and the admin reserve (the lanes that can
 * refuse an existing account, the owner included) log their first refusal of the day as an error. The log carries the
 * lane and its cap only: never the number or the address.
 */
function denyOtp(reason: SmsBudgetReason, count: number, cap: number): SmsBudgetResult {
  try { otpBudgetRefusalCounter.labels(reason).inc(); } catch { /* a metric never blocks the answer */ }
  if ((reason === 'known_ip_daily' || reason === 'admin_daily') && count === cap + 1) {
    log().error({ lane: reason, cap }, `[sms-budget] ${reason} refused a code: this lane is spent for today`);
  }
  return deny(reason);
}

function deny(reason: SmsBudgetReason): SmsBudgetResult {
  // No refund on a refusal: nothing was sent, and the spent increments are
  // the per-attempt guardrails doing their job (an abuser must not get them
  // back for free).
  return { allowed: false, reason };
}

/**
 * Per-phone, per-IP and global daily caps on OTP SMS. Atomic INCR per attempt;
 * a send is allowed only while every applicable counter is within its cap, so
 * the number of paid sends can never exceed the caps for a given Guyana day.
 * Known phones (existing verified accounts, admins) skip the per-IP counter
 * and draw from their own budget instead of the shared one.
 * Tunable via OTP_PHONE_DAILY_CAP (8), OTP_IP_DAILY_CAP (100),
 * OTP_GLOBAL_DAILY_CAP (5000, junk/new numbers) and OTP_KNOWN_DAILY_CAP
 * (5000, existing verified phones).
 */
export async function checkOtpDailyBudget(
  redis: Redis,
  phone: string,
  opts: SmsBudgetOptions = {},
): Promise<SmsBudgetResult> {
  // [AUD-L4-008] Before any counter: a number outside the launch market is
  // never counted and never allowed, whichever caller asks.
  if (!smsDestinationAllowed(phone)) return deny('destination_country');

  const day = dayStamp();
  const phoneCap = intEnv('OTP_PHONE_DAILY_CAP', DEFAULT_PHONE_DAILY_CAP);
  const ipCap = intEnv('OTP_IP_DAILY_CAP', DEFAULT_IP_DAILY_CAP);
  const globalCap = intEnv('OTP_GLOBAL_DAILY_CAP', DEFAULT_GLOBAL_DAILY_CAP);
  const knownCap = intEnv('OTP_KNOWN_DAILY_CAP', DEFAULT_KNOWN_DAILY_CAP);

  const spent: string[] = [];

  const phoneKey = `${PHONE_DAILY_PREFIX}${day}:${phone}`;
  const phoneCount = await redis.incr(phoneKey);
  if (phoneCount === 1) await redis.expire(phoneKey, DAY_TTL);
  spent.push(phoneKey);
  if (phoneCount > phoneCap) return denyOtp('phone_daily', phoneCount, phoneCap);

  // Unknown numbers only: a known account must keep working from a carrier
  // NAT IP that junk (or a busy day) has already exhausted.
  if (opts.ip && !opts.knownPhone) {
    const ipKey = `${IP_DAILY_PREFIX}${day}:${addressBucket(opts.ip)}`;
    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) await redis.expire(ipKey, DAY_TTL);
    spent.push(ipKey);
    if (ipCount > ipCap) return denyOtp('ip_daily', ipCount, ipCap);
  }

  // [AUDIT-20261113 S3-5] An admin number draws from the admins' own reserve (and skips the per-address share:
  // the per-phone caps above bound it), so the console can always get a code while an attack is under way.
  if (opts.adminPhone) {
    const adminCap = intEnv('OTP_ADMIN_DAILY_CAP', DEFAULT_ADMIN_DAILY_CAP);
    const adminCount = await spend(redis, `${ADMIN_DAILY_PREFIX}${day}`, spent);
    warnNearCap(adminCount, adminCap, 'admin');
    if (adminCount > adminCap) return denyOtp('admin_daily', adminCount, adminCap);
    return { allowed: true, refund: () => refundSpend(redis, spent) };
  }

  // [AUDIT-20261113 S3-5] Known numbers: one address spends at most its own share of the known budget. Public
  // store and rider numbers otherwise let one source use up the day for every existing account.
  if (opts.ip && opts.knownPhone) {
    const knownIpCap = intEnv('OTP_KNOWN_IP_DAILY_CAP', DEFAULT_KNOWN_IP_DAILY_CAP);
    const knownIpCount = await spend(redis, `${KNOWN_IP_DAILY_PREFIX}${day}:${addressBucket(opts.ip)}`, spent);
    // [REVIEW-2499-B S3-2] one address (a carrier NAT can carry many real customers) warns at 80% of its share
    warnNearCap(knownIpCount, knownIpCap, 'known_ip');
    if (knownIpCount > knownIpCap) return denyOtp('known_ip_daily', knownIpCount, knownIpCap);
  }

  const budgetKey = opts.knownPhone ? `${KNOWN_DAILY_PREFIX}${day}` : `${GLOBAL_DAILY_PREFIX}${day}`;
  const budgetCount = await redis.incr(budgetKey);
  if (budgetCount === 1) await redis.expire(budgetKey, DAY_TTL);
  spent.push(budgetKey);
  const budgetCap = opts.knownPhone ? knownCap : globalCap;
  warnNearCap(budgetCount, budgetCap, opts.knownPhone ? 'known' : 'global');
  if (budgetCount > budgetCap) {
    return denyOtp(opts.knownPhone ? 'known_daily' : 'global_daily', budgetCount, budgetCap);
  }

  const refund = () => refundSpend(redis, spent);
  return { allowed: true, refund };
}

export interface SafetySmsBudgetOptions {
  /** The account asking for the text. */
  senderId: string;
}

/** INCR one daily counter, arm its expiry on first use, and note it for a refund. */
async function spend(redis: Redis, key: string, spent: string[]): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, DAY_TTL);
  spent.push(key);
  return count;
}

/**
 * [AUD-L4-008] The daily budget for SAFETY texts: a passenger's trip link and
 * an emergency contact's confirmation code. None of its counters is a login
 * counter, so no flood of login codes can refuse a safety text, and no safety
 * text spends anyone's login allowance. Checked in this order:
 *   1. per sender        — one account sends at most 30 a day, so no single
 *                          account can use up (3) for everyone;
 *   2. per sender+number — one account texts one number at most 10 times a
 *                          day. Keyed on the pair, never on the number alone,
 *                          so what a stranger sends a number can never stop
 *                          someone else's text reaching it;
 *   3. platform-wide     — all safety texts share one ceiling of 2000 a day.
 * The sender's own counter comes first, so an account over its allowance
 * spends nothing else. As above, a refusal keeps its increments and an
 * allowed call returns a refund for a provider failure.
 * Tunable via SMS_SAFETY_SENDER_DAILY_CAP (30), SMS_SAFETY_RECIPIENT_DAILY_CAP
 * (10) and SMS_SAFETY_DAILY_CAP (2000).
 */
export async function checkSafetySmsBudget(
  redis: Redis,
  phone: string,
  opts: SafetySmsBudgetOptions,
): Promise<SmsBudgetResult> {
  if (!smsDestinationAllowed(phone)) return deny('destination_country');

  const day = dayStamp();
  const spent: string[] = [];

  const senderCount = await spend(redis, `${SAFETY_SENDER_DAILY_PREFIX}${day}:${opts.senderId}`, spent);
  if (senderCount > intEnv('SMS_SAFETY_SENDER_DAILY_CAP', DEFAULT_SAFETY_SENDER_DAILY_CAP)) return deny('sender_daily');

  const recipientCount = await spend(redis, `${SAFETY_RECIPIENT_DAILY_PREFIX}${day}:${opts.senderId}:${phone}`, spent);
  if (recipientCount > intEnv('SMS_SAFETY_RECIPIENT_DAILY_CAP', DEFAULT_SAFETY_RECIPIENT_DAILY_CAP)) return deny('recipient_daily');

  const safetyCount = await spend(redis, `${SAFETY_DAILY_PREFIX}${day}`, spent);
  if (safetyCount > intEnv('SMS_SAFETY_DAILY_CAP', DEFAULT_SAFETY_DAILY_CAP)) return deny('safety_daily');

  return { allowed: true, refund: () => refundSpend(redis, spent) };
}

async function refundSpend(redis: Redis, keys: string[]): Promise<void> {
  for (const key of keys) {
    // DECR only while positive — a refund must never dig a negative hole
    // that absorbs a future legitimate increment.
    await redis.eval(
      "if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return redis.call('DECR', KEYS[1]) end return 0",
      1,
      key,
    );
  }
}
