/**
 * [EXPO-PUSH-AUTH] The Expo access token the push adapter sends with every
 * call to Expo's push service (send and receipts), so the project's "enhanced
 * push security" can be switched on: with it on, Expo refuses any push that
 * does not carry the project's token, so a device token alone can no longer
 * reach a phone.
 *
 * The token is a secret: deployed hosts get it as EXPO_ACCESS_TOKEN_FILE from
 * the encrypted store (utils/secret-files.ts), never as a value in a settings
 * file. It is OPTIONAL: unset (or blank) sends no Authorization header,
 * exactly as before, so nothing changes until the owner adds it.
 *
 * The format rule is deliberately loose, so a server never depends on Expo's
 * own alphabet: after trimming, any printable ASCII without spaces. Refused,
 * naming the setting and never the value, are only the shapes of a bad paste
 * that can never work: a space, line break, control or non-ASCII character
 * (a smart quote, a zero-width character from a web page), a value wrapped in
 * quotes, a "Bearer " prefix, or a NAME=value line. The owner's prompt helpers
 * check a value with this SAME rule before sending it, so a bad paste is
 * caught at the prompt rather than at the next boot.
 */
const PRINTABLE_NO_SPACE = /^[\x21-\x7E]+$/;
const QUOTE = /^["'`]|["'`]$/;
const BEARER_PREFIX = /^bearer(?:\s|$|:)/i;
/** An `=` before the end that is not trailing padding (`NAME=value`). */
const ASSIGNMENT = /=[^=]|^EXPO_ACCESS_TOKEN=/;

type Env = Record<string, string | undefined>;

/** Why a non-blank, trimmed value is not usable, or null when it is. Words only, never the value. */
export function expoAccessTokenProblem(token: string): string | null {
  if (BEARER_PREFIX.test(token)) return 'it starts with "Bearer"; store the token alone';
  if (!PRINTABLE_NO_SPACE.test(token)) return 'it has a space, a line break or a character that is not plain ASCII';
  if (QUOTE.test(token)) return 'it is wrapped in quotes; store the token alone';
  if (ASSIGNMENT.test(token)) return 'it looks like NAME=value; store the token alone';
  return null;
}

/** The token, or null when unset or blank. A set value that is not usable is refused. */
export function expoAccessToken(env: Env = process.env): string | null {
  const token = (env['EXPO_ACCESS_TOKEN'] ?? '').trim();
  if (token === '') return null;
  const problem = expoAccessTokenProblem(token);
  if (problem) {
    throw new Error(`FATAL: EXPO_ACCESS_TOKEN is set but is not usable (${problem}). Fix the secret or remove it. Refusing to start.`);
  }
  return token;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The push URL the token travels to must be https (plain http only to this
 *  machine, for tests): a token is never sent in clear text. Refused, naming
 *  the setting, only while a token is set. */
export function assertExpoPushUrlCarriesToken(url: string, token: string | null): void {
  if (!token) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('FATAL: EXPO_PUSH_URL is not a URL, and EXPO_ACCESS_TOKEN is set. Refusing to start.');
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)) return;
  throw new Error('FATAL: EXPO_PUSH_URL must be https while EXPO_ACCESS_TOKEN is set (the token is never sent in clear text). Refusing to start.');
}

export const DEFAULT_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Boot check, every mode: a set token must be usable and travel over https. */
export function assertExpoAccessTokenConfig(env: Env): void {
  assertExpoPushUrlCarriesToken(env['EXPO_PUSH_URL'] ?? DEFAULT_EXPO_PUSH_URL, expoAccessToken(env));
}

/** The boot log line: whether a token is set, never any part of it. */
export function expoPushTokenBootLine(env: Env = process.env): string {
  return `expo push token: ${(env['EXPO_ACCESS_TOKEN'] ?? '').trim() ? 'set' : 'not set'}`;
}

/** The text of an error with every copy of the token replaced, for messages
 *  built from a provider reply or a network error (neither should carry it,
 *  but a message is the one place a value could leak into a log). */
export function withoutToken(text: string, token: string | null): string {
  return token ? text.split(token).join('[redacted]') : text;
}
