import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssistedSetupPanel, liveConsentOf, paperState } from './assisted-setup';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// [ASSISTED SETUP · owner 12 Nov 2026] On the store page: record the store's OK first (who, how, when, after reading the
// words), then papers, menu (preview, then apply) and item photos, each with a reason.
const WORDS = 'I consent to Swift processing this document for verification, per the privacy notice.';
const view = (consents: unknown[], over: Record<string, unknown> = {}) => ({
  store: { id: 'vendor-1', name: 'Pepperpot Place', vendorType: 'RESTAURANT', status: 'PENDING_APPROVAL' },
  script: { question: 'May Swift add your store’s papers, menu and item photos to your Swift account for you?', consentText: WORDS, consentVersion: 'v1' },
  validDays: 14,
  consents,
  papers: { checklist: ['tin_certificate', 'storefront_photo'], optional: ['gra_restaurant_licence'], missing: ['tin_certificate'],
    documents: [{ id: 'd1', docType: 'storefront_photo', status: 'PENDING', createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, reviewNote: null, addedBySwift: true }] },
  items: [{ id: 'item-1', name: 'Pepperpot', category: 'Mains', imageUrl: null }],
  canAddItems: false,
  ...over,
});
const LIVE = { id: 'consent-1', agreedByName: 'Shan Persaud', agreedByRole: 'Owner', channel: 'IN_PERSON', agreedAt: '2026-11-12T09:00:00.000Z', reference: null, recordedByAdminId: 'a1', createdAt: '2026-11-12T09:01:00.000Z', live: true };
const ENDED = { ...LIVE, id: 'consent-0', live: false };

function api(data: unknown, post: (_request: ApiRequest) => unknown = () => ({})) {
  return mockApi((request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-1/assisted-setup') return { body: { success: true, data } };
    if (request.method === 'POST') return { body: { success: true, data: post(request) } };
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

describe('[ASSISTED SETUP] helpers', () => {
  it('the OK that covers today is the newest live one; a paper reads its newest copy', () => {
    expect(liveConsentOf([ENDED as never])).toBeNull();
    expect(liveConsentOf([LIVE as never, ENDED as never])?.id).toBe('consent-1');
    const docs = view([]).papers.documents as never;
    expect(paperState('storefront_photo', docs)).toEqual({ words: 'Waiting for review', tone: 'warn', addedBySwift: true });
    expect(paperState('tin_certificate', docs)).toEqual({ words: 'Not sent yet', tone: 'neutral', addedBySwift: false });
  });
});

describe('[ASSISTED SETUP] the panel', () => {
  it('without an OK: shows the words to read, and every upload stays closed', async () => {
    api(view([ENDED]));
    renderWithQuery(<AssistedSetupPanel vendorId="vendor-1" />);
    expect(await screen.findByText(`“${WORDS}”`)).toBeTruthy();
    expect(screen.getByText('Record the store’s OK first. Papers, menu and photos open after it.')).toBeTruthy();
    expect((screen.getByLabelText(/File for TIN certificate/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Menu file') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Photo for Pepperpot') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Record the store’s OK…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('records the OK: who, their role, how, when, a reference, the words read, and a reason', async () => {
    const fetchMock = api(view([]), () => ({ id: 'consent-1' }));
    const { user } = renderWithQuery(<AssistedSetupPanel vendorId="vendor-1" />);
    await user.type(await screen.findByLabelText('Who agreed (their name)'), 'Shan Persaud');
    await user.type(screen.getByLabelText('Their role at the store'), 'Owner');
    await user.selectOptions(screen.getByLabelText('How'), 'WHATSAPP');
    await user.type(screen.getByLabelText('Reference (optional)'), 'Chat 12 Nov');
    await user.click(screen.getByLabelText('I read these words to them and they said yes.'));
    await user.click(screen.getByRole('button', { name: 'Record the store’s OK…' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Owner asked us at the shop to set it up');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/vendors/vendor-1/assisted-setup/consent`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      agreedByName: 'Shan Persaud', agreedByRole: 'Owner', channel: 'WHATSAPP', reference: 'Chat 12 Nov', wordsRead: true, consentVersion: 'v1',
    });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe('Owner asked us at the shop to set it up');
  });

  it('with an OK: lists the store’s papers (required and optional, which Swift added) and opens the uploads', async () => {
    api(view([LIVE]));
    renderWithQuery(<AssistedSetupPanel vendorId="vendor-1" />);
    expect(await screen.findByText('Covers today')).toBeTruthy();
    expect((screen.getByLabelText(/File for TIN certificate/i) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText('Added by Swift with the store’s OK')).toBeTruthy();
    expect(screen.getByText(/another admin/)).toBeTruthy();
    // An unverified store: the menu can be previewed, never applied.
    expect(screen.getByText(/cannot add new items until its papers are approved/)).toBeTruthy();
  });

  it('a menu preview shows the rows the store’s own import would refuse, and Apply stays closed for an unverified store', async () => {
    const preview = {
      automap: { rowCount: 2, normalizedCsv: 'category,name,basePrice\nMains,Pepperpot,1500', mapping: {}, headers: [] },
      plan: { imported: 1, failedCount: 1, failures: [{ row: 3, errors: ['basePrice: A price is required'] }], notes: [], notesCount: 0, waitingForCheckCount: 0,
        rows: [{ row: 2, name: 'Pepperpot', category: 'Mains', basePrice: 1500 }] },
      canAddItems: false,
    };
    const fetchMock = api(view([LIVE]), () => preview);
    const { user } = renderWithQuery(<AssistedSetupPanel vendorId="vendor-1" />);
    const input = await screen.findByLabelText('Menu file');
    await user.upload(input, new File(['category,name,basePrice\nMains,Pepperpot,1500\nMains,Cook-up,'], 'menu.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('basePrice: A price is required', { exact: false })).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'POST')[0]![0]).toBe(`${API_ORIGIN}/api/v1/admin/vendors/vendor-1/assisted-setup/menu/preview`);
    expect((screen.getByRole('button', { name: 'Apply…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
