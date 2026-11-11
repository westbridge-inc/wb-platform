'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { approveAccountChange, fetchAccountChanges, refuseAccountChange, type AccountChange, type BusinessTypeOption, type SellerLegalNameOnApproval } from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { docLabel } from '@/lib/review-center';
import { gyDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 (c), (d)] A store asked to change its business type (a company that
// signed up as trading under its owner's own name, say), or a company named a new account holder. The store keeps
// selling on its old papers meanwhile. Each new paper is checked in Documents like any other; here a person decides the
// change itself, with a reason. Approved: the business type (or the account holder), the papers that count and the
// seller name customers see switch at once. Refused: nothing changes, and the store reads the reason.
// ---------------------------------------------------------------------------

const OPTION_WORDS: Record<BusinessTypeOption, string> = {
  COMPANY: 'a registered company',
  REGISTERED: 'a registered business, held by its owner',
  MANAGER: 'a registered business, held by its manager',
  OWN_NAME: 'trading under the owner’s own name',
};
const PAPER_WORDS: Record<AccountChange['papers'][number]['state'], string> = {
  APPROVED: 'Approved', PENDING: 'Waiting in Documents', REJECTED: 'Rejected', MISSING: 'Not uploaded yet',
};

/**
 * [FOLLOWUPS-2475] What approval does to the account's seller legal name (the name customers see as the seller of every
 * branch), said plainly before a person decides. The effect is the server's own (the approval's rule, read without
 * writing: sellerLegalNameOnApproval); this only puts it in words.
 */
function legalNameOnApprovalWords(preview: SellerLegalNameOnApproval, change: Pick<AccountChange, 'kind'>, confirmsNames: boolean): string {
  const paper = preview.docType ? docLabel(preview.docType) : 'registration paper';
  if (preview.effect === 'SET') {
    if (preview.from === null) return `Approval sets it to “${preview.to}”, as a person typed it from this change’s ${paper}.`;
    if (preview.from === preview.to) return `Approval sets it to “${preview.to}” from this change’s ${paper} (the same words as now, from the new paper).`;
    return `Approval replaces “${preview.from}” with “${preview.to}”, as a person typed it from this change’s ${paper}.`;
  }
  if (preview.effect === 'KEPT') {
    return preview.from === null ? 'There is none now, and approval sets none.' : `Approval keeps “${preview.from}”.`;
  }
  const typedFor = change.kind === 'BUSINESS_TYPE' ? 'the old business type' : 'the old account holder’s papers';
  return `Approval clears “${preview.from ?? ''}”: it was typed for ${typedFor}, and nobody typed a name from this change’s registration paper. `
    + `Customers then see “Ask the store” as the seller until a person confirms a name${confirmsNames ? ' (ticking each store’s name below does that)' : ''}.`;
}

export default function AccountChangesPage() {
  const changes = useQuery({ queryKey: ['account-changes', 'PENDING'], queryFn: () => fetchAccountChanges('PENDING') });
  if (changes.isError) return <QueryFailed what="the account changes" error={changes.error} onRetry={() => void changes.refetch()} />;
  if (!changes.data) return <p role="status" className="rc-muted">Loading…</p>;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Account changes</h1>
        <p className="rc-muted">A store&rsquo;s new business type, or a company&rsquo;s new account holder. Check each paper in Documents first; the store keeps selling on its old papers until you decide.</p>
      </div>
      {changes.data.length === 0
        ? <p className="rc-muted">No account change is waiting.</p>
        : changes.data.map((change) => <AccountChangeRow key={change.id} change={change} />)}
    </section>
  );
}

function AccountChangeRow({ change }: { change: AccountChange }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  // A change to anything but "own name" names the seller by each store's name: the reviewer confirms each one they see.
  const namesToConfirm = change.kind === 'BUSINESS_TYPE' && change.toOption !== 'OWN_NAME' ? change.stores : [];
  const namesReady = namesToConfirm.every((s) => confirmed[s.id]);
  const handoverReady = change.kind !== 'HOLDER_HANDOVER' || change.accepted === true;
  const canApprove = change.papersComplete && namesReady && handoverReady && reason.trim().length > 0 && !busy;
  const decide = async (approve: boolean) => {
    setBusy(true); setError('');
    try {
      if (approve) {
        const sellerNames = namesToConfirm.length ? Object.fromEntries(namesToConfirm.map((s) => [s.id, s.name])) : undefined;
        await approveAccountChange(change.id, sellerNames, reason.trim());
      } else {
        await refuseAccountChange(change.id, reason.trim());
      }
      await queryClient.invalidateQueries({ queryKey: ['account-changes'] });
    } catch (err) {
      setError((err as { message?: string })?.message || 'The decision was not saved. Try again.');
    } finally { setBusy(false); }
  };
  const title = change.kind === 'BUSINESS_TYPE'
    ? `Business type: ${OPTION_WORDS[change.fromOption ?? 'REGISTERED']} → ${OPTION_WORDS[change.toOption ?? 'REGISTERED']}`
    : `Account holder: ${change.holder.name} → ${change.newHolder?.name ?? 'the person named'}`;
  return (
    <article className="rounded-2xl border border-[var(--border)] p-4 space-y-3" aria-label={title}>
      <div>
        <p className="font-semibold">{title}</p>
        <p className="rc-muted">Asked {gyDate(change.createdAt)} · {change.stores.length === 1 ? '1 store' : `${change.stores.length} stores`}: {change.stores.map((s) => s.name).join(', ')}</p>
        {change.kind === 'HOLDER_HANDOVER' ? (
          <p className="rc-muted">
            {change.accepted ? `${change.newHolder?.name ?? 'The person named'} said yes and files their own papers.` : `${change.newHolder?.name ?? 'The person named'} has not said yes yet.`}
            {' '}On approval the account moves to them for every branch, the old holder is signed out everywhere, and the stores&rsquo; MMG numbers are cleared for the new holder to set.
          </p>
        ) : null}
      </div>
      <ul className="space-y-1" aria-label="Papers">
        {change.papers.map((paper) => (
          <li key={paper.docType} className="flex flex-wrap gap-2">
            <span>{docLabel(paper.docType)}</span>
            <span className="rc-muted">· {PAPER_WORDS[paper.state]}{paper.forChange ? '' : ' (already on file)'}</span>
          </li>
        ))}
      </ul>
      {!change.papersComplete ? <p className="rc-muted">Approve each paper in Documents before deciding the change.</p> : null}
      {change.sellerLegalNameOnApproval ? (
        <div role="note" aria-label="Seller legal name on approval">
          <p className="font-semibold">Seller legal name</p>
          <p className="rc-muted">{legalNameOnApprovalWords(change.sellerLegalNameOnApproval, change, namesToConfirm.length > 0)}</p>
        </div>
      ) : null}
      {namesToConfirm.length ? (
        <fieldset className="space-y-1">
          <legend className="font-semibold">Seller name customers will see</legend>
          {namesToConfirm.map((s) => (
            <label key={s.id} className="flex gap-2 items-start">
              <input type="checkbox" checked={!!confirmed[s.id]} onChange={(e) => setConfirmed((c) => ({ ...c, [s.id]: e.target.checked }))} />
              <span>&ldquo;{s.name}&rdquo; is the business&rsquo;s name on its papers</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="block">
        <span className="rc-muted">Why (recorded; on a refusal the store reads it)</span>
        <textarea className="w-full rounded-lg border border-[var(--border)] p-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      {error ? <p role="alert" className="text-sm">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" className="rc-btn" disabled={!canApprove} onClick={() => void decide(true)}>Approve the change</button>
        <button type="button" className="rc-btn" disabled={busy || reason.trim().length === 0} onClick={() => void decide(false)}>Refuse</button>
      </div>
    </article>
  );
}
