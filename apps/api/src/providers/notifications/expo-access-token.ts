/**
 * [EXPO-PUSH-AUTH] The Expo access token the push adapter sends with every
 * call to Expo's push service (send and receipts), so the project's "enhanced
 * push security" can be switched on: with it on, Expo refuses any push that
 * does not carry the project's token, so a device token alone can no longer
 * reach a phone.
 *
 * The token is a secret: deployed hosts get it as EXPO_ACCESS_TOKEN_FILE from
 * the encrypted store (utils/secret-files.ts), never as a value in a settings
 * file. It is OPTIONAL: unset (or empty) sends no Authorization header, exactly
 * as before, so nothing changes until the owner adds it. A value that is set
 * but cannot travel as a bearer token (RFC 6750 b64token: letters, digits and
 * - . _ ~ + / with optional trailing =) is refused, naming the setting only,
 * never guessed at: sent anyway it would either fail every push or be cut.
 */
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

export function expoAccessToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = (env['EXPO_ACCESS_TOKEN'] ?? '').trim();
  if (token === '') return null;
  if (!BEARER_TOKEN.test(token)) {
    throw new Error('FATAL: EXPO_ACCESS_TOKEN is set but is not an Expo access token (letters, digits and - . _ ~ + / only). Fix the secret or remove it. Refusing to start.');
  }
  return token;
}

/** Boot check, every mode: a set token must be usable (see expoAccessToken). */
export function assertExpoAccessTokenConfig(env: Record<string, string | undefined>): void {
  expoAccessToken(env);
}

/** The text of an error with every copy of the token replaced, for messages
 *  built from a provider reply or a network error (neither should carry it,
 *  but a message is the one place a value could leak into a log). */
export function withoutToken(text: string, token: string | null): string {
  return token ? text.split(token).join('[redacted]') : text;
}
