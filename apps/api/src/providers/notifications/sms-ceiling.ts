import type Redis from 'ioredis';
import type { SmsOptions, SmsProvider } from './channels';
import { gsm7Parts, gsm7Sms } from '../../utils/sms-text';
import { guyanaDayKey } from '../../utils/guyana-day';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 FABLE-03 S3-6] THE LAST-RESORT DAILY CEILING ON PAID TEXTS.
//
// Sign-in codes and safety texts have budgets of their own; everything else
// (store backup texts, STOP replies, fee notices, on-call re-pages ...) had no
// overall ceiling, and the 1 Nov spike came from exactly such an uncounted
// class. Every text the real provider sends is now counted, in message PARTS,
// against one Guyana-day ceiling (SMS_DAILY_PARTS_CEILING, default 10000).
// Past it, a text is refused (the caller sees a provider failure, as for any
// refused send) — except a LIFE-SAFETY text (an SOS text to a contact, an
// on-call page), which is counted but never refused. 80% logs an error once.
// Redis trouble never blocks a text: the ceiling is a backstop, Twilio's own
// usage trigger is the outside one.
// ---------------------------------------------------------------------------

const CEILING_PREFIX = 'sms_parts_day:';
export const DEFAULT_SMS_DAILY_PARTS_CEILING = 10_000;

let store: Pick<Redis, 'incrby' | 'decrby' | 'expire'> | null = null;
/** The Redis the ceiling counts in (set by the redis plugin). Without one, nothing is counted or refused. */
export function setSmsCeilingStore(redis: Pick<Redis, 'incrby' | 'decrby' | 'expire'> | null): void {
  store = redis;
}
/** A closing Redis stops being the ceiling's store (only if it still is). */
export function releaseSmsCeilingStore(redis: object): void {
  if (store === redis) store = null;
}

function ceiling(): number {
  const v = Number(process.env['SMS_DAILY_PARTS_CEILING']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_SMS_DAILY_PARTS_CEILING;
}

/** The parts a body is billed as (GSM-7 after the provider's own conversion; UCS-2 67 a part otherwise). */
export function billedParts(body: string): number {
  const gsm = gsm7Sms(body);
  const parts = gsm7Parts(gsm);
  return Number.isFinite(parts) ? parts : Math.max(1, Math.ceil(gsm.length / 67));
}

export class SmsCeilingReachedError extends Error {
  constructor() { super('SMS daily ceiling reached'); }
}

export function withSmsCeiling(inner: SmsProvider): SmsProvider {
  const wrapped: SmsProvider = {
    sendSms: async (to: string, body: string, options?: SmsOptions) => {
      const redis = store;
      if (!redis) return inner.sendSms(to, body, options);
      const parts = billedParts(body);
      const key = `${CEILING_PREFIX}${guyanaDayKey(new Date())}`;
      let count: number | null = null;
      try {
        count = await redis.incrby(key, parts);
        if (count === parts) await redis.expire(key, 2 * 86_400);
      } catch (err) {
        log().warn({ err }, '[S3-6] SMS ceiling counter unavailable; sending anyway');
      }
      if (count !== null) {
        const cap = ceiling();
        const warnAt = Math.ceil(cap * 0.8);
        if (count - parts < warnAt && count >= warnAt) log().error({ cap }, '[S3-6] 80% of the daily SMS parts ceiling is spent');
        if (count > cap && !options?.lifeSafety) {
          await redis.decrby(key, parts).catch(() => undefined);
          log().error({ cap }, '[S3-6] daily SMS parts ceiling reached: a non-life-safety text was refused');
          throw new SmsCeilingReachedError();
        }
      }
      try {
        return await inner.sendSms(to, body, options);
      } catch (err) {
        // Nothing left: the parts are given back.
        if (count !== null) await redis.decrby(key, parts).catch(() => undefined);
        throw err;
      }
    },
  };
  if (inner.supportsHandoff) wrapped.supportsHandoff = true;
  return wrapped;
}
