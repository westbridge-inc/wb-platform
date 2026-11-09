import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CardPaymentsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// [CARD-READY] The weekly-fee card payments a person must decide: the provider may have taken the money and Swift could
// not book it. The page names the provider transaction and why it is held, and asks for each decision with a reason and a
// second admin. It never decides without a recorded provider transaction, and it shows no card data.

const REASON = 'Checked the card provider portal: the payment shows as approved and settled';
const held = {
  id: 'cs_1', subscriptionId: 'sub_1', userId: 'usr_1', purpose: 'PAY_NOW', status: 'HELD', provider: 'powertranz', environment: 'live', providerAccount: 'swift-main',
  amount: 2100, currencyCode: 'GYD', periodStart: '2026-11-10T04:00:00.000Z', createdAt: '2026-11-09T12:00:00.000Z',
  failureCode: 'APPROVED_UNPROVEN', providerTransactionRef: 'a1b2c3d4-0000-4000-8000-000000000001', providerVoidState: 'UNKNOWN', providerRefundState: null,
  resolution: null, resolvedAt: null,
};
const noRef = { ...held, id: 'cs_2', providerTransactionRef: null };
const paid = { ...held, id: 'cs_3', status: 'SUCCEEDED', failureCode: null, providerVoidState: null };
const queued = (): ApiReply => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_1' } } } });

function server(rows: Array<Record<string, unknown>>, write: (_r: ApiRequest) => ApiReply = queued) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/billing/card-sessions') {
      const status = r.url.searchParams.get('status');
      return { body: { success: true, data: { sessions: rows.filter((row) => !status || row['status'] === status) } } };
    }
    if (r.method === 'POST') return write(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[CARD-READY] card payments', () => {
  it('opens on the ones that need a person: the amount, the week, the provider transaction and why it is held', async () => {
    const fetchMock = server([held, paid]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText('a1b2c3d4-0000-4000-8000-000000000001')).toBeTruthy();
    expect(screen.getByText(/could not be booked/)).toBeTruthy();
    expect(screen.getByText(/Void not confirmed/)).toBeTruthy();
    expect(screen.getByText('GY$2,100')).toBeTruthy();
    const url = new URL(String(requestsByMethod(fetchMock, 'GET')[0]![0]));
    expect(url.searchParams.get('status')).toBe('HELD');
    expect(url.searchParams.get('purpose')).toBe('PAY_NOW');
    expect(['Book the week', 'Refund it', 'Refunded in the portal', 'Nothing was taken'].map((name) => !!screen.getByRole('button', { name }))).toEqual([true, true, true, true]);
  });

  it('a decision names the recorded transaction and the exact amount, needs a reason, and waits for a second admin', async () => {
    const fetchMock = server([held]);
    const { user } = renderWithQuery(<CardPaymentsPage />);
    await user.click(await screen.findByRole('button', { name: 'Refund it' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('refund the whole GY$2,100 to the card');
    expect(panel.textContent).toContain('A second admin approves it');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Refund it' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/admin/billing/card-sessions/cs_1/resolve');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'REFUND', providerReference: 'a1b2c3d4-0000-4000-8000-000000000001', amount: 2100 });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBe(REASON);
    expect(await screen.findByText(/Waiting for approval: a second admin/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book the week' })).toBeNull();
  });

  it('without a recorded provider transaction nothing can be decided here', async () => {
    server([noRef]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(/No provider transaction is recorded, so nothing can be decided here/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book the week' })).toBeNull();
  });

  it('the tabs ask the server; a paid payment offers no decision; an empty queue says so', async () => {
    server([paid]);
    const { user } = renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText('No card payment needs a person.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Paid' }));
    expect(await screen.findByText('a1b2c3d4-0000-4000-8000-000000000001')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refund it' })).toBeNull();
  });
});
