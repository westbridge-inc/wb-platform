import { randomBytes } from 'node:crypto';

/**
 * [KITCHEN-INTEGRATION] Where a store's kitchen-system credentials live: NEVER in the database.
 *
 * "DT will provide a username and password per POS" (Dragontail spec, /login). They arrive as ONE secret,
 * DRAGONTAIL_CREDENTIALS, delivered as a file by the deploy secret store (utils/secret-files.ts) and entered by the
 * owner at a hidden prompt. Its content is JSON, one entry per reference:
 *
 *   { "kitchen/dragontail/<id>/login": { "userName": "…", "password": "…" },
 *     "kitchen/dragontail/<id>/webhook": { "webhookSecret": "…" } }
 *
 * A store's connection row names only the reference (secretRef / webhookSecretRef). No value is ever logged,
 * returned by an API, or written to a row; errors name the reference, never the content.
 *
 * [security review · confused deputy] A reference is never chosen by a person: it is DERIVED from the connection's
 * own id (kitchen/<provider>/<connection id>/login and …/webhook), written by the server when the connection is
 * created, and held by the database (unique, and equal to the derived form). So one store's connection can never
 * be pointed at another store's login or webhook secret, and two connections never share one. The owner enters
 * the secret under the key the console shows; nothing in the API can set or change a credential or a reference.
 */

export interface KitchenLogin {
  userName: string;
  password: string;
}

type Env = Record<string, string | undefined>;
type Entry = { userName?: unknown; password?: unknown; webhookSecret?: unknown };

/** The only shape a reference has: kitchen/<provider lowercased>/<connection id>/(login|webhook). */
export const SECRET_REF_SHAPE = /^kitchen\/[a-z]+\/[a-z0-9]{8,40}\/(login|webhook)$/;

/** The login reference of a connection: derived, never supplied. */
export function kitchenLoginRef(integration: { id: string; provider: string }): string {
  return `kitchen/${integration.provider.toLowerCase()}/${integration.id}/login`;
}

/** The webhook-secret reference of a connection: derived, never supplied. */
export function kitchenWebhookRef(integration: { id: string; provider: string }): string {
  return `kitchen/${integration.provider.toLowerCase()}/${integration.id}/webhook`;
}

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

/** The login of a connection (by its own derived reference), or null when the secret or the entry is missing. */
export function kitchenLoginFor(integration: { id: string; provider: string }, env: Env = process.env): KitchenLogin | null {
  const ref = kitchenLoginRef(integration);
  if (!SECRET_REF_SHAPE.test(ref)) return null;
  const entry = entries(env)?.[ref];
  if (!entry || typeof entry !== 'object') return null;
  const { userName, password } = entry;
  return typeof userName === 'string' && userName !== '' && typeof password === 'string' && password !== ''
    ? { userName, password }
    : null;
}

/** The webhook secret of a connection (by its own derived reference), or null. */
export function kitchenWebhookSecretFor(integration: { id: string; provider: string }, env: Env = process.env): string | null {
  const ref = kitchenWebhookRef(integration);
  if (!SECRET_REF_SHAPE.test(ref)) return null;
  const entry = entries(env)?.[ref];
  const secret = entry && typeof entry === 'object' ? entry.webhookSecret : undefined;
  return typeof secret === 'string' && secret.length >= 16 ? secret : null;
}

/** Operator-facing: does the reference resolve? Says which part is missing, never a value. */
export function kitchenSecretStatus(integration: { id: string; provider: string }, env: Env = process.env) {
  return {
    credentialsLoaded: entries(env) !== null,
    loginKey: kitchenLoginRef(integration),
    login: kitchenLoginFor(integration, env) !== null,
    webhookKey: kitchenWebhookRef(integration),
    webhookSecret: kitchenWebhookSecretFor(integration, env) !== null,
  };
}

/** A new connection id: 25 lowercase hex-and-letter characters (cuid-like), so its references fit the shape. */
export function newKitchenIntegrationId(): string {
  return `k${randomBytes(12).toString('hex')}`;
}
