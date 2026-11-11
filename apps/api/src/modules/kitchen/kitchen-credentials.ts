/**
 * [KITCHEN-INTEGRATION] Where a store's kitchen-system credentials live: NEVER in the database.
 *
 * "DT will provide a username and password per POS" (Dragontail spec, /login). They arrive as ONE secret,
 * DRAGONTAIL_CREDENTIALS, delivered as a file by the deploy secret store (utils/secret-files.ts) and entered by the
 * owner at a hidden prompt. Its content is JSON, one entry per reference:
 *
 *   { "<ref>": { "userName": "…", "password": "…" }, "<webhook-ref>": { "webhookSecret": "…" } }
 *
 * A store's connection row names only the reference (secretRef / webhookSecretRef). No value is ever logged,
 * returned by an API, or written to a row; errors name the reference, never the content.
 */

export interface KitchenLogin {
  userName: string;
  password: string;
}

type Env = Record<string, string | undefined>;
type Entry = { userName?: unknown; password?: unknown; webhookSecret?: unknown };

/** A reference is a short slug: it is shown to operators and stored on the row. */
export const SECRET_REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function entries(env: Env): Record<string, Entry> | null {
  const raw = env['DRAGONTAIL_CREDENTIALS'];
  if (!raw || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, Entry> : null;
  } catch {
    return null;
  }
}

/** The login a reference names, or null when the secret or the entry is missing or malformed. */
export function kitchenLoginFor(ref: string | null | undefined, env: Env = process.env): KitchenLogin | null {
  if (!ref || !SECRET_REF_SHAPE.test(ref)) return null;
  const entry = entries(env)?.[ref];
  if (!entry || typeof entry !== 'object') return null;
  const { userName, password } = entry;
  return typeof userName === 'string' && userName !== '' && typeof password === 'string' && password !== ''
    ? { userName, password }
    : null;
}

/** The webhook secret a reference names, or null. */
export function kitchenWebhookSecretFor(ref: string | null | undefined, env: Env = process.env): string | null {
  if (!ref || !SECRET_REF_SHAPE.test(ref)) return null;
  const entry = entries(env)?.[ref];
  const secret = entry && typeof entry === 'object' ? entry.webhookSecret : undefined;
  return typeof secret === 'string' && secret.length >= 16 ? secret : null;
}

/** Operator-facing: does the reference resolve? Says which part is missing, never a value. */
export function kitchenSecretStatus(ref: string | null | undefined, webhookRef: string | null | undefined, env: Env = process.env) {
  return {
    credentialsLoaded: entries(env) !== null,
    login: kitchenLoginFor(ref, env) !== null,
    webhookSecret: kitchenWebhookSecretFor(webhookRef, env) !== null,
  };
}
