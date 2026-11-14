import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '@/components/site';
import RefundsPage from '@/app/legal/refunds/page';
import { forgetCardPaymentsAnswer } from '@/lib/use-card-payments';

// ---------------------------------------------------------------------------
// [Q36 item 9 · CARDS-SWITCH-ON · review #2465-B F3/F4] The card methods follow THE SERVER, never a build flag and
// never literal text. The public site lists Visa and Mastercard (and the refunds page says the weekly fee can be paid
// by card) only while the API says a partner can pay by card right now: the browser asks the web server
// (/api/card-payments), which asks the API (GET /api/v1/public/capabilities → cardPayments). Until the answer is
// exactly "live" — while it is on its way, if it fails, on any other host — no card is listed or teased (the partner
// checkout census forbids teasing a method that does not exist). The footer never says cards pay for advertising:
// ads are off, and nothing takes an ad payment by card.
// ---------------------------------------------------------------------------

const PUBLIC_HOST = 'swiftgy.com';
let cardQuestions = 0;
let apiAnswer: () => Promise<Response>;

function hostIs(host: string) {
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, host, hostname: host } });
}

beforeEach(() => {
  forgetCardPaymentsAnswer();
  cardQuestions = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/card-payments')) {
      cardQuestions += 1;
      const { GET } = await import('@/app/api/card-payments/route');
      return GET();
    }
    if (url.endsWith('/api/v1/public/capabilities')) return apiAnswer();
    return new Response('{}', { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  hostIs('localhost');
});

const apiSays = (cardPayments: unknown) => {
  apiAnswer = async () => Response.json({ success: true, data: { adsEnabled: false, cardPayments } });
};

async function answered() {
  await waitFor(() => expect(cardQuestions).toBeGreaterThan(0));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const listed = () => within(screen.getByRole('region', { name: 'Payment methods' })).getAllByRole('listitem').map((item) => item.textContent);

describe('[Q36 · CARDS-SWITCH-ON] the card methods follow the server', () => {
  it('the API says cards are live: the public site lists Visa and Mastercard, for the weekly partner fee only', async () => {
    hostIs(PUBLIC_HOST);
    apiSays('live');
    render(<SiteFooter />);
    await answered();
    await waitFor(() => expect(listed()).toEqual(['Cash', 'MMG', 'Visa', 'Mastercard']));
    const region = screen.getByRole('region', { name: 'Payment methods' });
    expect(region.textContent).toContain("Visa and Mastercard are for Swift's own weekly partner fee.");
    expect(region.textContent).not.toMatch(/advertis/i);
  });

  it.each([
    ['the API says soon', () => apiSays('soon')],
    ['the API answers something else', () => apiSays(true)],
    ['the API answers 500', () => { apiAnswer = async () => new Response('{}', { status: 500 }); }],
    ['the API cannot be reached', () => { apiAnswer = async () => { throw new TypeError('fetch failed'); }; }],
    ['the API answer is not JSON', () => { apiAnswer = async () => new Response('not json', { status: 200 }); }],
  ])('%s: no card is listed or teased', async (_label, arrange) => {
    hostIs(PUBLIC_HOST);
    arrange();
    render(<SiteFooter />);
    await answered();
    expect(listed()).toEqual(['Cash', 'MMG']);
    const region = screen.getByRole('region', { name: 'Payment methods' });
    expect(region.textContent).toContain('Orders are paid to the business itself, in cash or by MMG.');
    expect(region.textContent).not.toMatch(/visa|mastercard|card|soon/i);
  });

  it('while the answer is on its way, nothing about cards shows', () => {
    hostIs(PUBLIC_HOST);
    apiAnswer = () => new Promise(() => {}); // never answers
    render(<SiteFooter />);
    expect(listed()).toEqual(['Cash', 'MMG']);
  });

  it('every other host (staging, previews, local runs) asks nothing and lists no card, whatever the API says', async () => {
    for (const host of ['localhost:3000', 'staging.swiftgy.com', 'preview.example.test']) {
      forgetCardPaymentsAnswer();
      hostIs(host);
      apiSays('live');
      const view = render(<SiteFooter />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(listed(), host).toEqual(['Cash', 'MMG']);
      view.unmount();
    }
    expect(cardQuestions).toBe(0);
  });

  it('the refunds page mentions cards only once the server says they are live', async () => {
    hostIs(PUBLIC_HOST);
    apiSays('live');
    const view = render(<RefundsPage />);
    await answered();
    await waitFor(() => expect(view.container.textContent).toContain('It can also be paid by Visa or Mastercard'));
    view.unmount();
    forgetCardPaymentsAnswer();
    cardQuestions = 0;
    apiSays('soon');
    render(<RefundsPage />);
    await answered();
    expect(document.body.textContent).toContain('Today the fee is paid by MMG, or directly to Westbridge Inc., in person by cash or cheque, or by bank transfer; a cheque counts once it clears, and a payment counts once Swift records it.');
    expect(document.body.textContent).not.toMatch(/visa|mastercard|coming soon/i);
  });

  it('the web server asks the API and never lets its own answer be cached', async () => {
    const { GET } = await import('@/app/api/card-payments/route');
    apiSays('live');
    let response = await GET();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ cardPayments: 'live' });
    apiSays('soon');
    response = await GET();
    expect(await response.json()).toEqual({ cardPayments: 'soon' });
  });
});
