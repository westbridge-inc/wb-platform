'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCardPayments, resolveCardPayment, type CardDecision, type CardPaymentsFilter } from '@/lib/api';
import { StatusPill } from '@/components/detail';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { gyDate, gyDateTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [CARD-READY] Weekly-fee card payments (Pay now). A HELD one is money the card provider may have taken that Swift
// could not book: a person checks the provider's portal, then books the week, refunds it, records a refund made in
// the portal, or records that nothing was taken. Each decision needs a second admin, is taken once, and the server
// refuses anything its own records do not allow (CARD-CHECKOUT-API.md section 8). Nothing here shows card data.
// ---------------------------------------------------------------------------

const FILTERS: { key: CardPaymentsFilter; label: string }[] = [
  { key: 'HELD', label: 'Needs a person' },
  { key: 'SUCCEEDED', label: 'Paid' },
  { key: 'ALL', label: 'All' },
];

/** Why a card payment is held, in words. */
const HELD_WHY: Record<string, string> = {
  APPROVED_UNPROVEN: "The provider's answer could not be booked (no proof of the bank's check, or a void was sent).",
  AMOUNT_MISMATCH: "The provider's amount is not this week's price.",
  TEST_SYSTEM_FOR_A_REAL_PARTNER: 'A test card system answered for a real partner: it moved no real money.',
  LATE_PROVIDER_APPROVAL: 'The provider approved it after Swift had closed the payment page.',
  NOT_SETTLED: 'The payment was taken but could not be booked to the week.',
  WALLET_CURRENCY_MISMATCH: 'The fee credit is held in another currency.',
  CURRENCY_UNPINNED: 'The currency it was charged in cannot be confirmed.',
  CARD_FACTS_INVALID: "The provider's answer was not readable.",
  PURPOSE_MISMATCH: "The provider's answer was for another kind of payment.",
};
/** A code with no words yet is shown as a code, never dressed up as words. */
const asCode = (code: string) => `code ${code}`;
const STATE_WORDS: Record<string, string> = { SENDING: 'being sent', SENT: 'sent', VOIDED: 'done', REFUNDED: 'done', PENDING: 'pending', FAILED: 'refused', UNKNOWN: 'not confirmed' };
const RESOLUTION_WORDS: Record<string, string> = { BOOKED: 'week booked', REFUNDED: 'refunded', NOTHING_TAKEN: 'nothing taken' };

const DECISIONS: { action: CardDecision; label: string; body: (_amount: string) => string; success: string }[] = [
  {
    action: 'BOOK', label: 'Book the week',
    body: (amount) => `Only when the provider's portal shows ${amount} taken for this payment. Swift books the week once, and only with the provider's own approved answer it stored; without that the server refuses.`,
    success: 'Week booked.',
  },
  {
    action: 'REFUND', label: 'Refund it',
    body: (amount) => `Swift asks the card provider once to refund the whole ${amount} to the card. Never after the week was booked.`,
    success: 'Refund sent. Check its answer on this payment.',
  },
  {
    action: 'REFUNDED_IN_PORTAL', label: 'Refunded in the portal',
    body: (amount) => `Records a refund of ${amount} someone already made in the provider's portal. Swift sends nothing.`,
    success: 'Refund recorded.',
  },
  {
    action: 'NOTHING_TAKEN', label: 'Nothing was taken',
    body: () => "Records that the provider's portal shows nothing taken for this payment. Swift sends nothing.",
    success: 'Recorded: nothing taken.',
  },
];

interface CardPaymentRow {
  id: string; subscriptionId: string; status: string; amount: number | null; currencyCode: string | null; periodStart: string | null;
  createdAt: string; failureCode: string | null; environment: string;
  providerTransactionRef: string | null; providerVoidState: string | null; providerRefundState: string | null;
  resolution: string | null; resolvedAt: string | null;
}

const money = (amount: number | null, currency: string | null) => (amount === null ? '—' : `${currency === 'GYD' || !currency ? 'GY$' : `${currency} `}${amount.toLocaleString()}`);

export default function CardPaymentsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<CardPaymentsFilter>('HELD');
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['card-payments', filter], queryFn: () => fetchCardPayments(filter) });
  const actions = useActionRunner(() => qc.invalidateQueries({ queryKey: ['card-payments'] }));
  const [queued, setQueued] = useState<Record<string, true>>({});
  const rows: CardPaymentRow[] = data?.data?.sessions ?? [];

  const decide = (r: CardPaymentRow, d: (typeof DECISIONS)[number]) => void actions.run({
    title: `${d.label}: ${money(r.amount, r.currencyCode)} card payment?`,
    body: <p>{d.body(money(r.amount, r.currencyCode))} Provider transaction {r.providerTransactionRef}. A second admin approves it.</p>,
    confirmLabel: d.label,
    submit: ({ reason }) => resolveCardPayment(r.id, d.action, r.providerTransactionRef!, r.amount!, reason),
    success: () => d.success,
  }).then((outcome) => {
    if (outcome?.tone === 'queued') setQueued((all) => ({ ...all, [r.id]: true }));
  });

  return (
    <div className="mc-page">
      <div className="flex gap-1 mb-1" role="group" aria-label="Show card payments">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key} className="mc-tab">{f.label}</button>
        ))}
      </div>
      <p className="mc-muted text-sm mb-6">
        Weekly-fee card payments. One that needs a person may have been taken by the card provider without Swift booking it: check the provider&apos;s portal first, then decide. No card number is ever shown here.
      </p>
      {actions.banner}
      <div className="space-y-3">
        {isLoading ? (
          <div className="mc-loading h-24" />
        ) : isError ? (
          <QueryFailed error={error} what="the card payments" onRetry={() => void refetch()} retrying={isFetching} />
        ) : rows.length === 0 ? (
          <div className="mc-empty">{filter === 'HELD' ? 'No card payment needs a person.' : 'No card payments here.'}</div>
        ) : (
          rows.map((r) => {
            const open = r.status === 'HELD' && !r.resolution;
            return (
              <div key={r.id} className="mc-card">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusPill value={r.status} />
                  <span className="text-sm font-semibold">{money(r.amount, r.currencyCode)}</span>
                  {r.periodStart && <span className="text-sm">Week of {gyDate(r.periodStart)}</span>}
                  {r.environment !== 'live' && <span className="text-xs mc-text-warn">Test system</span>}
                  <span className="text-xs mc-muted ml-auto">{gyDateTime(r.createdAt)}</span>
                </div>
                <p className="text-sm mt-2">
                  {r.providerTransactionRef ? <>Provider transaction <span className="font-mono break-all">{r.providerTransactionRef}</span></> : 'No provider transaction recorded.'}
                  <span className="mc-muted"> · Subscription <span className="font-mono">{r.subscriptionId}</span></span>
                </p>
                {r.status === 'HELD' && r.failureCode && <p className="text-sm mc-muted mt-1">{HELD_WHY[r.failureCode] ?? `Held for a reason without words yet (${asCode(r.failureCode)}).`}</p>}
                {(r.providerVoidState || r.providerRefundState || r.resolution) && (
                  <p className="text-sm mc-muted mt-1">
                    {[r.providerVoidState && `Void ${STATE_WORDS[r.providerVoidState] ?? asCode(r.providerVoidState)}`,
                      r.providerRefundState && `Refund ${STATE_WORDS[r.providerRefundState] ?? asCode(r.providerRefundState)}`,
                      r.resolution && `Decided: ${RESOLUTION_WORDS[r.resolution] ?? asCode(r.resolution)}${r.resolvedAt ? `, ${gyDateTime(r.resolvedAt)}` : ''}`].filter(Boolean).join(' · ')}
                  </p>
                )}
                {open && (r.providerTransactionRef && r.amount !== null ? (
                  queued[r.id] ? <p role="status" className="text-sm mt-3">Waiting for approval: a second admin, on Approvals. Nothing has changed yet.</p> : (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {DECISIONS.map((d) => <button key={d.action} type="button" className="mc-btn" onClick={() => decide(r, d)}>{d.label}</button>)}
                    </div>
                  )
                ) : <p className="text-sm mt-3">No provider transaction is recorded, so nothing can be decided here. Find it in the provider&apos;s portal and escalate to the owner.</p>)}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
