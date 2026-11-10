import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { AuthorityLetterEsign } from './authority-letter-esign';

// [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] Under the letter of authority on the website's Documents page: the
// account holder asks a director (or the owner) to sign in Swift: a short form, then where it stands, with resend and
// cancel. The paper upload stays beside it. Synthetic names and numbers only.

type Req = { method: string; path: string; body: unknown };
const SENT = {
  id: 'req1', docType: 'company_authority_letter', status: 'SENT', signerKind: 'director', signerFirstName: 'Devon', signerPhoneEnding: '123',
  expiresAt: '2026-11-13T15:00:00.000Z', lastSentAt: '2026-11-10T15:00:00.000Z', resendsLeft: 3, resendAt: null, signedAt: null,
};

function api(request: unknown, onWrite: (_r: Req) => { status?: number; body: unknown } = () => ({ status: 201, body: { success: true, data: { request: SENT } } }), enabled = true) {
  const seen: Req[] = [];
  mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (method === 'GET' && path === '/vendor/authority-letters') return { body: { success: true, data: { enabled, accountBasis: 'COMPANY', request } } };
    const r = { method, path, body: init?.body ? JSON.parse(String(init.body)) : null };
    seen.push(r);
    return onWrite(r);
  });
  return seen;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('[COMPANY-DOCS PART 2] ask a director to sign in Swift', () => {
  it('the form sends exactly the server’s body, with the number as +592 and the store selected', async () => {
    const writes = api(null);
    const user = userEvent.setup();
    renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" onSigned={() => undefined} />);
    expect(await screen.findByText('Ask a director to sign in Swift')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send the letter to sign' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(screen.getByLabelText('Company name (as on the Certificate of Incorporation)'), 'Kariba Fried Chicken Ltd.');
    await user.type(screen.getByLabelText('Company registration number'), 'C-12345');
    await user.type(screen.getByLabelText('Your full name'), 'Asha Ramdin');
    await user.type(screen.getByLabelText('Your position in the company'), 'Operations Manager');
    await user.type(screen.getByLabelText('The director’s full name'), 'Devon Persaud');
    await user.type(screen.getByLabelText('The director’s mobile number'), '060-0123');
    expect(send.disabled).toBe(false);
    await user.click(send);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ method: 'POST', path: '/vendor/authority-letters', body: {
      businessName: 'Kariba Fried Chicken Ltd.', registrationNumber: 'C-12345', requesterName: 'Asha Ramdin', requesterRole: 'Operations Manager',
      signerName: 'Devon Persaud', signerPhone: '+5920600123',
    } });
    // the paper letter stays offered
    expect(screen.getByText('Prefer paper? Upload a signed letter instead.')).toBeTruthy();
  });

  it('the director is someone else: the same name as yours is refused before anything is sent', async () => {
    const writes = api(null);
    const user = userEvent.setup();
    renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" onSigned={() => undefined} />);
    await user.type(await screen.findByLabelText('Your full name'), 'Asha Ramdin');
    await user.type(screen.getByLabelText('The director’s full name'), 'asha ramdin');
    await user.tab();
    expect(await screen.findByText('The director is someone else. If you are a director, upload the company’s list of directors instead.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send the letter to sign' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it('the server’s refusal is shown in its own words (a number on the team)', async () => {
    api(null, () => ({ status: 400, body: { success: false, error: { code: 'SIGNER_PHONE_ON_TEAM', message: 'That number belongs to someone on your store’s team. The director signs on their own phone: enter the director’s own number.' } } }));
    const user = userEvent.setup();
    renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" onSigned={() => undefined} />);
    for (const [label, value] of [['Company name (as on the Certificate of Incorporation)', 'Kariba Ltd.'], ['Company registration number', '1'], ['Your full name', 'Asha Ramdin'], ['Your position in the company', 'Manager'], ['The director’s full name', 'Devon Persaud'], ['The director’s mobile number', '0600123']] as const) {
      await user.type(await screen.findByLabelText(label), value);
    }
    await user.click(screen.getByRole('button', { name: 'Send the letter to sign' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That number belongs to someone on your store’s team.');
  });

  it('waiting: “Waiting for Devon to sign”, resend and cancel act on that request', async () => {
    const writes = api(SENT, (r) => ({ body: { success: true, data: { request: r.path.endsWith('/cancel') ? { ...SENT, status: 'CANCELLED' } : SENT } } }));
    const user = userEvent.setup();
    renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" onSigned={() => undefined} />);
    expect(await screen.findByText('Waiting for Devon to sign. We texted the link to the number ending 123. It works for 72 hours.')).toBeTruthy();
    expect(screen.queryByLabelText('Your full name')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send the link again' }));
    await user.click(screen.getByRole('button', { name: 'Cancel and change the details' }));
    await waitFor(() => expect(writes.map((w) => w.path)).toEqual(['/vendor/authority-letters/req1/resend', '/vendor/authority-letters/req1/cancel']));
  });

  it('signed: the checklist is told once, and a letter a person did not accept offers the form again', async () => {
    api({ ...SENT, status: 'SIGNED', signedAt: '2026-11-11T13:00:00.000Z' });
    const onSigned = vi.fn();
    const view = renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" onSigned={onSigned} />);
    expect(await screen.findByText('Devon signed the letter. A person at Swift is checking it.')).toBeTruthy();
    await waitFor(() => expect(onSigned).toHaveBeenCalledTimes(1));
    view.unmount();
    api({ ...SENT, status: 'SIGNED', signedAt: '2026-11-11T13:00:00.000Z' });
    renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" docRejected onSigned={() => undefined} />);
    expect(await screen.findByLabelText('Your full name')).toBeTruthy();
  });

  it('switched off (until the owner approves the privacy wording): no form, only the paper letter; a request already sent still shows', async () => {
    api(null, undefined, false);
    const view = renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" onSigned={() => undefined} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Ask a director to sign in Swift')).toBeNull();
    view.unmount();
    api(SENT, undefined, false);
    renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="company_authority_letter" kind="director" onSigned={() => undefined} />);
    expect(await screen.findByText('Waiting for Devon to sign. We texted the link to the number ending 123. It works for 72 hours.')).toBeTruthy();
  });

  it('a manager asks the owner, in the owner’s words', async () => {
    api(null);
    renderWithQuery(<AuthorityLetterEsign storeId="shop" docType="owner_authority_letter" kind="owner" onSigned={() => undefined} />);
    expect(await screen.findByText('Ask the owner to sign in Swift')).toBeTruthy();
    expect(screen.getByLabelText('Business name (as on the Business Registration)')).toBeTruthy();
    expect(screen.getByLabelText('The owner’s mobile number')).toBeTruthy();
  });
});
