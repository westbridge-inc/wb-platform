import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VerificationPage from './page';
import { DocumentViewer } from '@/components/verification/DocumentViewer';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

function fixture(docType: string, reviewerTypes: string[], extra: Record<string, unknown> = {}) {
  return mockApi((r) => {
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/queue')) return { body: { data: [{ id: 'synthetic-doc', userId: 'synthetic-user', docType, reviewerTypes,
      role: 'MOVER', status: 'PENDING', user: { id: 'synthetic-user', firstName: 'Synthetic', lastName: 'Applicant' }, ...extra }], meta: { hasNext: false } } };
    if (r.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (r.url.pathname.endsWith('/document-url')) return { body: { data: { url: '/api/v1/verification/render/synthetic-doc?sig=fixture&expires=1' } } };
    if (r.url.pathname.includes('/verification/render/')) return { body: {} };
    if (r.method === 'PUT') return { body: { data: { status: 'APPROVED' } } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
}

describe('reviewer fields required by the approval route', () => {
  // [COMPANY-DOCS · owner 10 Nov 2026] a company's or a manager's account holder's ID is checked exactly as an owner's
  it.each(['national_id', 'owner_national_id', 'passport', 'drivers_licence', 'account_holder_id'])('%s sends the number the reviewer read', async (docType) => {
    const fetch = fixture(docType, ['documentNumber']);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Document number'), 'SYNTH-1234');
    if (docType === 'drivers_licence') fireEvent.change(screen.getByLabelText('Expiry printed on the document'), { target: { value: '2028-01-01' } });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toMatchObject({ documentNumber: 'SYNTH-1234' });
  });

  // [COMPANY-DOCS · owner 10 Nov 2026] The reviewer is told which path a store account signed up on, and what to check.
  it('a company’s account holder’s ID names the path and the check, and is never called the owner’s ID', async () => {
    fixture('account_holder_id', ['documentNumber'], { role: 'VENDOR_OWNER', accountBasis: 'COMPANY' });
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/Signed up as a registered company/)).toBeTruthy();
    expect(screen.getByText(/The ID of the one person who manages this Swift account/)).toBeTruthy();
    expect(screen.getAllByText('Account holder’s ID (company or manager)').length).toBeGreaterThan(0);
  });

  it('a manager’s owner letter names the manager path and the owner check', async () => {
    fixture('owner_authority_letter', [], { role: 'VENDOR_OWNER', accountBasis: 'MANAGER' });
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/Signed up by the manager of a registered business \(not the owner\)/)).toBeTruthy();
    expect(screen.getByText(/owner named on the Business Registration/)).toBeTruthy();
  });

  it('an owner’s account shows no path line', async () => {
    fixture('owner_national_id', ['documentNumber'], { role: 'VENDOR_OWNER', accountBasis: 'OWNER' });
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findAllByText('National ID');
    expect(screen.queryByText(/Signed up as a registered company|Signed up by the manager/)).toBeNull();
  });

  // [Rule 11 Oct 2026: no ID-number duplicate check at launch] The server asks nothing typed for a customer's ID.
  it('a customer ID (nothing asked by the server) shows no number field and sends no number', async () => {
    const fetch = fixture('identity_l2', []);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    expect(screen.queryByLabelText('Document number')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body ?? '{}'))).not.toHaveProperty('documentNumber');
  });

  it('police clearance asks for its issue date rather than an invented expiry', async () => {
    const fetch = fixture('police_clearance', ['issuedOn']);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    expect(screen.queryByLabelText('Expiry printed on the document')).toBeNull();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Issue date printed on the document'), { target: { value: '2026-09-01' } });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ issuedOn: '2026-09-01T00:00:00.000Z' });
  });
});

// [R15 · research A9/D9] A licence or food certificate checked every January: the console asks for the
// YEAR printed on it — never a printed or invented expiry — and sends only that; the server sets the date.
describe('[R15] certificate-year documents', () => {
  it.each(['food_handler_cert', 'gei_electrical_licence', 'pest_control_operator_licence', 'eating_house_registration'])('%s asks for the certificate year and sends it', async (docType) => {
    const fetch = fixture(docType, ['certificateYear']);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    expect(screen.queryByLabelText('Expiry printed on the document')).toBeNull();
    const approve = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    const year = new Date().getFullYear();
    // a year that has not started, a long-gone one, or not a year at all keeps Approve locked
    for (const typed of [String(year + 1), String(year - 2), '20', 'abcd']) {
      fireEvent.change(screen.getByLabelText('Year printed on the certificate'), { target: { value: typed } });
      expect(approve().disabled, typed).toBe(true);
    }
    fireEvent.change(screen.getByLabelText('Year printed on the certificate'), { target: { value: String(year) } });
    expect(approve().disabled).toBe(false);
    await user.click(approve());
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ certificateYear: year });
  });
});

// [R16 · research D7] A business registration: the reviewer says what it is; a yearly business name also
// carries its year (checked every January); a company's incorporation certificate never expires.
describe('[R16] business registration kind', () => {
  async function open(docType = 'business_registration') {
    // [R3 · review F1] the server also asks for the legal name printed on the paper
    const fetch = fixture(docType, ['registrationKind', 'certificateYear', 'legalName']);
    const rendered = renderWithQuery(<VerificationPage />);
    await rendered.user.click(await screen.findByRole('button', { name: 'Review' }));
    await rendered.user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    return { fetch, user: rendered.user };
  }
  const approve = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;

  it('a company sends its kind and the legal name typed from it (no year, no date)', async () => {
    const { fetch, user } = await open();
    expect(approve().disabled).toBe(true);
    expect(screen.queryByLabelText('Year printed on the certificate')).toBeNull();
    await user.selectOptions(screen.getByLabelText('What this certificate is'), 'COMPANY');
    expect(screen.queryByLabelText('Year printed on the certificate')).toBeNull();
    // [R3 · review F1] not without the legal name printed on it: customers see it as the seller
    expect(approve().disabled).toBe(true);
    // [review-2476 F2] the words never read as allowing a person's name for the seller
    const hint = screen.getByLabelText('Registered name, exactly as printed').closest('label')!.textContent ?? '';
    expect(hint).toContain('Never the proprietor’s, a director’s or the account holder’s personal name.');
    expect(hint).not.toMatch(/unless/i);
    await user.type(screen.getByLabelText('Registered name, exactly as printed'), '  Sample Holdings Limited ');
    expect(approve().disabled).toBe(false);
    await user.click(approve());
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ registrationKind: 'COMPANY', legalName: 'Sample Holdings Limited' });
  });

  it('a business name needs this year typed, and sends its kind and year', async () => {
    const { fetch, user } = await open();
    await user.selectOptions(screen.getByLabelText('What this certificate is'), 'BUSINESS_NAME');
    expect(approve().disabled).toBe(true);
    const year = new Date().getFullYear();
    fireEvent.change(screen.getByLabelText('Year printed on the certificate'), { target: { value: String(year - 2) } });
    expect(approve().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Year printed on the certificate'), { target: { value: String(year) } });
    expect(approve().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Registered name, exactly as printed'), { target: { value: 'Sample Traders' } });
    expect(approve().disabled).toBe(false);
    await user.click(approve());
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ registrationKind: 'BUSINESS_NAME', certificateYear: year, legalName: 'Sample Traders' });
  });

  // [COMPANY-DOCS · review F3] a company's paper that is a business-name registration: the proprietor must be a company
  it('a company’s business-name registration waits for the “proprietor is a company” tick, and sends it', async () => {
    const { fetch, user } = await open('certificate_of_incorporation');
    await user.selectOptions(screen.getByLabelText('What this certificate is'), 'BUSINESS_NAME');
    const year = new Date().getFullYear();
    fireEvent.change(screen.getByLabelText('Year printed on the certificate'), { target: { value: String(year) } });
    // [R3 · review F1] the registered name printed on it is typed too: the tick is then the last thing approval waits for
    fireEvent.change(screen.getByLabelText('Registered name, exactly as printed'), { target: { value: 'Sample Holdings Limited' } });
    expect(approve().disabled).toBe(true);
    await user.click(screen.getByLabelText('The proprietor named on it is a company'));
    expect(approve().disabled).toBe(false);
    await user.click(approve());
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ registrationKind: 'BUSINESS_NAME', certificateYear: year, legalName: 'Sample Holdings Limited', proprietorIsCompany: true });
  });

  it('a company certificate, or an owner’s business registration, is never asked about its proprietor', async () => {
    const company = await open('certificate_of_incorporation');
    await company.user.selectOptions(screen.getByLabelText('What this certificate is'), 'COMPANY');
    expect(screen.queryByLabelText('The proprietor named on it is a company')).toBeNull();
  });

  it('an owner’s business registration as a business name: no proprietor tick', async () => {
    const owner = await open('business_registration');
    await owner.user.selectOptions(screen.getByLabelText('What this certificate is'), 'BUSINESS_NAME');
    expect(screen.queryByLabelText('The proprietor named on it is a company')).toBeNull();
  });
});

// [ROLE-DOCS · owner 21 Oct 2026] An own-name declaration: approved only on the reviewer's own check of the store name
// against the owner's ID (Business Names (Registration) Act s.3); the server refuses it otherwise.
describe('[ROLE-DOCS] own-name declaration', () => {
  it('approval waits for the reviewer\'s tick, and sends it', async () => {
    const fetch = fixture('own_name_declaration', ['ownNameConfirmed']);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    const approve = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    await user.click(screen.getByLabelText('Own name checked against the ID'));
    expect(approve().disabled).toBe(false);
    await user.click(approve());
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ ownNameConfirmed: true });
  });
});

describe('PDF approval requires confirmed inline evidence', () => {
  const settings = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings;
  let previous: boolean;
  beforeEach(() => { previous = settings.disableIframePageLoading; settings.disableIframePageLoading = true; });
  afterEach(() => { settings.disableIframePageLoading = previous; });
  it('a previous PDF frame cannot confirm a replacement view', async () => {
    const fetch = vi.fn(async (url: string) => url.includes('/document-url')
      ? new Response(JSON.stringify({ data: { url: '/api/v1/verification/render/synthetic-doc?sig=fixture&expires=1' } }), { headers: { 'content-type': 'application/json' } })
      : new Response('pdf', { headers: { 'content-type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetch);
    const { user } = renderWithQuery(<DocumentViewer id="synthetic-doc" label="Document" onViewed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'View document' }));
    const oldFrame = await screen.findByTitle('Document evidence') as HTMLIFrameElement;
    const oldLoad = oldFrame.onload;
    await user.click(screen.getByRole('button', { name: 'View document' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    act(() => { oldLoad?.call(oldFrame, new Event('load')); });
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });
  it.each([false, true])('only an inline load followed by confirmation unlocks the PDF (failed=%s)', async (failed) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/document-url')
      ? new Response(JSON.stringify({ data: { url: '/api/v1/verification/render/synthetic-doc?sig=fixture&expires=1' } }), { headers: { 'content-type': 'application/json' } })
      : new Response('pdf', { headers: { 'content-type': 'application/pdf' } })));
    const viewed = vi.fn();
    const { user } = renderWithQuery(<DocumentViewer id="synthetic-doc" label="Document" onViewed={viewed} />);
    await user.click(screen.getByRole('button', { name: 'View document' }));
    const frame = await screen.findByTitle('Document evidence');
    const check = screen.getByRole('checkbox') as HTMLInputElement;
    expect(check.disabled).toBe(true);
    expect(viewed).not.toHaveBeenCalledWith(true);
    if (failed) {
      fireEvent.error(frame);
      await user.click(screen.getByRole('link', { name: 'Open document in a new tab' }));
      expect(check.disabled).toBe(true);
      expect(viewed).not.toHaveBeenCalledWith(true);
    } else {
      fireEvent.load(frame);
      expect(check.disabled).toBe(false);
      expect(viewed).not.toHaveBeenCalledWith(true);
      await user.click(check);
      expect(viewed).toHaveBeenLastCalledWith(true);
    }
  });
});
