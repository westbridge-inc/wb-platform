import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StoreQrPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [WEB-QR · audit C8] "Print counter card": the server already prints the store's card (GET /vendor/qr/assets/pdf,
// template "card", owners and managers). The phone says "Unavailable" (it cannot download the signed-in file yet);
// the website can, so it downloads the PDF to print, once Swift has confirmed the code opens THIS store (as every
// other share on the page).
// ---------------------------------------------------------------------------

const SHORT = 'https://swiftgy.test/s/abcdfghjkm';
const asked: Array<{ url: URL; headers: Record<string, string> }> = [];

function qrApi(opts: { verdict?: string; card?: 'ok' | 'limit' | 'fail' } = {}) {
  const base = mockApi(({ url }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: 'OWNER' } } };
    if (path === '/vendor/qr') return { body: { success: true, data: { shortUrl: SHORT, shortCode: 'ABCDFGHJKM', canonicalUrl: 'https://swiftgy.test/store/sample', version: 2, status: 'ACTIVE', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', vendorName: 'Sample Kitchen' } } };
    if (path === '/public/qr/ABCDFGHJKM') return { body: { success: true, data: { verdict: opts.verdict ?? 'WEB_RENDER', vendorId: 'store-1' } } };
    return { status: 404, body: { success: false } };
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/vendor/qr/assets/pdf') {
      asked.push({ url, headers: init?.headers as Record<string, string> });
      if (opts.card === 'limit') return new Response(JSON.stringify({ success: false, error: { message: 'Too many requests' } }), { status: 429 });
      if (opts.card === 'fail') return new Response(JSON.stringify({ success: false, error: { message: 'The card could not be made right now.' } }), { status: 503 });
      return new Response(new Blob(['%PDF-1.7']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="swift-qr-card.pdf"' } });
    }
    return base(input, init);
  }));
}

/** Each file the page saved: the link it clicked, as `address|file name`. */
let saved: () => string[] = () => [];
beforeEach(async () => {
  asked.length = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:card'), revokeObjectURL: vi.fn() }));
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  saved = () => clicked.mock.contexts.map((link) => `${(link as HTMLAnchorElement).href}|${(link as HTMLAnchorElement).download}`);
  (await import('@/lib/auth')).setSelectedStore('store-1');
});
afterEach(() => { vi.restoreAllMocks(); });

const cardSection = async () => screen.findByRole('region', { name: 'Print counter card' });

describe('[WEB-QR] the website prints the counter card the server makes', () => {
  it('downloads the server\'s print-ready card for the selected store, under the server\'s file name', async () => {
    qrApi();
    const { user } = renderWithQuery(<StoreQrPage />);
    const card = await cardSection();
    expect(card.textContent).toContain('A print-ready card with your live code');
    const button = within(card).getByRole('button', { name: 'Download the card (PDF)' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await waitFor(() => expect(saved()).toEqual(['blob:card|swift-qr-card.pdf']));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url.searchParams.get('template')).toBe('card');
    expect(asked[0]!.headers['x-vendor-id']).toBe('store-1');
    expect((await within(card).findByRole('status')).textContent).toContain('Downloaded');
  });

  it('a code that does not open this store yet: no card to print', async () => {
    qrApi({ verdict: 'NOT_FOUND' });
    renderWithQuery(<StoreQrPage />);
    const card = await cardSection();
    await screen.findByText('This code is not taking customers to a live store yet.');
    expect((within(card).getByRole('button', { name: 'Download the card (PDF)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it('the hourly limit and a failed card say so', async () => {
    qrApi({ card: 'limit' });
    const { user } = renderWithQuery(<StoreQrPage />);
    let card = await cardSection();
    const button = within(card).getByRole('button', { name: 'Download the card (PDF)' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    expect((await within(card).findByRole('alert')).textContent).toBe('You have downloaded the card many times this hour. Try again later.');
    expect(saved()).toHaveLength(0);
    qrApi({ card: 'fail' });
    await user.click(button);
    card = await cardSection();
    await waitFor(() => expect(within(card).getByRole('alert').textContent).toBe('The card could not be made right now.'));
  });
});
