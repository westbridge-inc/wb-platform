import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveIdentityByPhone } from '../auth/preauth-identity';
import { setMarketingConsent } from '../legal/marketing-consent';
import { runWithTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { smsDestinationAllowed } from '../../utils/sms-budget';
import { guyanaDayKey } from '../../utils/guyana-day';
import { inboundStopConfigured, isStopKeyword } from './marketing-message';

/**
 * [R22 · research B13 · DPA s.17(2)-(3)] A texted STOP works: a reply of STOP (or another
 * opt-out keyword) to Swift's number withdraws the sender's marketing consent in the ledger,
 * exactly as the app's Account → Marketing messages switch does (surface 'sms').
 *
 * Twilio posts each incoming text here (the number's "A message comes in" webhook).
 *  - Only a request Twilio signed is read: X-Twilio-Signature = base64 HMAC-SHA1 of the exact
 *    URL Twilio called followed by every form field (name then value, names sorted), keyed by
 *    the account's auth token. Anything else is refused before the body is used.
 *  - Off until both settings exist (TWILIO_WEBHOOK_AUTH_TOKEN, entered by the owner at a hidden prompt,
 *    and TWILIO_INBOUND_SMS_URL, the URL set in Twilio): until then it answers 503 and records
 *    nothing — and no marketing text can be sent (marketing-message.ts STOP_NOT_READY).
 *  - The number and the words are never logged. An unknown number, or words that are not an
 *    opt-out keyword, change nothing.
 * Withdrawing marketing never touches service texts (codes, orders, safety).
 */

export const SMS_INBOUND_BODY_LIMIT = 16 * 1024;
const SMS_INBOUND_RATE = { max: 120, timeWindow: '1 minute' } as const;
const MAX_FIELDS = 64;

/** The reply to a STOP: who it is from and what stopped (GSM-7, one part). It promises nothing
 *  about other texts: the SMS provider's own opt-out handling may also act on a STOP. */
export const STOP_CONFIRMATION = 'Swift: you will get no more marketing messages from Swift.';

type FormFields = Record<string, string[]>;

function parseForm(text: string): FormFields {
  const out: FormFields = Object.create(null);
  let count = 0;
  for (const [key, value] of new URLSearchParams(text)) {
    if (++count > MAX_FIELDS) throw new Error('too many form fields');
    (out[key] ??= []).push(value);
  }
  return out;
}

function isFormFields(value: unknown): value is FormFields {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

/** Twilio's request signature over `url` and the posted form fields. */
export function twilioSignature(authToken: string, url: string, fields: FormFields): string {
  const data = Object.keys(fields).sort().reduce((acc, key) => acc + [...fields[key]!].sort().map((v) => key + v).join(''), url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function signatureValid(header: unknown, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function twiml(reply: FastifyReply, message?: string) {
  return reply.type('text/xml').send(message ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xml(message)}</Message></Response>` : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

export async function smsInboundRoutes(app: FastifyInstance): Promise<void> {
  // Twilio posts a form; scoped to these routes (the server has no global form parser).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: SMS_INBOUND_BODY_LIMIT }, (_request, body, done) => {
    try {
      done(null, parseForm(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post('/inbound', {
    bodyLimit: SMS_INBOUND_BODY_LIMIT,
    config: { rateLimit: { ...SMS_INBOUND_RATE, keyGenerator: (request: FastifyRequest) => request.ip } },
  }, async (request, reply) => {
    if (!inboundStopConfigured()) {
      log().error('[R22] inbound SMS arrived but STOP handling is not configured (TWILIO_WEBHOOK_AUTH_TOKEN / TWILIO_INBOUND_SMS_URL); nothing recorded');
      return reply.code(503).type('text/plain').send('not configured');
    }
    // Only the form this route parses is ever signed by the provider; any other body is refused.
    const fields = isFormFields(request.body) ? request.body : null;
    const expected = fields && twilioSignature(process.env['TWILIO_WEBHOOK_AUTH_TOKEN']!.trim(), process.env['TWILIO_INBOUND_SMS_URL']!.trim(), fields);
    if (!fields || !expected || !signatureValid(request.headers['x-twilio-signature'], expected)) {
      log().warn('[R22] inbound SMS refused: missing or wrong Twilio signature');
      return reply.code(403).type('text/plain').send('forbidden');
    }
    const from = fields['From']?.[0] ?? '';
    const words = fields['Body']?.[0] ?? '';
    if (!isStopKeyword(words) || !/^\+[1-9]\d{6,14}$/.test(from)) return twiml(reply);

    const identity = await resolveIdentityByPhone(app.prisma, from);
    if (identity) {
      const outcome = await runWithTenant(identity.tenantId, () => setMarketingConsent(app.prisma, {
        userId: identity.id, granted: false, surface: 'sms', ip: null,
        evidence: { control: 'sms_stop', keyword: words.trim().replace(/[.!]+$/, '').toUpperCase(), messageSid: fields['MessageSid']?.[0] ?? null },
      }));
      log().info({ changed: outcome.changed }, '[R22] texted STOP: marketing consent withdrawn');
    }
    // The same answer whether or not the number has an account: no oracle.
    // [AUDIT-20261113 FABLE-03 S4 3.10] The confirmation is a paid text: only to a launch-market number, once per
    // number per Guyana day, under a daily ceiling. Beyond that the opt-out above still stands; no text answers it.
    if (!(await mayConfirmStop(app, from))) return twiml(reply);
    return twiml(reply, STOP_CONFIRMATION);
  });
}

/** [AUDIT-20261113 S4] STOP confirmations a Guyana day may cost, across all numbers (SMS_STOP_REPLY_DAILY_CAP). */
export const DEFAULT_STOP_REPLY_DAILY_CAP = 200;

async function mayConfirmStop(app: FastifyInstance, from: string): Promise<boolean> {
  if (!smsDestinationAllowed(from)) return false;
  try {
    const day = guyanaDayKey(new Date());
    if ((await app.redis.set(`sms_stop_reply:${day}:${from}`, '1', 'EX', 86_400, 'NX')) !== 'OK') return false;
    const n = await app.redis.incr(`sms_stop_reply_day:${day}`);
    if (n === 1) await app.redis.expire(`sms_stop_reply_day:${day}`, 86_400);
    const cap = Number(process.env['SMS_STOP_REPLY_DAILY_CAP']);
    return n <= (Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_STOP_REPLY_DAILY_CAP);
  } catch (err) {
    // No counter, no paid reply: the opt-out is already recorded.
    log().warn({ err }, '[S4] STOP reply budget unavailable; confirmation text skipped');
    return false;
  }
}

