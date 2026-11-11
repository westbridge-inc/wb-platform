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
 *   - "SSL will be required" when not on one machine (the default address is https).
 *
 * One client per store login. Every request has a timeout. A 403 re-logs in ONCE and repeats the request; a 5xx
 * (or a timeout / network failure) is retried up to 3 times with exponential backoff; anything else is final.
 * No credential, token or body is ever logged or put in an error message.
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
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
}

export const DRAGONTAIL_MAX_RETRIES = 3;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class DragontailClient {
  private token: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffMs: number;
  /** Requests made (all endpoints, all attempts). Read by tests and the sync log. */
  calls = 0;

  constructor(private readonly opts: DragontailClientOptions) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? realSleep;
    this.backoffMs = opts.backoffMs ?? 500;
  }

  /** POST /login → the token. A 400 is wrong credentials (final); 5xx is retried. */
  async login(): Promise<string> {
    const answer = await this.send('POST', '/login', {
      userName: this.opts.login.userName,
      password: this.opts.login.password,
      userLevel: this.opts.userLevel,
    }, false);
    if (answer.status !== 200) {
      throw new KitchenPermanentError(`Dragontail login refused (HTTP ${answer.status})`);
    }
    const body = answer.json as { token?: unknown; status?: unknown } | null;
    // The spec types token as an integer but its example is a string ("AE1234567890"): accept both.
    const token = body && (typeof body.token === 'string' || typeof body.token === 'number') ? String(body.token) : '';
    if (!token) throw new KitchenPermanentError('Dragontail login answered without a token');
    this.token = token;
    return token;
  }

  /** An authenticated call: logs in when there is no token, and once more on a 403. */
  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    if (!this.token) await this.login();
    let answer = await this.send(method, path, body, true);
    if (answer.status === 403) {
      this.token = null;
      await this.login();
      answer = await this.send(method, path, body, true);
      if (answer.status === 403) throw new KitchenPermanentError(`Dragontail refused ${path} after a fresh login (HTTP 403)`);
    }
    return answer;
  }

  /** One request with the 5xx/timeout retry policy. Never throws for a non-5xx status: the caller decides. */
  private async send(method: 'GET' | 'POST', path: string, body: unknown, withToken: boolean): Promise<{ status: number; json: unknown }> {
    let lastProblem = '';
    for (let attempt = 0; attempt <= DRAGONTAIL_MAX_RETRIES; attempt += 1) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        this.calls += 1;
        const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (withToken && this.token) headers['token'] = this.token;
        const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
          method,
          headers,
          ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status >= 500 && res.status <= 599) {
          lastProblem = `HTTP ${res.status}`;
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
        lastProblem = controller.signal.aborted ? `timed out after ${this.opts.timeoutMs} ms` : 'network error';
        void err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new KitchenTransientError(`Dragontail ${path} failed after ${DRAGONTAIL_MAX_RETRIES + 1} attempts (${lastProblem})`);
  }
}
