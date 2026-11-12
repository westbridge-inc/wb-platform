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
  papers: { checklist: ['tin_certificate', 'storefront_photo', 'owner_national_id', 'food_handler_attestation'], optional: ['gra_restaurant_licence'],
    missing: ['tin_certificate', 'owner_national_id', 'food_handler_attestation', 'gra_restaurant_licence'],
    documents: [
      { id: 'd1', docType: 'storefront_photo', status: 'PENDING', createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, reviewNote: null, addedBySwift: true },
      { id: 'd2', docType: 'gra_restaurant_licence', status: 'EXPIRED', createdAt: '2025-11-12T10:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z', reviewNote: null },
    ],
    storeOnly: ['food_handler_attestation'], personal: ['owner_national_id'] },
  items: [{ id: 'item-1', name: 'Pepperpot', category: 'Mains', imageUrl: null }],
  canAddItems: false,
  ...over,
});
const LIVE = { id: 'consent-1', agreedByName: 'Shan Persaud', agreedAs: 'MANAGER', channel: 'IN_PERSON', agreedAt: '2026-11-12T09:00:00.000Z', reference: null, recordedByAdminId: 'a1', createdAt: '2026-11-12T09:01:00.000Z', live: true };
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
    expect(paperState('gra_restaurant_licence', docs)).toEqual({ words: 'Expired', tone: 'bad', addedBySwift: false });
    const approvedPast = [{ id: 'd3', docType: 'tin_certificate', status: 'APPROVED', createdAt: '2025-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z', reviewNote: null }] as never;
    expect(paperState('tin_certificate', approvedPast, ['tin_certificate'])).toEqual({ words: 'Out of date', tone: 'bad', addedBySwift: false });
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
    await user.selectOptions(screen.getByLabelText('Who they are'), 'ACCOUNT_HOLDER');
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
      agreedByName: 'Shan Persaud', agreedAs: 'ACCOUNT_HOLDER', channel: 'WHATSAPP', reference: 'Chat 12 Nov', wordsRead: true, consentVersion: 'v1',
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
    // [#2495 review] What the store does itself has no upload; a person's own paper waits for the account holder's own OK
    // (today's OK is a manager's); an expired copy says so.
    expect(screen.getByText('The store does this itself, in the Swift app or on the website.')).toBeTruthy();
    expect(screen.queryByLabelText(/File for Food handler/i)).toBeNull();
    expect((screen.getByLabelText(/File for National ID/i) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('A person’s own paper: Swift adds it only with the account holder’s own OK.')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
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

  it('a multi-store till export: the server asks which till store, the admin picks it, and the preview runs with it', async () => {
    let calls = 0;
    const fetchMock = mockApi((request: ApiRequest) => {
      if (request.method === 'GET') return { body: { success: true, data: view([LIVE]) } };
      calls += 1;
      if (calls === 1) return { status: 422, body: { success: false, error: { code: 'CHOOSE_TILL_STORE', message: 'This file has columns for more than one till store.', details: { stores: ['Camp Street', 'Sheriff Street'] } } } };
      return { body: { success: true, data: { automap: { rowCount: 1, normalizedCsv: 'x', mapping: {}, headers: [] }, plan: { imported: 1, failedCount: 0, failures: [], notes: [], notesCount: 0, waitingForCheckCount: 0, rows: [] }, canAddItems: true } } };
    });
    const { user } = renderWithQuery(<AssistedSetupPanel vendorId="vendor-1" />);
    await user.upload(await screen.findByLabelText('Menu file'), new File(['Item,Price (Camp Street),Price (Sheriff Street)\nA,1,2'], 'till.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.selectOptions(await screen.findByLabelText('Which till store is this Swift store?'), 'Sheriff Street');
    await user.click(screen.getByRole('button', { name: 'Preview again with these choices' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(2));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'POST')[1]![1]?.body))).toMatchObject({ tillStore: 'Sheriff Street' });
  });
});
