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
  sellerLegalNameOnApproval: { effect: 'SET', from: null, to: 'Sample Shop Inc.', docType: 'certificate_of_incorporation' },
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

  it('[review-2475 F1] names the business the change\'s papers name, and what approving does to the legal name customers see', async () => {
    serve([{ ...change, id: 'chg-2', legalName: { account: 'Sample Trading', change: 'Sample Holdings Limited' } },
      { ...change, id: 'chg-3', legalName: { account: 'Sample Trading', change: null } }]);
    renderWithQuery(<AccountChangesPage />);
    const named = await screen.findAllByLabelText('Business named on the papers');
    expect(named[0]!.textContent).toMatch(/“Sample Holdings Limited”\. Customers see it as the seller once you approve \(now: “Sample Trading”\)/);
    expect(named[1]!.textContent).toMatch(/No business name was typed from this change’s papers\. Approving removes “Sample Trading”/);
  });

  it('nothing waiting says so; a failed read is a failure, never an empty queue', async () => {
    serve([]);
    renderWithQuery(<AccountChangesPage />);
    expect(await screen.findByText('No account change is waiting.')).toBeTruthy();
  });

  // [FOLLOWUPS-2475] Before deciding, the reviewer reads what approval does to the seller legal name: the server's own
  // effect (kept / set from the change's paper / cleared), only put in words here.
  const legalNameNote = async () => (await screen.findByRole('note', { name: 'Seller legal name on approval' })).textContent;

  it('set: names the change’s own paper and the name a person typed from it; replacing an old name says both', async () => {
    serve([{ ...change, sellerLegalNameOnApproval: { effect: 'SET', from: 'Sample Trading', to: 'Sample Shop Inc.', docType: 'certificate_of_incorporation' } }]);
    renderWithQuery(<AccountChangesPage />);
    expect(await legalNameNote()).toContain('Approval replaces “Sample Trading” with “Sample Shop Inc.”, as a person typed it from this change’s Certificate of Incorporation (company).');
  });

  it('cleared: says the old name goes and customers see “Ask the store” until a person confirms one (here, by the ticks below)', async () => {
    serve([{ ...change, sellerLegalNameOnApproval: { effect: 'CLEARED', from: 'Sample Owner', to: null, docType: null } }]);
    renderWithQuery(<AccountChangesPage />);
    const note = await legalNameNote();
    expect(note).toContain('Approval clears “Sample Owner”: it was typed for the old business type');
    expect(note).toContain('Customers then see “Ask the store” as the seller until a person confirms a name (ticking each store’s name below does that).');
  });

  it('cleared on a handover: typed for the old holder’s papers; no store-name ticks to point at', async () => {
    serve([{ ...change, kind: 'HOLDER_HANDOVER', fromOption: null, toOption: null, accepted: true, accountBasis: 'COMPANY', newHolder: { id: 'u2', name: 'Next Holder' },
      sellerLegalNameOnApproval: { effect: 'CLEARED', from: 'Sample Shop Inc.', to: null, docType: null } }]);
    renderWithQuery(<AccountChangesPage />);
    const note = await legalNameNote();
    expect(note).toContain('it was typed for the old account holder’s papers');
    expect(note).toContain('until a person confirms a name.');
    expect(note).not.toContain('ticking');
  });

  it('kept with no name: says there is none and approval sets none', async () => {
    serve([{ ...change, sellerLegalNameOnApproval: { effect: 'KEPT', from: null, to: null, docType: null } }]);
    renderWithQuery(<AccountChangesPage />);
    expect(await legalNameNote()).toContain('There is none now, and approval sets none.');
  });

  it('kept with a name: says approval keeps it', async () => {
    serve([{ ...change, sellerLegalNameOnApproval: { effect: 'KEPT', from: 'Sample Shop Inc.', to: 'Sample Shop Inc.', docType: null } }]);
    renderWithQuery(<AccountChangesPage />);
    expect(await legalNameNote()).toContain('Approval keeps “Sample Shop Inc.”.');
  });

  it('no preview from the server (a decided change): no line, never a guess', async () => {
    serve([{ ...change, sellerLegalNameOnApproval: null }]);
    renderWithQuery(<AccountChangesPage />);
    expect(await screen.findByText(/a registered company$/)).toBeTruthy();
    expect(screen.queryByRole('note', { name: 'Seller legal name on approval' })).toBeNull();
  });

  // [review-2475 delta S4-2] The console never promises a seller name the server declines to confirm: the server says
  // which store names are a person's (a flag, never computed here), and the approval's answer says which were not
  // confirmed and why.
  it('a store whose name is a person’s: the tick says approval does not confirm it, and customers see “Ask the store”', async () => {
    serve([{ ...change, stores: [{ ...change.stores[0], name: 'Sample Owner', nameIsAPerson: true }, { id: 'vnd-2', name: 'Sample Shop East', vendorType: 'STORE', status: 'ACTIVE', sellerNameCheckedName: null, nameIsAPerson: false }] }]);
    renderWithQuery(<AccountChangesPage />);
    const person = await screen.findByRole('checkbox', { name: /“Sample Owner” is a person’s name/ });
    expect(person.closest('label')!.textContent).toContain('approval does not confirm it as the seller’s name; customers see “Ask the store” until the legal name is typed from the registration paper');
    expect(screen.queryByRole('checkbox', { name: /“Sample Owner” is the business’s name/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /“Sample Shop East” is the business’s name on its papers/ })).toBeTruthy();
  });

  it('a held legal name that is a person’s: neither line promises customers will see it', async () => {
    serve([{ ...change, legalName: { account: 'Sample Trading', change: 'Devon Director' },
      sellerLegalNameOnApproval: { effect: 'CLEARED', from: 'Sample Trading', to: null, docType: null, heldNameIsAPerson: true } }]);
    renderWithQuery(<AccountChangesPage />);
    const note = await legalNameNote();
    expect(note).toContain('The name typed from this change’s registration paper is a person’s name, so approval does not use it.');
    expect(note).toContain('Approval clears “Sample Trading”');
    expect(note).not.toContain('nobody typed');
    const named = screen.getByLabelText('Business named on the papers').textContent;
    expect(named).not.toContain('Customers see it as the seller once you approve');
    expect(named).toContain('is a person’s name, so customers will not see it as the seller');
  });

  it('after approval: the answer’s unconfirmed stores are listed by name with the server’s reason', async () => {
    const writes: ApiRequest[] = [];
    let decided = false;
    mockApi((r) => {
      if (r.method === 'GET') return { body: { success: true, data: decided ? [] : [{ ...change, stores: [{ ...change.stores[0], name: 'Sample Owner', nameIsAPerson: true }] }] } };
      writes.push(r); decided = true;
      return { body: { success: true, data: { ...change, status: 'APPROVED', sellerLegalNameOnApproval: null,
        sellerNamesNotConfirmed: { storeIds: ['vnd-1'], code: 'SELLER_NAME_IS_A_PERSON', message: 'The store’s name is a person’s name (server words).' },
        sellerLegalNameNotUsed: { code: 'LEGAL_NAME_IS_A_PERSON', message: 'The legal name is a person’s name (server words).' } } } };
    });
    const user = userEvent.setup();
    renderWithQuery(<AccountChangesPage />);
    await user.click(await screen.findByRole('checkbox', { name: /“Sample Owner” is a person’s name/ }));
    await user.type(screen.getByRole('textbox'), REASON);
    await user.click(screen.getByRole('button', { name: 'Approve the change' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    const said = await screen.findByRole('status', { name: 'What the approval did not confirm' });
    expect(said.textContent).toContain('Seller name not confirmed for Sample Owner: The store’s name is a person’s name (server words).');
    expect(said.textContent).toContain('Seller legal name not set: The legal name is a person’s name (server words).');
  });
});
