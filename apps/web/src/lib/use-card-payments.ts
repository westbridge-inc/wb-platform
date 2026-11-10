import { useSyncExternalStore } from 'react';
import { isPublicSiteHost } from './web-ordering';

/**
 * [CARDS-SWITCH-ON · review #2465-B F4] Can partners pay the weekly fee by card right now, as the server says?
 * On the public site the browser asks the web server once per page load (/api/card-payments, which follows the
 * API's own card switches); only the exact answer "live" says yes — never while the answer is on its way, if it
 * fails, or on any other host (staging, previews, local runs ask nothing and never list cards).
 */
let cardsAnswer: 'unknown' | 'live' | 'not-live' = 'unknown';
let asking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function ask(): void {
  asking ??= fetch('/api/card-payments', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { cardPayments?: string } | null) => { cardsAnswer = body?.cardPayments === 'live' ? 'live' : 'not-live'; })
    .catch(() => { cardsAnswer = 'not-live'; })
    .finally(() => { for (const listener of listeners) listener(); });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (isPublicSiteHost(window.location.host)) ask();
  return () => { listeners.delete(listener); };
}

export function useCardPaymentsLive(): boolean {
  return useSyncExternalStore(subscribe, () => isPublicSiteHost(window.location.host) && cardsAnswer === 'live', () => false);
}

/** Tests only: forget this page load's answer. */
export function forgetCardPaymentsAnswer(): void {
  cardsAnswer = 'unknown';
  asking = null;
}
