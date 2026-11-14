'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { approveAccountChange, fetchAccountChanges, refuseAccountChange, type AccountChange, type AccountChangeApproval, type BusinessTypeOption, type SellerLegalNameOnApproval } from '@/lib/api';
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
function legalNameOnApprovalWords(preview: SellerLegalNameOnApproval, change: Pick<AccountChange, 'kind' | 'toOption'>, confirmsNames: boolean): string {
  // [review-2475 delta S4-2] A name typed from the change's paper that is a person's is never promised to customers.
  const personNote = preview.heldNameIsAPerson ? 'The name typed from this change’s registration paper is a person’s name, so approval does not use it. ' : '';
  return personNote + effectWords(preview, change, confirmsNames);
}
function effectWords(preview: SellerLegalNameOnApproval, change: Pick<AccountChange, 'kind' | 'toOption'>, confirmsNames: boolean): string {
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
  return `Approval clears “${preview.from ?? ''}”: it was typed for ${typedFor}${preview.heldNameIsAPerson ? '' : ', and nobody typed a name from this change’s registration paper'}. `
    // [review-2480 B S4-2] What customers then see, by the storefront's own order: an own-name trader's own name; else each
    // store's confirmed name; else "Ask the store". A tick confirms a store's name only when it is not a person's.
    + (change.kind === 'BUSINESS_TYPE' && change.toOption === 'OWN_NAME'
      ? 'Customers then see the owner’s own name as the seller (from the own-name declaration).'
      : 'Customers then see each store’s confirmed name as the seller, or “Ask the store” for a store with none, until a person types a legal name from a registration paper'
        + `${confirmsNames ? ' (ticking a store’s name below confirms it, unless it is a person’s name)' : ''}.`);
}

/** [review-2475 delta S4-2] The approval's answer: what it did not confirm, by store name, with the server's reason. */
type ApprovalSaid = { title: string; lines: string[] };
function approvalLines(change: AccountChange, answer: AccountChangeApproval): string[] {
  const lines: string[] = [];
  const notConfirmed = answer.sellerNamesNotConfirmed;
  if (notConfirmed?.storeIds.length) {
    const names = notConfirmed.storeIds.map((id) => change.stores.find((s) => s.id === id)?.name ?? 'a store').join(', ');
    lines.push(`Seller name not confirmed for ${names}: ${notConfirmed.message}`);
  }
  if (answer.sellerLegalNameNotUsed) lines.push(`Seller legal name not set: ${answer.sellerLegalNameNotUsed.message}`);
  return lines;
}

export default function AccountChangesPage() {
  const changes = useQuery({ queryKey: ['account-changes', 'PENDING'], queryFn: () => fetchAccountChanges('PENDING') });
  const [said, setSaid] = useState<ApprovalSaid | null>(null);
  if (changes.isError) return <QueryFailed what="the account changes" error={changes.error} onRetry={() => void changes.refetch()} />;
  if (!changes.data) return <p role="status" className="rc-muted">Loading…</p>;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Account changes</h1>
        <p className="rc-muted">A store&rsquo;s new business type, or a company&rsquo;s new account holder. Check each paper in Documents first; the store keeps selling on its old papers until you decide.</p>
      </div>
      {said ? (
        <div role="status" aria-label="What the approval did not confirm" className="rounded-2xl border border-[var(--border)] p-3">
          <p className="font-semibold">Approved: {said.title}</p>
          {said.lines.map((line) => <p key={line} className="rc-muted">{line}</p>)}
        </div>
      ) : null}
      {changes.data.length === 0
        ? <p className="rc-muted">No account change is waiting.</p>
        : changes.data.map((change) => <AccountChangeRow key={change.id} change={change} onApproved={setSaid} />)}
    </section>
  );
}

function AccountChangeRow({ change, onApproved }: { change: AccountChange; onApproved: (_said: ApprovalSaid | null) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  // A change to anything but "own name" names the seller by each store's name: the reviewer confirms each one they see.
  const namesToConfirm = change.kind === 'BUSINESS_TYPE' && change.toOption !== 'OWN_NAME' ? change.stores : [];
  const namesReady = namesToConfirm.every((s) => confirmed[s.id]);
  // [review-2480 B S4-1] A handover confirms no name, but ends a confirmation that is a person's: shown before deciding.
  const endsOnHandover = change.kind === 'HOLDER_HANDOVER' ? change.stores.filter((s) => s.nameIsAPerson) : [];
  const handoverReady = change.kind !== 'HOLDER_HANDOVER' || change.accepted === true;
  const canApprove = change.papersComplete && namesReady && handoverReady && reason.trim().length > 0 && !busy;
  const decide = async (approve: boolean) => {
    setBusy(true); setError('');
    try {
      if (approve) {
        const sellerNames = namesToConfirm.length ? Object.fromEntries(namesToConfirm.map((s) => [s.id, s.name])) : undefined;
        const answer = await approveAccountChange(change.id, sellerNames, reason.trim());
        const lines = approvalLines(change, answer);
        onApproved(lines.length ? { title, lines } : null);
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
            {' '}On approval the account moves to them for every branch, the old holder is signed out everywhere, their papers for this business and their saved cards stop counting, and the stores&rsquo; MMG numbers are cleared for the new holder to set.
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
      <LegalNameLine legalName={change.legalName} isAPerson={change.sellerLegalNameOnApproval?.heldNameIsAPerson === true} />
      {change.sellerLegalNameOnApproval ? (
        <div role="note" aria-label="Seller legal name on approval">
          <p className="font-semibold">Seller legal name</p>
          <p className="rc-muted">{legalNameOnApprovalWords(change.sellerLegalNameOnApproval, change, namesToConfirm.length > 0)}</p>
        </div>
      ) : null}
      {endsOnHandover.length ? (
        <div role="note" aria-label="Seller names approval ends" className="space-y-1">
          {endsOnHandover.map((s) => (
            <p key={s.id} className="rc-muted">
              {s.name}: its confirmed seller name &ldquo;{s.sellerNameCheckedName ?? s.name}&rdquo; is a person&rsquo;s name, so approval ends it; customers then see the account&rsquo;s legal name if one is set, otherwise &ldquo;Ask the store&rdquo;.
            </p>
          ))}
        </div>
      ) : null}
      {namesToConfirm.length ? (
        <fieldset className="space-y-1">
          <legend className="font-semibold">Seller name customers will see</legend>
          {namesToConfirm.map((s) => (
            <label key={s.id} className="flex gap-2 items-start">
              <input type="checkbox" checked={!!confirmed[s.id]} onChange={(e) => setConfirmed((c) => ({ ...c, [s.id]: e.target.checked }))} />
              {s.nameIsAPerson
                ? <span>&ldquo;{s.name}&rdquo; is a person&rsquo;s name: approval does not confirm it as the seller&rsquo;s name; customers see the account&rsquo;s legal name if one is set, otherwise &ldquo;Ask the store&rdquo;</span>
                : <span>&ldquo;{s.name}&rdquo; is the business&rsquo;s name on its papers</span>}
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

/** [review-2475 F1] Which business the papers name, so a paper naming another business is seen before approving. */
function LegalNameLine({ legalName, isAPerson }: { legalName: AccountChange['legalName']; isAPerson: boolean }) {
  if (!legalName) return null;
  // [review-2475 delta S4-2] The server will not use a typed name that is a person's: never promise customers see it.
  if (legalName.change && isAPerson) {
    return (
      <p aria-label="Business named on the papers">
        Business named on this change&rsquo;s papers: &ldquo;{legalName.change}&rdquo;. It is a person&rsquo;s name, so customers will not see it as the seller
        {legalName.account ? <> (now: &ldquo;{legalName.account}&rdquo;)</> : null}. If it is not this account&rsquo;s business, refuse.
      </p>
    );
  }
  if (legalName.change) {
    return (
      <p aria-label="Business named on the papers">
        Business named on this change&rsquo;s papers: &ldquo;{legalName.change}&rdquo;. Customers see it as the seller once you approve
        {legalName.account ? <> (now: &ldquo;{legalName.account}&rdquo;)</> : null}. If it is not this account&rsquo;s business, refuse.
      </p>
    );
  }
  return (
    <p aria-label="Business named on the papers" className="rc-muted">
      No business name was typed from this change&rsquo;s papers.
      {legalName.account ? <> Approving removes &ldquo;{legalName.account}&rdquo; as the seller&rsquo;s legal name until a person types one from a paper.</> : null}
    </p>
  );
}
