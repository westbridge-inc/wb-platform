/**
 * [COMPANY-DOCS PART 2 · security review] The letter-of-authority texts count on their OWN counters, never on the
 * signer's sign-in ones. The signer's number is typed by someone else (the account holder): if these texts spent the
 * sign-in budget of that number (its per-minute cool-down, hourly cap or daily cap), any account could lock a real
 * person out of signing in to Swift. So:
 *  - link texts: at most LINK_TEXTS_PER_NUMBER_PER_DAY to one number per Guyana day, ACROSS all accounts;
 *  - code texts: one a minute and CODE_TEXTS_PER_NUMBER_PER_DAY per number per day;
 *  - all letter texts together: LETTER_TEXTS_PER_DAY a day (the cost ceiling), separate from the sign-in budget.
 * Each claim gives its counts back when the text could not be sent. The per-account caps (requests a day, resends,
 * codes per request) stay on top (authority-letter.service.ts).
 */
import type Redis from 'ioredis';
import { guyanaDayKey } from '../../../utils/guyana-day';

export const LINK_TEXTS_PER_NUMBER_PER_DAY = 3;
export const CODE_TEXTS_PER_NUMBER_PER_DAY = 10;
export const CODE_TEXT_COOLDOWN_S = 60;
export const LETTER_TEXTS_PER_DAY = 1000;
const DAY_S = 86_400;

export const letterLinkDayKey = (phone: string, at = new Date()) => `authority_letter_link_day:${guyanaDayKey(at)}:${phone}`;
export const letterCodeDayKey = (phone: string, at = new Date()) => `authority_letter_code_day:${guyanaDayKey(at)}:${phone}`;
export const letterCodeCooldownKey = (phone: string) => `authority_letter_code_cd:${phone}`;
const letterTotalKey = (at = new Date()) => `authority_letter_sms_day:${guyanaDayKey(at)}`;

export type LetterTextClaim =
  | { allowed: true; refund: () => Promise<void> }
  | { allowed: false; reason: 'number_daily' | 'total_daily' | 'cooldown'; retryAfterSeconds?: number };

async function counted(redis: Redis, key: string, cap: number): Promise<boolean> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, DAY_S);
  if (n > cap) { await redis.decr(key); return false; }
  return true;
}

/** One link text to `phone` (a request, or a resend). */
export async function claimLetterLinkText(redis: Redis, phone: string, at = new Date()): Promise<LetterTextClaim> {
  const numberKey = letterLinkDayKey(phone, at);
  if (!(await counted(redis, numberKey, LINK_TEXTS_PER_NUMBER_PER_DAY))) return { allowed: false, reason: 'number_daily' };
  const totalKey = letterTotalKey(at);
  if (!(await counted(redis, totalKey, LETTER_TEXTS_PER_DAY))) { await redis.decr(numberKey); return { allowed: false, reason: 'total_daily' }; }
  return { allowed: true, refund: async () => { await redis.decr(numberKey); await redis.decr(totalKey); } };
}

/** One code text to `phone`: a minute apart, a daily cap per number, and the shared letter ceiling. */
export async function claimLetterCodeText(redis: Redis, phone: string, at = new Date()): Promise<LetterTextClaim> {
  const cooldownKey = letterCodeCooldownKey(phone);
  const claimed = await redis.set(cooldownKey, '1', 'EX', CODE_TEXT_COOLDOWN_S, 'NX');
  if (claimed !== 'OK') {
    const ttl = await redis.ttl(cooldownKey);
    return { allowed: false, reason: 'cooldown', retryAfterSeconds: ttl > 0 ? ttl : CODE_TEXT_COOLDOWN_S };
  }
  const numberKey = letterCodeDayKey(phone, at);
  if (!(await counted(redis, numberKey, CODE_TEXTS_PER_NUMBER_PER_DAY))) return { allowed: false, reason: 'number_daily' };
  const totalKey = letterTotalKey(at);
  if (!(await counted(redis, totalKey, LETTER_TEXTS_PER_DAY))) { await redis.decr(numberKey); return { allowed: false, reason: 'total_daily' }; }
  return { allowed: true, refund: async () => { await redis.decr(numberKey); await redis.decr(totalKey); await redis.del(cooldownKey); } };
}
