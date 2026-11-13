import type Redis from 'ioredis';

// ---------------------------------------------------------------------------
// [FABLE-05 3.7] When a provider stops answering, the log must say how, and a
// person must hear of it.
//
// The error serializer replaces every error's message with [redacted] (a
// provider's message can echo the request: a phone number, a code), so a
// failed Twilio send read the same whether the key was revoked, the balance
// empty or Twilio down. A ProviderCallError carries the provider's HTTP status
// as a NUMBER of its own (or the words timeout / network), which a log line can
// keep as a field: never the message, never the body.
//
// recordProviderFailure counts failures per provider in five-minute buckets in
// Redis (kept an hour); the worker's watch (modules/ops/infra-watch.ts) reads
// the last two buckets and pages when they pass a threshold.
// ---------------------------------------------------------------------------

export type ProviderName = 'twilio' | 'mmg' | 'routing';
export type ProviderFailureKind = 'http' | 'timeout' | 'network' | 'invalid';

export class ProviderCallError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly kind: ProviderFailureKind,
    readonly status?: number,
    message?: string,
  ) {
    super(message ?? `${provider} call failed (${kind}${status === undefined ? '' : ` ${status}`})`);
    this.name = 'ProviderCallError';
  }
}

/** The provider's status for a log field: its HTTP status, or how it failed without one. */
export function providerStatusOf(err: unknown): number | 'timeout' | 'network' | 'invalid' | undefined {
  if (!(err instanceof ProviderCallError)) return undefined;
  if (err.kind === 'http') return typeof err.status === 'number' ? err.status : undefined;
  return err.kind;
}

/**
 * [Security review, 13 Nov] Does this failure say the PROVIDER is failing (and so count toward its
 * outage page)? Only when it did not answer (timeout, network), refused OUR side (401/403: the key or
 * the account; 429: our rate), answered with its own error (5xx) or with nonsense. A per-recipient
 * refusal (400 invalid number, 404, any other 4xx) is the caller's choice of number: anyone can ask
 * for codes to bad numbers, and that must never page the on-call phones. Anything that is not a
 * ProviderCallError never counts.
 */
export function countsAsProviderOutage(err: unknown): boolean {
  if (!(err instanceof ProviderCallError)) return false;
  if (err.kind !== 'http') return true;
  const status = err.status ?? 0;
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

export const PROVIDER_BUCKET_MS = 5 * 60_000;
const bucketKey = (provider: ProviderName, atMs: number) => `provider_fail:${provider}:${Math.floor(atMs / PROVIDER_BUCKET_MS)}`;

/** One failure (or `n`) at `atMs`. Best effort: callers fire and catch, a count never fails a request. */
export async function recordProviderFailure(redis: Pick<Redis, 'incrby' | 'expire'>, provider: ProviderName, atMs = Date.now(), n = 1): Promise<void> {
  const key = bucketKey(provider, atMs);
  await redis.incrby(key, n);
  await redis.expire(key, 3600);
}

/** Failures in this five-minute bucket and the one before it (five to ten minutes). */
export async function providerFailuresRecent(redis: Pick<Redis, 'mget'>, provider: ProviderName, nowMs = Date.now()): Promise<number> {
  const values = await redis.mget(bucketKey(provider, nowMs), bucketKey(provider, nowMs - PROVIDER_BUCKET_MS));
  return values.reduce((sum, v) => sum + (v === null ? 0 : Number(v) || 0), 0);
}

/** A provider answered: its recent failures no longer count. */
export async function clearProviderFailures(redis: Pick<Redis, 'del'>, provider: ProviderName, nowMs = Date.now()): Promise<void> {
  await redis.del(bucketKey(provider, nowMs), bucketKey(provider, nowMs - PROVIDER_BUCKET_MS));
}
