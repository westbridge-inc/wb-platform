'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { decideSelfieCheck, fetchSelfieChecks, type SelfieCheck } from '@/lib/api';
import { DocumentViewer } from '@/components/verification/DocumentViewer';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { docLabel } from '@/lib/review-center';
import { gyDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [OWNER-ASKS · security review 9 Nov 2026] A service business that goes to the customer takes a selfie, often long
// after its owner's ID was approved on its own (an in-shop owner never takes one). Home visits book only once a person
// has compared THAT selfie with the approved ID (server: home-visits ownerPhotoMatchedToId). The queue is computed by
// the server: an owner appears when they list a home visit or take (or retake) the photo. The reviewer opens the ID,
// which comes with the selfie beside it, states why, and answers. Swift never compares faces by machine.
// ---------------------------------------------------------------------------

export default function SelfieChecksPage() {
  const checks = useQuery({ queryKey: ['selfie-checks'], queryFn: fetchSelfieChecks });
  if (checks.isError) return <QueryFailed what="the selfie checks" error={checks.error} onRetry={() => void checks.refetch()} />;
  if (!checks.data) return <p role="status" className="rc-muted">Loading…</p>;
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Selfie checks</h1>
        <p className="rc-muted">A business that goes to customers&rsquo; homes took a selfie after its ID was approved. Compare the two faces yourself; home visits stay paused until you record that they are the same person.</p>
      </div>
      {checks.data.length === 0
        ? <p className="rc-muted">No selfie is waiting to be checked.</p>
        : checks.data.map((check) => <SelfieCheckRow key={`${check.documentId}:${check.selfieCapturedAt}`} check={check} />)}
    </section>
  );
}

function SelfieCheckRow({ check }: { check: SelfieCheck }) {
  const queryClient = useQueryClient();
  const [viewed, setViewed] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = viewed && reason.trim().length > 0 && !busy;
  const decide = async (match: boolean) => {
    setBusy(true); setError('');
    try {
      await decideSelfieCheck(check.documentId, match, reason.trim());
      await queryClient.invalidateQueries({ queryKey: ['selfie-checks'] });
    } catch (err) {
      setError((err as { message?: string })?.message || 'The answer was not saved. Try again.');
    } finally { setBusy(false); }
  };
  const label = docLabel(check.docType);
  return (
    <article className="rounded-2xl border border-[var(--border)] p-4 space-y-3" aria-label={label}>
      <p className="font-semibold">{label} · selfie taken {gyDate(check.selfieCapturedAt)}</p>
      <DocumentViewer id={check.documentId} label={label} onViewed={setViewed} />
      <label className="block">
        <span className="rc-muted">Why (recorded)</span>
        <textarea className="w-full rounded-lg border border-[var(--border)] p-2" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error ? <p role="alert" className="text-sm">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" className="rc-btn" disabled={!ready} onClick={() => void decide(true)}>Same person</button>
        <button type="button" className="rc-btn" disabled={!ready} onClick={() => void decide(false)}>Not the same person</button>
      </div>
    </article>
  );
}
