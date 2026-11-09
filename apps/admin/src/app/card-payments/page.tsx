'use client';

import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCardPayments, resolveCardPayment, type CardDecision, type CardPaymentsFilter } from '@/lib/api';
import type { ReasonField } from '@/components/mc/ReasonDialog';
import { StatusPill } from '@/components/detail';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { gyDate, gyDateTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [CARD-READY] Weekly-fee card payments (Pay now). A HELD one is money the card provider may have taken that Swift
// could not book: a person checks the provider's portal, then books the week, refunds it (the API refund), or records
// that nothing was taken. Each decision needs a second admin, is taken once, and the server refuses anything its own
// records do not allow (CARD-CHECKOUT-API.md section 8). Nothing here shows card data.
// [R1-5] The page never fills in what the person checked: they TYPE the transaction (and, to book or refund, the
// amount) as the portal shows it, and for "nothing taken" the order reference they searched. Swift's own record is
// shown read-only beside it. [REVIEW-2 F3] Each payment shows its order reference, SWIFT-<session id>: the
// OrderIdentifier Swift sends, which the provider's Merchant Portal and reports use (guide 9.2).
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
  LOOKUP_SHOWS_REVERSED: "Swift could not tell what happened to this payment, and PowerTranz's record shows it voided or refunded in full. Nothing was booked.",
  LOOKUP_PARTIAL_CREDIT: "Swift could not tell what happened to this payment, and PowerTranz's record shows part of it refunded: the rest is still taken. Nothing was booked.",
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

/** What the person states from the portal: the amount seen taken (book, refund), or the order reference searched (nothing taken). */
type Asks = 'amount' | 'order';
const DECISIONS: { action: CardDecision; label: string; asks: Asks; body: (_amount: string) => string; success: string }[] = [
  {
    action: 'BOOK', label: 'Book the week', asks: 'amount',
    body: (amount) => `Only when the provider's portal shows ${amount} taken for this payment. Swift books the week once, and only with the provider's own approved answer it stored; without that the server refuses.`,
    success: 'Week booked.',
  },
  {
    action: 'REFUND', label: 'Refund it', asks: 'amount',
    body: (amount) => `Only when the provider's portal shows exactly ${amount} taken. Swift asks the card provider once to refund the whole ${amount} to the card, never a part of it, and never after the week was booked. If the portal shows any other amount, do not refund: escalate to the owner.`,
    success: 'Refund sent. Check its answer on this payment.',
  },
  {
    action: 'NOTHING_TAKEN', label: 'Nothing was taken', asks: 'order',
    body: () => "Records that the provider's portal shows nothing taken for this payment. Swift sends nothing, and no amount is stated.",
    success: 'Recorded: nothing taken.',
  },
];

/** The shape of a reference the server takes (its ID_SHAPE): letters, digits, _ and -. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** The OrderIdentifier Swift sends for a card session (powertranz-provider createSession). */
const orderRef = (sessionId: string) => `SWIFT-${sessionId}`;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (text: string) => new RegExp(`^${escapeRegExp(text)}$`);

function fieldsFor(r: CardPaymentRow, asks: Asks): ReasonField[] {
  const txn: ReasonField = {
    kind: 'text', name: 'txn', label: 'Transaction reference in the portal', required: true, maxLength: 64, pattern: ID_SHAPE,
    hint: "Type it as the card provider's portal shows it. Swift's record is above, to compare.",
    patternMessage: 'That is not a transaction reference: letters, digits, - and _ only, no spaces.',
  };
  if (asks === 'amount') {
    const currency = !r.currencyCode || r.currencyCode === 'GYD' ? 'GYD' : r.currencyCode;
    return [txn, { kind: 'amount', name: 'amount', label: 'Amount taken in the portal', cents: true, hint: `In ${currency}, as the portal shows it, e.g. 2100` }];
  }
  return [txn, {
    kind: 'text', name: 'order', label: 'Order reference you searched', required: true, maxLength: 80, pattern: exactly(orderRef(r.id)),
    hint: 'The order reference you looked up in the portal or its reports, as it shows it.',
    patternMessage: "That is not this payment's order reference. Look the payment up by the order reference shown above.",
  }];
}

/** A subscription id as the server takes it, or null when it is not one. */
const subscriptionIdOf = (raw: string) => {
  const text = raw.trim();
  return ID_SHAPE.test(text) ? text : null;
};

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
  // [R1-6] One subscription's card payments (e.g. to find the ones a closing refund pays back): typed, then applied.
  const [subscriptionText, setSubscriptionText] = useState('');
  const [subscription, setSubscription] = useState('');
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['card-payments', filter, subscription],
    queryFn: ({ pageParam }) => fetchCardPayments(filter, { subscriptionId: subscription || undefined, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last?.data?.next as string | null | undefined) ?? undefined,
  });
  const actions = useActionRunner(() => qc.invalidateQueries({ queryKey: ['card-payments'] }));
  const [queued, setQueued] = useState<Record<string, true>>({});
  const rows: CardPaymentRow[] = data?.pages.flatMap((page) => (page?.data?.sessions ?? []) as CardPaymentRow[]) ?? [];

  const find = (event: FormEvent) => {
    event.preventDefault();
    const text = subscriptionText.trim();
    const id = subscriptionIdOf(text);
    if (text && !id) { setSubscriptionError('That is not a subscription id: letters, digits, - and _ only, no spaces.'); return; }
    setSubscriptionError(null);
    setSubscription(id ?? '');
  };
  const clearSubscription = () => { setSubscriptionText(''); setSubscriptionError(null); setSubscription(''); };

  const decide = (r: CardPaymentRow, d: (typeof DECISIONS)[number]) => void actions.run({
    title: `${d.label}: ${money(r.amount, r.currencyCode)} card payment?`,
    body: (
      <>
        <p>{d.body(money(r.amount, r.currencyCode))}{d.asks === 'amount' ? ` Check the portal shows the currency ${r.currencyCode ?? 'GYD'}.` : ''} A second admin approves it.</p>
        <p className="text-sm mt-2">
          Swift&apos;s record: provider transaction <span className="font-mono break-all">{r.providerTransactionRef}</span>
          {' · '}order <span className="font-mono break-all">{orderRef(r.id)}</span>
        </p>
      </>
    ),
    confirmLabel: d.label,
    fields: fieldsFor(r, d.asks),
    submit: ({ reason, values }) => resolveCardPayment(r.id, d.action, String(values['txn']), d.asks === 'amount' ? Number(values['amount']) : null, reason),
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
      <form className="flex flex-wrap items-end gap-2 mb-1" onSubmit={find} role="search" aria-label="One subscription">
        <label className="text-sm">
          <span className="block mc-muted">Subscription</span>
          <input
            value={subscriptionText} onChange={(e) => setSubscriptionText(e.target.value)} placeholder="Subscription id"
            className="mc-input font-mono" autoComplete="off" aria-invalid={subscriptionError ? true : undefined}
          />
        </label>
        <button type="submit" className="mc-btn">Find</button>
        {(subscription || subscriptionText) && <button type="button" className="mc-btn" onClick={clearSubscription}>Clear</button>}
      </form>
      {subscriptionError && <p role="alert" className="text-sm mc-text-warn mb-1">{subscriptionError}</p>}
      {subscription && <p className="text-sm mb-1">Showing subscription <span className="font-mono">{subscription}</span> only.</p>}
      <p className="mc-muted text-sm mb-6">
        Weekly-fee card payments. One that needs a person may have been taken by the card provider without Swift booking it: check the provider&apos;s portal first, then decide. Look each one up there by its order reference or its transaction. No card number is ever shown here. A refund recorded later on the Subscriptions page is not shown here: find it on that page.
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
                  {' · '}Order <span className="font-mono break-all">{orderRef(r.id)}</span>
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
                {open && r.failureCode === 'LOOKUP_PARTIAL_CREDIT' ? (
                  // [REVIEW-2460 S3-1 · B3] Part refunded, the rest still taken: no decision here.
                  <p className="text-sm mt-3">Part of this payment was refunded and the rest is still taken. Check it in PowerTranz&apos;s portal. It stays here until the owner settles it with the card provider: escalate it to the owner.</p>
                ) : open && r.failureCode === 'AMOUNT_MISMATCH' ? (
                  // [REVIEW-1 R3-2] The provider's own answer says money was taken, at another amount or currency: no decision here.
                  <p className="text-sm mt-3">The card provider says money was taken, but its amount or currency differs from Swift&apos;s price. It stays here until the owner settles it with the card provider: escalate it to the owner.</p>
                ) : open && r.providerRefundState ? (
                  // [REVIEW-1 R2-3] A refund was sent: money was taken. No decision closes it here; the owner settles it.
                  <p className="text-sm mt-3">A refund was sent for this payment, so money was taken. It stays here until the owner settles it with the card provider: escalate it to the owner.</p>
                ) : open && (r.providerTransactionRef && r.amount !== null ? (
                  queued[r.id] ? <p role="status" className="text-sm mt-3">Waiting for approval: a second admin, on Approvals. Nothing has changed yet.</p> : (
                    <div className="flex flex-wrap gap-2 mt-3">
                      {/* [REVIEW-2460 S3-1 · B1] Voided or refunded in full on PowerTranz's record: only "nothing taken". */}
                      {DECISIONS.filter((d) => r.failureCode !== 'LOOKUP_SHOWS_REVERSED' || d.action === 'NOTHING_TAKEN')
                        .map((d) => <button key={d.action} type="button" className="mc-btn" onClick={() => decide(r, d)}>{d.label}</button>)}
                    </div>
                  )
                ) : <p className="text-sm mt-3">No provider transaction is recorded, so nothing can be decided here. Find it in the provider&apos;s portal and escalate to the owner.</p>)}
              </div>
            );
          })
        )}
      </div>
      {hasNextPage && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-sm">Showing the newest {rows.length}. There are older ones.</p>
          <button type="button" className="mc-btn" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Show older'}
          </button>
        </div>
      )}
    </div>
  );
}
