import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [COMPANY-DOCS PART 2 · review F2] A letter of authority (paper or signed in Swift) is never approved on the signature
// alone: the reviewer confirms the signer is a director (or the owner) themselves, says how, and what they checked.
function fixture(docType: string) {
  return mockApi((r) => {
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/queue')) return { body: { data: [{ id: 'synthetic-doc', userId: 'synthetic-user', docType, reviewerTypes: ['authorityConfirmed'],
      role: 'RESTAURANT', status: 'PENDING', accountBasis: docType === 'owner_authority_letter' ? 'MANAGER' : 'COMPANY',
      user: { id: 'synthetic-user', firstName: 'Synthetic', lastName: 'Applicant' } }], meta: { hasNext: false } } };
    if (r.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (r.url.pathname.endsWith('/document-url')) return { body: { data: { url: '/api/v1/verification/render/synthetic-doc?sig=fixture&expires=1' } } };
    if (r.url.pathname.includes('/verification/render/')) return { body: {} };
    if (r.method === 'PUT') return { body: { data: { status: 'APPROVED' } } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
}

describe('[review F2] the signer of a letter of authority is confirmed by a person', () => {
  it('approval waits for HOW the signer was confirmed and WHAT was checked, says a signature in Swift is not proof, and sends both', async () => {
    const fetch = fixture('company_authority_letter');
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    const approve = () => screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    expect(screen.getByText(/A letter signed in Swift has no letterhead \(that is expected\)/)).toBeTruthy();
    expect(screen.getByText(/a listing proves a name, not who signed/)).toBeTruthy();
    await user.click(screen.getByLabelText(/I called the company on a number Swift found itself \(not one on the letter or the form\), and the company confirmed it authorised this account holder/));
    expect(approve().disabled).toBe(true); // a method alone is not enough
    await user.type(screen.getByLabelText('What you checked to confirm the signer'), 'short');
    expect(approve().disabled).toBe(true);
    await user.type(screen.getByLabelText('What you checked to confirm the signer'), ': called the number on its website; HR confirmed');
    expect(approve().disabled).toBe(false);
    await user.click(approve());
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({
      authorityConfirmed: { method: 'CALLED_ON_FOUND_NUMBER', reason: 'short: called the number on its website; HR confirmed' },
    });
  });

  it('a company’s listing counts only when it names the account holder themself, never for a letter signed in Swift', async () => {
    fixture('company_authority_letter');
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByLabelText(/names the account holder themself as a director: no one else signed\. Never for a letter signed in Swift\./)).toBeTruthy();
  });

  it('a manager’s letter: only a call on a number Swift found itself (a registration cannot prove who signed)', async () => {
    fixture('owner_authority_letter');
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(screen.getByLabelText(/I called the business on a number Swift found itself \(not one on the letter or the form\), and its owner confirmed they authorised this manager/)).toBeTruthy();
    expect(screen.queryByLabelText(/Business Registration/)).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });
});
