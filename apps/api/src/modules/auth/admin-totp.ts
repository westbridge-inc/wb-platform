import crypto from 'node:crypto';
import { decryptBuffer, encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 FABLE-03 #2] A SECOND FACTOR FOR THE ADMIN CONSOLE.
//
// An admin account signed in with a texted code alone, so anyone who received
// that phone's texts (a SIM swap, a recycled number, a carrier interception,
// a Twilio log) held the whole console. An admin now proves a code from an
// authenticator app (TOTP, RFC 6238: HMAC-SHA1, 30-second steps, 6 digits)
// before the admin API answers, when ADMIN_TOTP_REQUIRED=1. The switch is off
// by default so the owner enrols first.
//
// The shared secret is stored only encrypted (AES-256-GCM under a fresh key
// wrapped by MASTER_KEK, the same envelope as verification documents). A code
// is accepted once (the last accepted step is kept), within one step either
// side for clock drift. Ten recovery codes are shown once at enrolment and
// stored as SHA-256 digests; each works once.
// ---------------------------------------------------------------------------

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_DRIFT_STEPS = 1;
export const RECOVERY_CODE_COUNT = 10;
export const TOTP_ISSUER = 'Swift';

/** The switch: on only when exactly "1". */
export function adminTotpRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env['ADMIN_TOTP_REQUIRED'] === '1';
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP for one counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/** The code for a time (used by tests and nowhere else in production). */
export function totpAt(secret: Buffer, nowMs: number): string {
  return hotp(secret, stepAt(nowMs));
}

/**
 * The step a presented code matches, within the drift window and strictly after `lastStep` (a code is accepted
 * once); null when none does. Compared in constant time.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(nowMs);
  let found: number | null = null;
  for (let s = now - TOTP_DRIFT_STEPS; s <= now + TOTP_DRIFT_STEPS; s++) {
    if (lastStep !== null && s <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(code)) && found === null) found = s;
  }
  return found;
}

export function newTotpSecret(): Buffer {
  return crypto.randomBytes(TOTP_SECRET_BYTES);
}

/** The enrolment link an authenticator app reads. Names Swift and the role, never the phone number. */
export function otpauthUrl(secretB32: string, label = 'Swift admin'): string {
  const params = new URLSearchParams({ secret: secretB32, issuer: TOTP_ISSUER, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(`${TOTP_ISSUER}:${label}`)}?${params.toString()}`;
}

// ── storage: the secret only ever at rest encrypted ──────────────────────────

const ENVELOPE_VERSION = 'v1';

export function totpStorageUnavailable(): AppError {
  return new AppError(503, 'ADMIN_MFA_UNAVAILABLE', 'Authenticator sign-in cannot be set up on this server right now (its encryption key is not configured). Nothing changed.');
}

export async function sealTotpSecret(secret: Buffer): Promise<string> {
  const keys = getKeyProvider();
  if (!keys) throw totpStorageUnavailable();
  const dek = generateDek();
  const { ciphertext, iv, authTag } = encryptBuffer(secret, dek);
  const wrapped = await keys.wrapDek(dek);
  return [ENVELOPE_VERSION, wrapped, iv, authTag, ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join('.');
}

export async function openTotpSecret(sealed: string): Promise<Buffer> {
  const keys = getKeyProvider();
  if (!keys) throw totpStorageUnavailable();
  const [version, wrapped, iv, tag, ct] = sealed.split('.');
  if (version !== ENVELOPE_VERSION || !wrapped || !iv || !tag || !ct) throw new Error('Unreadable authenticator secret');
  const dek = await keys.unwrapDek(Buffer.from(wrapped, 'base64'));
  return decryptBuffer(Buffer.from(ct, 'base64'), dek, Buffer.from(iv, 'base64'), Buffer.from(tag, 'base64'));
}

// ── recovery codes ───────────────────────────────────────────────────────────

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from(crypto.randomBytes(10), (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}
export const normaliseRecoveryCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const recoveryDigest = (code: string): string => crypto.createHash('sha256').update(`swift-admin-recovery:${normaliseRecoveryCode(code)}`).digest('hex');
