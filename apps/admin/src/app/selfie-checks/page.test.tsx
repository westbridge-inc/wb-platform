import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SelfieChecksPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [OWNER-ASKS · security review 9 Nov 2026] A business that goes to the customer took its selfie after its ID was
// approved on its own: a person compares that selfie with the approved ID before home visits book. Synthetic only.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(pending: unknown[], writes: ApiRequest[] = []) {
  mockApi((r) => {
    if (r.method === 'POST') { writes.push(r); return { body: { success: true, data: { outcome: 'MATCH' } } }; }
    if (r.url.pathname.endsWith('/selfie-checks')) return { body: { success: true, data: { pending } } };
    if (r.url.pathname.endsWith('/document-url')) return { body: { success: true, data: { url: '/api/v1/verification/render/doc-1?expires=9999999999&reviewer=rev&sig=synthetic-signature-0000', expiresInSeconds: 300, signupSelfie: { url: '/uploads/avatars/u1/selfie.jpg', capturedAt: '2026-11-09T10:05:00.000Z' }, signupSelfieExpected: true } } };
    return { body: {} };
  });
  return writes;
}

describe('[security review 9 Nov] Selfie checks', () => {
  it('nothing waiting: says so', async () => {
    fixture([]);
    renderWithQuery(<SelfieChecksPage />);
    expect(await screen.findByText(/No selfie is waiting to be checked/)).toBeTruthy();
  });

  it('the reviewer opens the ID beside the selfie, states a reason, and records the answer for that ID', async () => {
    const writes = fixture([{ userId: 'u1', documentId: 'doc-1', docType: 'owner_national_id', selfieCapturedAt: '2026-11-09T10:00:00.000Z' }]);
    const { user } = renderWithQuery(<SelfieChecksPage />);
    const same = await screen.findByRole('button', { name: 'Same person' }) as HTMLButtonElement;
    expect(same.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    await screen.findByAltText('Applicant signup selfie');
    fireEvent.change(screen.getByLabelText('Why (recorded)'), { target: { value: 'Faces match on the approved ID' } });
    expect(same.disabled).toBe(true); // the document must be seen first
    fireEvent.load(screen.getByAltText(/evidence/));
    await waitFor(() => expect(same.disabled).toBe(false));
    await user.click(same);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/verification/doc-1/selfie-check');
    // [security review 9 Nov, 2nd] the answer names the selfie the reviewer was SHOWN (document-url), not the queue's
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ match: true, selfieCapturedAt: '2026-11-09T10:05:00.000Z' });
    expect((writes[0]!.init?.headers as Record<string, string>)['x-swift-reason']).toBe('Faces match on the approved ID');
  });
});
