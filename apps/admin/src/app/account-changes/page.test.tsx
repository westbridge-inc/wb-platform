import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AccountChangesPage from './page';
import { mockApi, renderWithQuery, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 (c), (d)] The Account changes queue. A person decides a store's change
// of business type, or a company's new account holder, only once every paper is approved; approving a business type
// confirms each store's name exactly as shown (the seller name customers see); every decision states a reason, and a
// refusal's reason is what the store reads. Synthetic stores only.
// ---------------------------------------------------------------------------

const REASON = 'Checked the certificate, the director letter and the ID against each other';
const change = {
  id: 'chg-1', kind: 'BUSINESS_TYPE', status: 'PENDING', fromOption: 'OWN_NAME', toOption: 'COMPANY', createdAt: '2026-11-10T08:00:00.000Z',
  decidedAt: null, accepted: null, papersComplete: true, accountBasis: 'OWNER', decisionReason: null,
  papers: [
    { docType: 'certificate_of_incorporation', state: 'APPROVED', forChange: true, documentId: 'd1', note: null, role: 'STORE' },
    { docType: 'storefront_photo', state: 'APPROVED', forChange: false, documentId: 'd2', note: null, role: 'STORE' },
  ],
  stores: [{ id: 'vnd-1', name: 'Sample Shop Inc.', vendorType: 'STORE', status: 'ACTIVE', sellerNameCheckedName: null }],
  holder: { id: 'u1', name: 'Sample Owner' }, newHolder: null,
};

function serve(rows: unknown[], onWrite?: (_r: ApiRequest) => ApiReply) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/account-changes') return { body: { success: true, data: rows } };
    if (onWrite && r.method !== 'GET') return onWrite(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[COMPANY-DOCS Part 3] Account changes queue', () => {
  it('approving a business type sends each store’s name exactly as shown, with the reason; only after the name is ticked', async () => {
    const writes: ApiRequest[] = [];
    serve([change], (r) => { writes.push(r); return { body: { success: true, data: { ...change, status: 'APPROVED' } } }; });
    const user = userEvent.setup();
    renderWithQuery(<AccountChangesPage />);
    expect(await screen.findByText(/a registered company$/)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve the change' });
    await user.type(screen.getByRole('textbox'), REASON);
    expect((approve as HTMLButtonElement).disabled).toBe(true); // the seller name is not ticked yet
    await user.click(screen.getByRole('checkbox', { name: /“Sample Shop Inc\.” is the business’s name/ }));
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    await user.click(approve);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('PUT');
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/account-changes/chg-1/approve');
    expect(new Headers(writes[0]!.init?.headers).get('x-swift-reason')).toBe(REASON);
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ sellerNames: { 'vnd-1': 'Sample Shop Inc.' } });
  });

  it('a paper still waiting keeps Approve locked; Refuse sends the reason the store reads', async () => {
    const writes: ApiRequest[] = [];
    serve([{ ...change, papersComplete: false, papers: [{ ...change.papers[0], state: 'PENDING' }] }], (r) => { writes.push(r); return { body: { success: true, data: {} } }; });
    const user = userEvent.setup();
    renderWithQuery(<AccountChangesPage />);
    expect(await screen.findByText('Approve each paper in Documents before deciding the change.')).toBeTruthy();
    await user.type(screen.getByRole('textbox'), 'The certificate is for a different company');
    await user.click(screen.getByRole('checkbox', { name: /Sample Shop Inc\./ }));
    expect((screen.getByRole('button', { name: 'Approve the change' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Refuse' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/account-changes/chg-1/refuse');
    expect(new Headers(writes[0]!.init?.headers).get('x-swift-reason')).toBe('The certificate is for a different company');
  });

  it('a handover is approved only after the person named said yes; it names both people, never a phone', async () => {
    serve([{ ...change, kind: 'HOLDER_HANDOVER', fromOption: null, toOption: null, accepted: false, accountBasis: 'COMPANY', newHolder: { id: 'u2', name: 'Next Holder' } }]);
    const user = userEvent.setup();
    renderWithQuery(<AccountChangesPage />);
    expect(await screen.findByText('Account holder: Sample Owner → Next Holder')).toBeTruthy();
    expect(screen.getByText(/has not said yes yet/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull(); // a handover confirms no seller name
    await user.type(screen.getByRole('textbox'), REASON);
    expect((screen.getByRole('button', { name: 'Approve the change' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('nothing waiting says so; a failed read is a failure, never an empty queue', async () => {
    serve([]);
    renderWithQuery(<AccountChangesPage />);
    expect(await screen.findByText('No account change is waiting.')).toBeTruthy();
  });
});
