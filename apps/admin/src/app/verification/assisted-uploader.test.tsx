import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ASSISTED SETUP · #2495 review B S4-1] A paper a Swift admin uploaded for a store is flagged. Its uploader is never asked
// to tick "no second admin available" up front: the tick is offered only when the server says they are the only admin
// (409 ASSISTED_UPLOADER_ACK_REQUIRED); with a second admin the server refuses outright, in its own words.
// ---------------------------------------------------------------------------

const ME = 'admin-me';
const doc = (assistedById: string | null) => ({
  id: 'd1', userId: 'owner-1', status: 'PENDING', docType: 'storefront_photo', role: 'VENDOR_OWNER',
  createdAt: '2026-11-12T12:00:00.000Z', consentAt: '2026-11-12T12:00:00.000Z', privacyNoticeVersion: 'assisted-v1',
  user: { id: 'owner-1', firstName: 'Assisted', lastName: 'Store', phone: 'owner-phone', countryCode: 'GY' },
  previousDecision: null, approvalHeldAt: null, approvalHeldBy: null, assistedById,
});

function serve(assistedById: string | null, approve: (_n: number, _body: Record<string, unknown>) => { status: number; body: unknown }) {
  let calls = 0;
  return mockApi((request: ApiRequest) => {
    const path = request.url.pathname;
    if (path === '/api/v1/auth/me') return { body: { success: true, data: { user: { id: ME, activeRole: 'ADMIN', roles: ['ADMIN'] } } } };
    if (path.endsWith('/queue/counts')) return { body: { data: {} } };
    if (path.includes('/users/')) return { body: { data: {} } };
    if (path.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (path.endsWith('/document-url')) return { body: { success: true, data: { url: '/api/v1/verification/render/d1?expires=1&sig=fixture' } } };
    if (path.startsWith('/api/v1/verification/render/')) return { body: { loaded: true } };
    if (path === '/api/v1/admin/verification/queue') return { body: { success: true, data: request.url.searchParams.get('status') === 'PENDING' ? [doc(assistedById)] : [] } };
    if (path.endsWith('/approve')) { calls += 1; return approve(calls, JSON.parse(String(request.init?.body ?? '{}'))); }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

async function approveOnce(user: ReturnType<typeof renderWithQuery>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Review' }));
  await user.click(screen.getByRole('button', { name: /View document/ }));
  fireEvent.load(await screen.findByAltText(/evidence/));
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await user.type(within(screen.getByRole('dialog')).getByLabelText('Decision note'), 'Checked the storefront against the address');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }));
}

describe('[ASSISTED SETUP] a paper Swift uploaded, in the Review Center', () => {
  it('flags it; the uploader is not asked to tick anything up front; a second admin existing: the refusal in the server’s words', async () => {
    const api = serve(ME, () => ({ status: 403, body: { success: false, error: { code: 'ASSISTED_UPLOADER_CANNOT_APPROVE', message: 'You uploaded this paper for the store, so another admin must approve it.' } } }));
    const { user } = renderWithQuery(<VerificationPage />);
    await approveOnce(user);
    expect(await screen.findByText(/another admin must approve it/)).toBeTruthy();
    expect(screen.getByRole('note', { name: 'Uploaded by Swift for the store' }).textContent).toContain('You uploaded this paper');
    expect(screen.queryByRole('checkbox', { name: /no second admin available/ })).toBeNull();
    const [, init] = requestsByMethod(api, 'PUT')[0]!;
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('soleAdminChecked');
  });

  it('the only admin: the server asks, the tick appears, and the approval carries it', async () => {
    const api = serve(ME, (n, body) => n === 1
      ? { status: 409, body: { success: false, error: { code: 'ASSISTED_UPLOADER_ACK_REQUIRED', message: 'There is no second admin. Tick to approve it yourself.' } } }
      : { status: 200, body: { success: true, data: { id: 'd1', status: body['soleAdminChecked'] === true ? 'APPROVED' : 'PENDING' } } });
    const { user } = renderWithQuery(<VerificationPage />);
    await approveOnce(user);
    const tick = await within(screen.getByRole('dialog')).findByRole('checkbox', { name: /no second admin available \(approval\)/ });
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(tick);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(api, 'PUT')).toHaveLength(2));
    expect(JSON.parse(String(requestsByMethod(api, 'PUT')[1]![1]?.body))).toMatchObject({ soleAdminChecked: true });
  });

  it('a paper the store sent itself: no flag', async () => {
    serve(null, () => ({ status: 200, body: { success: true, data: { status: 'APPROVED' } } }));
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByRole('heading', { level: 2, name: 'Assisted Store' });
    expect(screen.queryByRole('note', { name: 'Uploaded by Swift for the store' })).toBeNull();
  });
});
