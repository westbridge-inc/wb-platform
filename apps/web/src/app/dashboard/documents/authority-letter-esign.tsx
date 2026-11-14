'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storeKey } from '@/lib/store-scope';
import {
  ESIGN_CANCEL, ESIGN_PAPER_FALLBACK, ESIGN_SEND, SIGNER_DIGITS, askAuthorityLetter, cancelAuthorityLetter, esignFieldLabels, esignIntro, esignOffered,
  esignTitle, getAuthorityLetter, letterErrorLine, letterFormState, letterRequestFor, letterStatusLine, resendAuthorityLetter, resendState,
  type LetterField,
} from '@/lib/authority-letter';

const EMPTY = { businessName: '', registrationNumber: '', requesterName: '', requesterRole: '', signerName: '', signerDigits: '' };
const TEXT_FIELDS: Array<Exclude<LetterField, 'signerPhone'>> = ['businessName', 'registrationNumber', 'requesterName', 'requesterRole', 'signerName'];

/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] Under the letter of authority on the Documents page: "Ask a director
 * (the owner) to sign in Swift". A short form; Swift writes the one-page letter and texts the signer a link; then where
 * it stands ("Waiting for Devon to sign"), with resend and cancel. The paper upload stays beside it (DocumentCard).
 */
export function AuthorityLetterEsign({ storeId, docType, kind, docRejected = false, onSigned }: {
  storeId: string; docType: string; kind: 'director' | 'owner';
  /** The letter on file was not accepted: a signed request before it is history, the form is offered again. */
  docRejected?: boolean;
  /** The signer just signed: the checklist reads the filed letter. */
  onSigned: () => void;
}) {
  const queryClient = useQueryClient();
  const key = storeKey(storeId, 'authority-letter');
  // While a link waits, look again now and then: the row changes by itself once the signer signs.
  const read = useQuery({ queryKey: key, queryFn: getAuthorityLetter, refetchInterval: (q) => (q.state.data?.request?.status === 'SENT' ? 20_000 : false) });
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<LetterField, boolean>>>({});
  const labels = esignFieldLabels(kind);
  const state = letterFormState(form, kind);
  const settle = () => void queryClient.invalidateQueries({ queryKey: key });
  const ask = useMutation({ mutationFn: () => askAuthorityLetter(state.body), onSuccess: () => { setForm(EMPTY); setTouched({}); settle(); } });
  const resend = useMutation({ mutationFn: (id: string) => resendAuthorityLetter(id), onSuccess: settle });
  const cancel = useMutation({ mutationFn: (id: string) => cancelAuthorityLetter(id), onSuccess: settle });

  const newest = letterRequestFor(docType, read.data);
  const request = newest && !(newest.status === 'SIGNED' && docRejected) ? newest : null;
  const failed = ask.error ?? resend.error ?? cancel.error;
  // Signed while this page was open: the checklist reads the filed letter (once).
  const told = useRef(false);
  useEffect(() => {
    if (request?.status === 'SIGNED' && !told.current) { told.current = true; onSigned(); }
  }, [request?.status, onSigned]);

  if (read.isLoading) return null;
  // Switched off (until the owner approves the privacy wording) or an older server: the paper letter only.
  if (!request && !esignOffered(read.data)) return null;
  if (request) {
    const again = resendState(request);
    return (
      <section className="rounded-2xl border border-[var(--swift-border)] p-4" aria-label={esignTitle(kind)} data-authority-esign>
        <p className="font-semibold">{esignTitle(kind)}</p>
        <p role="status" className="mt-1 text-sm text-[var(--swift-muted)]">{letterStatusLine(request)}</p>
        {request.status !== 'SIGNED' && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="sw-chip" disabled={!again.allowed || resend.isPending} onClick={() => resend.mutate(request.id)}>
              {resend.isPending ? 'Sending…' : again.label}
            </button>
            <button type="button" className="sw-link-btn" disabled={cancel.isPending} onClick={() => cancel.mutate(request.id)}>{ESIGN_CANCEL}</button>
          </div>
        )}
        {failed ? <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{letterErrorLine(failed)}</p> : null}
      </section>
    );
  }

  const shown = (field: LetterField) => (touched[field] ? state.errors[field] : undefined);
  return (
    <section className="rounded-2xl border border-[var(--swift-border)] p-4" aria-label={esignTitle(kind)} data-authority-esign>
      <p className="font-semibold">{esignTitle(kind)}</p>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">{esignIntro(kind)}</p>
      <form
        className="mt-3 grid gap-3"
        onSubmit={(e) => { e.preventDefault(); if (state.canSubmit && !ask.isPending) ask.mutate(); }}
      >
        {TEXT_FIELDS.map((field) => (
          <label key={field} className="grid gap-1 text-sm">
            <span className="font-semibold">{labels[field]}</span>
            <input
              className="sw-input" value={form[field]} aria-invalid={!!shown(field)}
              onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, [field]: true }))}
            />
            {shown(field) ? <span className="text-xs text-[var(--swift-red)]">{shown(field)}</span> : null}
          </label>
        ))}
        <label className="grid gap-1 text-sm">
          <span className="font-semibold">{labels.signerPhone}</span>
          <span className="flex items-center gap-2">
            <span className="text-[var(--swift-muted)]" aria-hidden="true">+592</span>
            <input
              className="sw-input" inputMode="tel" autoComplete="off" value={form.signerDigits} aria-label={labels.signerPhone}
              aria-invalid={!!shown('signerPhone')}
              onChange={(e) => setForm((f) => ({ ...f, signerDigits: e.target.value.replace(/\D/g, '').slice(0, SIGNER_DIGITS) }))}
              onBlur={() => setTouched((t) => ({ ...t, signerPhone: true }))}
            />
          </span>
          {shown('signerPhone') ? <span className="text-xs text-[var(--swift-red)]">{shown('signerPhone')}</span> : null}
        </label>
        <button type="submit" className="sw-btn" disabled={!state.canSubmit || ask.isPending}>{ask.isPending ? 'Sending…' : ESIGN_SEND}</button>
        {failed ? <p role="alert" className="text-sm text-[var(--swift-red)]">{letterErrorLine(failed)}</p> : null}
        <p className="text-xs text-[var(--swift-muted)]">{ESIGN_PAPER_FALLBACK}</p>
      </form>
    </section>
  );
}
