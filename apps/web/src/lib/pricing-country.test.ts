import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPricing } from './api';

// [SEC-AUDIT 13 Nov 2026 · F15] The public /pricing page hands its ?country= straight to fetchPricing. Each distinct
// URL is a new entry in Next's fetch cache that nothing removes, so only a real two-letter code may reach the URL,
// and it is encoded as one query value: never extra parameters, never a cache key an outsider can mint at will.
describe('fetchPricing country', () => {
  const urls: string[] = [];
  afterEach(() => { urls.length = 0; vi.unstubAllGlobals(); });
  const stub = () => vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ success: true, data: { country: 'GY' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  it('sends a two-letter code as the only query value', async () => {
    stub();
    await fetchPricing('GY');
    await fetchPricing('tt');
    expect(urls.map((u) => new URL(u).search)).toEqual(['?country=GY', '?country=TT']);
  });

  it('anything else is dropped (the API default), never spliced into the URL', async () => {
    stub();
    for (const injected of ['GY&n=1', 'GY#x', 'G', 'GUY', '../x', 'GY%26n%3D1', ' GY', '']) await fetchPricing(injected);
    await fetchPricing(undefined);
    expect(new Set(urls.map((u) => new URL(u).pathname + new URL(u).search))).toEqual(new Set(['/api/v1/auth/pricing']));
  });
});
