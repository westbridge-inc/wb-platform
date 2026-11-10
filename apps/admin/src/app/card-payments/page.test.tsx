import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CardPaymentsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// [CARD-READY] The weekly-fee card payments a person must decide: the provider may have taken the money and Swift could
// not book it. The page names the provider transaction, the order reference and why it is held, and asks for each
// decision with what the person read in the provider's portal, a reason and a second admin. It never fills in what the
// person checked, never decides without a recorded provider transaction, and it shows no card data.

const REASON = 'Checked the card provider portal: the payment shows as approved and settled';
const TXN = 'a1b2c3d4-0000-4000-8000-000000000001';
const held = {
  id: 'cs_1', subscriptionId: 'sub_1', userId: 'usr_1', purpose: 'PAY_NOW', status: 'HELD', provider: 'powertranz', environment: 'live', providerAccount: 'swift-main',
  amount: 2100, currencyCode: 'GYD', periodStart: '2026-11-10T04:00:00.000Z', createdAt: '2026-11-09T12:00:00.000Z',
  failureCode: 'APPROVED_UNPROVEN', providerTransactionRef: TXN, providerVoidState: 'UNKNOWN', providerRefundState: null,
  resolution: null, resolvedAt: null,
};
const noRef = { ...held, id: 'cs_2', providerTransactionRef: null };
const paid = { ...held, id: 'cs_3', status: 'SUCCEEDED', failureCode: null, providerVoidState: null };
const queued = (): ApiReply => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_1' } } } });

type Row = Record<string, unknown>;
/** The list route: filtered by status and subscription; `pages` maps a `before` cursor (or '' for the first page) to rows and `next`. */
function server(rows: Row[], write: (_r: ApiRequest) => ApiReply = queued, pages?: Record<string, { rows: Row[]; next: string | null }>) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/billing/card-sessions') {
      if (pages) {
        const page = pages[r.url.searchParams.get('before') ?? ''];
        if (!page) throw new Error(`No such page: ${r.url}`);
        return { body: { success: true, data: { sessions: page.rows, next: page.next } } };
      }
      const status = r.url.searchParams.get('status');
      const sub = r.url.searchParams.get('subscriptionId');
      return { body: { success: true, data: { sessions: rows.filter((row) => (!status || row['status'] === status) && (!sub || row['subscriptionId'] === sub)), next: null } } };
    }
    if (r.method === 'POST') return write(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

const bodyOf = (fetchMock: ReturnType<typeof server>, i = 0) => JSON.parse(String(requestsByMethod(fetchMock, 'POST')[i]![1]?.body)) as Record<string, unknown>;

describe('[CARD-READY] card payments', () => {
  it('opens on the ones that need a person: the amount, the week, the provider transaction, the order reference and why it is held', async () => {
    const fetchMock = server([held, paid]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(TXN)).toBeTruthy();
    // [REVIEW-2 F3] The OrderIdentifier Swift sends: what the provider's Merchant Portal and reports look a payment up by.
    expect(screen.getByText('SWIFT-cs_1')).toBeTruthy();
    expect(screen.getByText(/could not be booked/)).toBeTruthy();
    expect(screen.getByText(/Void not confirmed/)).toBeTruthy();
    expect(screen.getByText('GY$2,100')).toBeTruthy();
    const url = new URL(String(requestsByMethod(fetchMock, 'GET')[0]![0]));
    expect(url.searchParams.get('status')).toBe('HELD');
    expect(url.searchParams.get('purpose')).toBe('PAY_NOW');
    expect(url.searchParams.has('before')).toBe(false);
    // [REVIEW-2 F1] No "refunded in the portal" decision: the provider's guide documents only the API refund.
    expect(['Book the week', 'Refund it', 'Nothing was taken'].map((name) => !!screen.getByRole('button', { name }))).toEqual([true, true, true]);
    expect(screen.queryByRole('button', { name: /portal/i })).toBeNull();
    // A refund recorded later on the Subscriptions page is not on this page: the opening text says so.
    expect(screen.getByText(/refund recorded later on the Subscriptions page is not shown here/)).toBeTruthy();
  });

  it('[R1-5] a refund asks for the transaction and the amount as the portal shows them, never fills them in, and sends what was typed', async () => {
    const fetchMock = server([held], () => ({ status: 409, body: { success: false, error: { code: 'PROVIDER_REFERENCE_MISMATCH', message: 'That is not the transaction recorded for this card payment.' } } }));
    const { user } = renderWithQuery(<CardPaymentsPage />);
    await user.click(await screen.findByRole('button', { name: 'Refund it' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('refund the whole GY$2,100 to the card, never a part of it');
    expect(panel.textContent).toContain('If the portal shows any other amount, do not refund: escalate to the owner.');
    // [REVIEW-2 round 3 advisory] The currency is checked too, not only the figure.
    expect(panel.textContent).toContain('Check the portal shows the currency GYD.');
    expect(panel.textContent).toContain('A second admin approves it');
    // Swift's own record, read-only for comparison.
    expect(within(panel).getByText(TXN)).toBeTruthy();
    expect(within(panel).getByText('SWIFT-cs_1')).toBeTruthy();
    const txn = within(panel).getByRole('textbox', { name: /Transaction reference/ }) as HTMLInputElement;
    const amount = within(panel).getByRole('textbox', { name: /Amount taken/ }) as HTMLInputElement;
    expect([txn.value, amount.value]).toEqual(['', '']);
    // Only a reason: nothing is sent.
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Refund it' }));
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    // What the person typed is what is sent; the server checks it against its record.
    await user.type(txn, 'b9b9b9b9-0000-4000-8000-000000000009');
    await user.type(amount, '2100');
    await user.click(within(panel).getByRole('button', { name: 'Refund it' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/admin/billing/card-sessions/cs_1/resolve');
    expect(bodyOf(fetchMock)).toEqual({ action: 'REFUND', providerReference: 'b9b9b9b9-0000-4000-8000-000000000009', amount: 2100 });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBe(REASON);
    expect(await within(panel).findByText(/not the transaction recorded/)).toBeTruthy();
  });

  it('[R1-5] booking sends the amount the person saw taken, and waits for a second admin', async () => {
    const fetchMock = server([held]);
    const { user } = renderWithQuery(<CardPaymentsPage />);
    await user.click(await screen.findByRole('button', { name: 'Book the week' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: /Transaction reference/ }), TXN);
    await user.type(within(panel).getByRole('textbox', { name: /Amount taken/ }), '2000');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Book the week' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(bodyOf(fetchMock)).toEqual({ action: 'BOOK', providerReference: TXN, amount: 2000 });
    expect(await screen.findByText(/Waiting for approval: a second admin/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book the week' })).toBeNull();
  });

  it('[R1-5] "nothing was taken" asks for the transaction and the order reference searched; a wrong order reference sends nothing; no amount is ever sent', async () => {
    const fetchMock = server([held]);
    const { user } = renderWithQuery(<CardPaymentsPage />);
    await user.click(await screen.findByRole('button', { name: 'Nothing was taken' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).queryByRole('textbox', { name: /Amount taken/ })).toBeNull();
    const order = within(panel).getByRole('textbox', { name: /Order reference/ }) as HTMLInputElement;
    expect(order.value).toBe('');
    await user.type(within(panel).getByRole('textbox', { name: /Transaction reference/ }), TXN);
    await user.type(order, 'SWIFT-cs_9');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Nothing was taken' }));
    expect(await within(panel).findByText(/not this payment's order reference/)).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await user.clear(order);
    await user.type(order, 'SWIFT-cs_1');
    await user.click(within(panel).getByRole('button', { name: 'Nothing was taken' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(bodyOf(fetchMock)).toEqual({ action: 'NOTHING_TAKEN', providerReference: TXN });
  });

  it('[F4] a payment held because the provider\'s amount differs from Swift\'s price offers no booking and no refund: it goes to the owner', async () => {
    server([{ ...held, failureCode: 'AMOUNT_MISMATCH' }]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(/The card provider says money was taken, but its amount or currency differs from Swift's price\. It stays here until the owner settles it/)).toBeTruthy();
    // [REVIEW-1 R3-2] No decision at all: the provider's own answer said money was taken.
    for (const name of ['Nothing was taken', 'Refund it', 'Book the week']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('[REVIEW-2460 S3-1 · B1] PowerTranz\'s record shows the payment voided or refunded in full: only "Nothing was taken" is offered', async () => {
    server([{ ...held, failureCode: 'LOOKUP_SHOWS_REVERSED' }]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(/Swift could not tell what happened to this payment, and PowerTranz's record shows it voided or refunded in full/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nothing was taken' })).toBeTruthy();
    for (const name of ['Refund it', 'Book the week']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('[REVIEW-2460 S3-1 · B3] part refunded on PowerTranz\'s record: no decision, never "nothing was taken"; escalated to the owner', async () => {
    server([{ ...held, failureCode: 'LOOKUP_PARTIAL_CREDIT' }]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(/Part of this payment was refunded and the rest is still taken\. Check it in PowerTranz's portal\. It stays here until the owner settles it/)).toBeTruthy();
    expect(screen.getByText(/shows part of it refunded: the rest is still taken/)).toBeTruthy();
    for (const name of ['Nothing was taken', 'Refund it', 'Book the week']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('[REVIEW-1 R2-3] once a refund was sent for a held payment, no decision is offered: it stays for the owner', async () => {
    server([{ ...held, providerRefundState: 'UNKNOWN' }]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(/A refund was sent for this payment, so money was taken\. It stays here until the owner settles it/)).toBeTruthy();
    for (const name of ['Nothing was taken', 'Refund it', 'Book the week']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  // [CARD-REFUND-LOOKUP] A refund Swift sent whose answer is not known: "Check with the card provider", two people.
  it('[CARD-REFUND-LOOKUP] a held payment whose refund answer is not known offers "Check with the card provider" (no decision); it sends no fields, waits for a second admin', async () => {
    const fetchMock = server([{ ...held, providerRefundState: 'UNKNOWN', providerCheck: true }]);
    const { user } = renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(/its answer is not known\. Check it with the card provider/)).toBeTruthy();
    for (const name of ['Nothing was taken', 'Refund it', 'Book the week']) expect(screen.queryByRole('button', { name })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check with the card provider' }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/Only if it shows the whole payment back is the refund\s+recorded as done/)).toBeTruthy();
    expect(within(panel).getByText(/Nothing is sent to the card again/)).toBeTruthy();
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Check with the card provider' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/admin/billing/card-sessions/cs_1/check-provider');
    expect(bodyOf(fetchMock)).toEqual({});
    expect(await screen.findByText(/Waiting for approval: a second admin/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check with the card provider' })).toBeNull();
  });

  it('[CARD-REFUND-LOOKUP] a refund the server says cannot be checked now (sent moments ago) offers no check; one held for the owner can be checked again', async () => {
    server([{ ...held, providerRefundState: 'SENDING', providerCheck: false }, { ...held, id: 'cs_5', providerRefundState: 'UNKNOWN', failureCode: 'LOOKUP_REFUND_NOT_WHOLE', providerCheck: true }]);
    renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText(/A refund was sent for this payment, so money was taken\. It stays here until the owner settles it/)).toBeTruthy();
    expect(screen.getByText(/PowerTranz's record shows a refund that is not this whole payment\. It stays here until the owner settles it/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Check with the card provider' })).toHaveLength(1);
    for (const name of ['Nothing was taken', 'Refund it', 'Book the week']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('[CARD-REFUND-LOOKUP] "Refunds to check" asks the server for unconfirmed refunds; a refund to the card shows its state and, checked, what PowerTranz\'s record showed', async () => {
    const credit = { ...paid, cardRefund: { state: 'UNKNOWN', providerRefundRef: null }, providerCheck: true };
    const fetchMock = server([credit], () => ({ status: 200, body: { success: true, data: { kind: 'CARD_CREDIT_REFUND', check: 'REFUNDED', reason: 'LOOKUP_CREDITED', refund: { state: 'REFUNDED', providerRefundRef: 'LOOKUP-CREDIT-X' } } } }));
    const { user } = renderWithQuery(<CardPaymentsPage />);
    await user.click(await screen.findByRole('button', { name: 'Refunds to check' }));
    expect(await screen.findByText(/Refund to the card \(at closing\): not confirmed/)).toBeTruthy();
    const url = new URL(String(requestsByMethod(fetchMock, 'GET').at(-1)![0]));
    expect(url.searchParams.get('refund')).toBe('UNCONFIRMED');
    expect(url.searchParams.has('status')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Check with the card provider' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Check with the card provider' }));
    expect(await screen.findByText(/PowerTranz's record shows the whole payment back\. Recorded as refunded\./)).toBeTruthy();
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
    expect(await screen.findByText(TXN)).toBeTruthy();
    expect(screen.getByText('SWIFT-cs_3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refund it' })).toBeNull();
  });

  it('[R1-6] one subscription\'s card payments: the server is asked for that subscription; an id that is not one sends nothing; Clear shows all again', async () => {
    const other = { ...paid, id: 'cs_4', subscriptionId: 'sub_9' };
    const fetchMock = server([paid, other]);
    const { user } = renderWithQuery(<CardPaymentsPage />);
    await user.click(await screen.findByRole('button', { name: 'All' }));
    expect(await screen.findByText('SWIFT-cs_4')).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'Subscription' });
    await user.type(box, 'not an id');
    const before = requestsByMethod(fetchMock, 'GET').length;
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText(/not a subscription id/)).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(before);
    await user.clear(box);
    await user.type(box, ' sub_9 ');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(screen.queryByText('SWIFT-cs_3')).toBeNull());
    expect(screen.getByText('SWIFT-cs_4')).toBeTruthy();
    const last = new URL(String(requestsByMethod(fetchMock, 'GET').at(-1)![0]));
    expect(last.searchParams.get('subscriptionId')).toBe('sub_9');
    expect(last.searchParams.has('status')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('SWIFT-cs_3')).toBeTruthy();
    expect(new URL(String(requestsByMethod(fetchMock, 'GET').at(-1)![0])).searchParams.has('subscriptionId')).toBe(false);
  });

  it('[R1-6] a full page says there are older ones and "Show older" asks the server for the ones before the last shown', async () => {
    const newer = { ...held, id: 'cs_10' };
    const older = { ...held, id: 'cs_11' };
    const fetchMock = server([], queued, { '': { rows: [newer], next: 'cs_10' }, cs_10: { rows: [older], next: null } });
    const { user } = renderWithQuery(<CardPaymentsPage />);
    expect(await screen.findByText('SWIFT-cs_10')).toBeTruthy();
    expect(screen.getByText(/Showing the newest 1\. There are older ones/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('SWIFT-cs_11')).toBeTruthy();
    expect(screen.getByText('SWIFT-cs_10')).toBeTruthy();
    expect(new URL(String(requestsByMethod(fetchMock, 'GET').at(-1)![0])).searchParams.get('before')).toBe('cs_10');
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    expect(screen.queryByText(/There are older ones/)).toBeNull();
  });
});
