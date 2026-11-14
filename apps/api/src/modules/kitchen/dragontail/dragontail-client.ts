import { KitchenPermanentError, KitchenTransientError } from '../kitchen-provider';
import type { KitchenLogin } from '../kitchen-credentials';

/**
 * [KITCHEN-INTEGRATION] Dragontail's HTTP rules, from its public POS API spec (v1.1.0), and nothing else:
 *
 *   - "stateful token header acquired by using the '/login' API Endpoint"; every other call sends `token`;
 *   - "A timed out token will respond with a Forbidden(403) status code, POS will have to re-login";
 *   - "Content-type is always application/json";
 *   - "Please retry all 50x response status codes as the error could be transient. We recommend up to 3 retries
 *     with some exponential backoff delay between requests";
 *   - "SSL will be required" when not on one machine (the address is checked: kitchen-switch.ts).
 *
 * One client per store login, kept by the caller so a token is REUSED until Dragontail answers 403 (a login per
 * send would also kill a concurrent holder's token if Dragontail keeps one per user). A 403 re-logs in ONCE and
 * repeats the request. Only a 50x is retried (up to 3 times, backoff 500 ms, 1 s, 2 s): the spec asks no more.
 * A timeout or network failure on a WRITE is never retried — it may have landed — and says so
 * (KitchenTransientError.mayHaveLanded). [DT-OUTAGE · owner 14 Nov 2026] EXCEPT a failure that certainly happened
 * before the request left Swift (requestNeverSent: connection refused, the name did not resolve, no route, the TLS
 * handshake failed, undici's own connect timeout): Dragontail cannot have it, so it is not "may have landed". When in
 * doubt (our own timeout, a reset, a refused redirect, anything unknown) it stays "may have landed": never a double
 * cook. Every request has a timeout, and a whole call chain has one deadline.
 * Redirects are refused: a 307/308 would re-send the login (or the token) to another address.
 * No credential, token or body is ever logged or put in an error message.
 */

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'error';
}) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface DragontailClientOptions {
  baseUrl: string;
  login: KitchenLogin;
  userLevel: number;
  timeoutMs: number;
  fetch?: FetchLike;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** First backoff; doubles per retry (500 ms, 1 s, 2 s by default). */
  backoffMs?: number;
  /** A token a previous client got for this login (reused until a 403). */
  token?: string | null;
  /** Told whenever the token changes (the caller's per-connection cache). */
  onToken?: (token: string | null) => void;
  now?: () => number;
}

export const DRAGONTAIL_MAX_RETRIES = 3;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** [DT-OUTAGE] Error codes that can only happen BEFORE a request is on the wire (no connection, no TLS session). */
const NEVER_SENT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN',
  'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT',
  // TLS: the handshake failed, so no HTTP request was ever sent.
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/**
 * [DT-OUTAGE] Did this fetch failure certainly happen before the request was sent? Only for a named connect-phase
 * code found on the error or its causes (Node's fetch wraps them: TypeError('fetch failed', { cause })). Our own
 * timeout (an abort), a reset, a socket closed mid-answer, a refused redirect (the server DID answer) and anything
 * unrecognised are NOT: when in doubt, the request may have arrived.
 */
export function requestNeverSent(err: unknown, aborted: boolean): boolean {
  if (aborted) return false;
  let at: unknown = err;
  for (let depth = 0; depth < 4 && at && typeof at === 'object'; depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT_CODES.has(code)) return true;
    // An AggregateError (happy eyeballs: every address refused) carries one per address: all must be connect-phase.
    const errors = (at as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0 && errors.every((e) => requestNeverSent(e, false))) return true;
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** The spec's failure words, kept for the operator (never a body, never a person's detail). */
function failureWords(text: string): string {
  try {
    const body = JSON.parse(text) as { status?: unknown; validationErrors?: unknown };
    const status = typeof body.status === 'string' ? body.status.slice(0, 40) : '';
    const fields = Array.isArray(body.validationErrors)
      ? body.validationErrors.map((v) => (v && typeof v === 'object' && typeof (v as { field?: unknown }).field === 'string' ? (v as { field: string }).field.slice(0, 40) : '')).filter(Boolean).slice(0, 5)
      : [];
    return [status, fields.length ? `fields ${fields.join(', ')}` : ''].filter(Boolean).join('; ');
  } catch {
    return '';
  }
}

export class DragontailClient {
  private token: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: number;
  private readonly now: () => number;
  /** The chain's deadline (ms since epoch), when set. */
  private deadline: number | null = null;
  /** Requests made (all endpoints, all attempts). Read by tests and the sync log. */
  calls = 0;

  constructor(private readonly opts: DragontailClientOptions) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? realSleep;
    this.backoffMs = opts.backoffMs ?? 500;
    this.token = opts.token ?? null;
    this.now = opts.now ?? Date.now;
  }

  /** Every request until clearDeadline() must finish by `at` (ms since epoch). */
  setDeadline(at: number | null): void {
    this.deadline = at;
  }

  private setToken(token: string | null) {
    this.token = token;
    this.opts.onToken?.(token);
  }

  /** POST /login → the token. A 400 is wrong credentials (final); 5xx is retried. */
  async login(): Promise<string> {
    const answer = await this.send('POST', '/login', {
      userName: this.opts.login.userName,
      password: this.opts.login.password,
      userLevel: this.opts.userLevel,
    }, false, true);
    if (answer.status !== 200) {
      throw new KitchenPermanentError(`Dragontail login refused (HTTP ${answer.status})`, true);
    }
    const body = answer.json as { token?: unknown; status?: unknown } | null;
    // The spec types token as an integer but its example is a string ("AE1234567890"): accept both.
    const token = body && (typeof body.token === 'string' || typeof body.token === 'number') ? String(body.token) : '';
    if (!token) throw new KitchenPermanentError('Dragontail login answered without a token', true);
    this.setToken(token);
    return token;
  }

  /** Drop the token (Dragontail said the session is gone): the next call logs in. */
  forgetToken(): void {
    this.setToken(null);
  }

  /** Log in only when there is no token yet. */
  async ensureToken(): Promise<void> {
    if (!this.token) await this.login();
  }

  /**
   * An authenticated call: logs in when there is no token, and once more on a 403. `idempotent` = a timeout may
   * be retried (reads); a write is never re-sent after a timeout.
   */
  async call(method: 'GET' | 'POST', path: string, body?: unknown, idempotent = method === 'GET'): Promise<{ status: number; json: unknown }> {
    await this.ensureToken();
    let answer = await this.send(method, path, body, true, idempotent);
    if (answer.status === 403) {
      this.setToken(null);
      await this.login();
      answer = await this.send(method, path, body, true, idempotent);
      if (answer.status === 403) {
        this.setToken(null);
        throw new KitchenPermanentError(`Dragontail refused ${path} after a fresh login (HTTP 403)`, true);
      }
    }
    return answer;
  }

  /** One request with the retry policy. Never throws for a non-5xx status: the caller decides. */
  private async send(method: 'GET' | 'POST', path: string, body: unknown, withToken: boolean, idempotent: boolean): Promise<{ status: number; json: unknown }> {
    let lastProblem = '';
    for (let attempt = 0; attempt <= DRAGONTAIL_MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        const wait = this.backoffMs * 2 ** (attempt - 1);
        if (this.deadline !== null && this.now() + wait >= this.deadline) break;
        await this.sleep(wait);
      }
      const remaining = this.deadline === null ? this.opts.timeoutMs : this.deadline - this.now();
      if (remaining <= 0) {
        lastProblem = lastProblem || 'the send deadline passed';
        break;
      }
      const controller = new AbortController();
      const timeout = Math.min(this.opts.timeoutMs, remaining);
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        this.calls += 1;
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (withToken && this.token) headers['token'] = this.token;
        const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          method,
          headers,
          ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
          signal: controller.signal,
          redirect: 'error',
        });
        const text = await res.text();
        if (res.status >= 500 && res.status <= 599) {
          const words = failureWords(text);
          lastProblem = `HTTP ${res.status}${words ? ` (${words})` : ''}`;
          continue;
        }
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        return { status: res.status, json };
      } catch (err) {
        // [DT-OUTAGE] Certainly never sent (no connection, no TLS session): Dragontail cannot have it.
        const neverSent = requestNeverSent(err, controller.signal.aborted);
        const problem = controller.signal.aborted ? `timed out after ${timeout} ms`
          : neverSent ? 'could not connect (nothing was sent)' : 'network error (or a refused redirect)';
        if (!idempotent && !neverSent) {
          // A write that may have reached Dragontail is never re-sent blind: the caller decides what it means.
          throw new KitchenTransientError(`Dragontail ${path}: ${problem}; it may have arrived`, true);
        }
        if (!idempotent) {
          // Never sent: not "may have arrived". Not retried either (the spec retries only 50x): the caller falls back.
          throw new KitchenTransientError(`Dragontail ${path}: ${problem}`, false);
        }
        lastProblem = problem;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new KitchenTransientError(`Dragontail ${path} failed (${lastProblem || 'no attempt fit the deadline'})`, false);
  }
}
