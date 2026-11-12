'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DataUnavailable } from '@/components/data-unavailable';
import { useStoreRole } from '@/lib/store-role';
import { getStoreDocumentStatus, type StoreUploadConsentVia } from '@/lib/store-documents-api';
import { DOCUMENT_CONSENT_TEXT, docLabel, documentConsentGivenLine, documentConsentOnRecord, type StoreDocumentRow } from '@/lib/store-documents';
import { AUTHORITY_LETTER_LINK, AUTHORITY_LETTER_PATHS, accountPaperHint } from '@/lib/business-basis';
import { OWN_NAME_DECLARATION_WEB, OWN_NAME_TICK } from '@/lib/own-name-copy';
import {
  ASK_BUTTON, BUSINESS_TYPE_TITLE, HANDOVER_IN_APP, KEEPS_SELLING, WITHDRAW_BUTTON, changeStatusLine, getAccountChange, optionWords, paperStateWords,
  signOwnNameForChange, startBusinessTypeChange, withdrawAccountChange, type BusinessTypeOption, type ChangePaper,
} from '@/lib/account-change-api';
import { DocumentCard } from '../../documents/document-card';

const KEY = ['account-change'] as const;
const OWN_NAME_DOC = 'own_name_declaration';
const errorWords = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/**
 * [COMPANY-DOCS Part 3 · owner ruling 10 Nov 2026 (c)] Account → Change business type, as the phone's: the account holder
 * picks the right kind of business and uploads that answer's papers; a person at Swift checks them and the change. The
 * store keeps selling on its old papers meanwhile; refused, nothing changes and the store reads why. OWNER only.
 */
export default function BusinessTypePage() {
  const { role, known, failed } = useStoreRole();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: getAccountChange, enabled: known && role === 'OWNER' });
  const [picked, setPicked] = useState<BusinessTypeOption | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const start = useMutation({ mutationFn: (option: BusinessTypeOption) => startBusinessTypeChange(option), onSuccess: refresh });
  const withdraw = useMutation({ mutationFn: (id: string) => withdrawAccountChange(id), onSuccess: refresh });
  const data = q.data;
  const change = data?.change ?? null;
  const pending = change?.status === 'PENDING' && change.kind === 'BUSINESS_TYPE' ? change : null;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/dashboard/settings" className="text-sm font-semibold text-[var(--swift-red)]">Settings</Link>
        <h1 className="sw-title mt-1">{BUSINESS_TYPE_TITLE}</h1>
      </div>
      {failed ? (
        <DataUnavailable what="who holds this account" error={null} onRetry={() => window.location.reload()} />
      ) : !known ? (
        <p role="status" className="text-sm text-[var(--swift-muted)]">Loading…</p>
      ) : role !== 'OWNER' ? (
        <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">Only the account holder can change the business type.</p>
      ) : q.isError ? (
        <DataUnavailable what="your business type" error={q.error} onRetry={() => void q.refetch()} />
      ) : !data ? (
        <p role="status" className="text-sm text-[var(--swift-muted)]">Loading…</p>
      ) : (
        <>
          <section className="sw-card p-6">
            <p className="text-sm text-[var(--swift-muted)]">Your business type now</p>
            <p className="mt-1 font-bold">{optionWords(data.current)}</p>
          </section>
          {change && change.kind === 'BUSINESS_TYPE' ? (
            <section className="sw-card space-y-2 p-6" aria-live="polite">
              <p>{changeStatusLine(change)}</p>
              {pending ? <p className="text-sm text-[var(--swift-muted)]">{KEEPS_SELLING}</p> : null}
            </section>
          ) : null}
          {pending ? (
            <>
              <ChangePapers papers={pending.papers} onSent={refresh} />
              <button type="button" className="sw-chip" disabled={withdraw.isPending} onClick={() => withdraw.mutate(pending.id)}>{WITHDRAW_BUTTON}</button>
              {withdraw.isError ? <p role="alert" className="text-sm text-[var(--swift-red)]">{errorWords(withdraw.error, 'Couldn’t withdraw the change. Try again.')}</p> : null}
            </>
          ) : change?.status === 'PENDING' ? (
            <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">A handover of this account is waiting. Withdraw it in the app first to change the business type.</p>
          ) : (
            <section className="sw-card space-y-3 p-6">
              <h2 className="font-bold">Change it to</h2>
              <div role="radiogroup" aria-label="Change it to" className="space-y-2">
                {data.options.map((option) => (
                  <label key={option} className="flex items-start gap-3 text-sm">
                    <input type="radio" name="business-type" checked={picked === option} onChange={() => setPicked(option)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
                    <span>{optionWords(option)}</span>
                  </label>
                ))}
              </div>
              <p className="text-sm text-[var(--swift-muted)]">{KEEPS_SELLING}</p>
              <button type="button" className="sw-btn" disabled={!picked || start.isPending} onClick={() => { if (picked) start.mutate(picked); }}>{ASK_BUTTON}</button>
              {start.isError ? <p role="alert" className="text-sm text-[var(--swift-red)]">{errorWords(start.error, 'Couldn’t ask for the change. Try again.')}</p> : null}
            </section>
          )}
          {data.handoverOpen ? <p className="text-sm text-[var(--swift-muted)]">{HANDOVER_IN_APP}</p> : null}
        </>
      )}
    </div>
  );
}

/** The change's papers, as the Documents page draws them (one consent tick above; each paper filed under its kind). */
function ChangePapers({ papers, onSent }: { papers: ChangePaper[]; onSent: () => void }) {
  const firstRole = papers[0]?.role ?? 'STORE';
  const status = useQuery({ queryKey: ['account-change', 'consent', firstRole], queryFn: () => getStoreDocumentStatus(firstRole) });
  const [choice, setChoice] = useState<boolean | null>(null);
  const record = documentConsentOnRecord(status.data);
  const consented = choice ?? record.given;
  const recordLine = choice === null && record.given ? documentConsentGivenLine(record.givenAt) : null;
  const consentVia: StoreUploadConsentVia = choice === true ? 'checkbox' : 'record';
  const asDoc = (paper: ChangePaper): StoreDocumentRow | undefined => paper.state === 'MISSING' ? undefined
    : { id: paper.documentId ?? paper.docType, docType: paper.docType, status: paper.state, expiresAt: null, reviewNote: paper.note, createdAt: new Date(0).toISOString() };
  return (
    <section aria-label="The new papers" className="space-y-3">
      <label className="flex items-start gap-3 rounded-2xl border border-[var(--swift-border)] p-4 text-sm">
        <input type="checkbox" checked={consented} onChange={() => setChoice((c) => !(c ?? record.given))} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
        <span>
          <span className="text-[var(--swift-muted)]">{DOCUMENT_CONSENT_TEXT}</span>
          {recordLine ? <span className="mt-1 block text-xs text-[var(--swift-muted)]">{recordLine}</span> : null}
        </span>
      </label>
      {papers.map((paper) => paper.docType === OWN_NAME_DOC ? (
        <OwnNameForChange key={paper.docType} paper={paper} onDone={onSent} />
      ) : (
        <DocumentCard
          key={paper.docType}
          role={paper.role}
          docType={paper.docType}
          doc={asDoc(paper)}
          isNext={false}
          hint={paper.forChange || paper.state !== 'APPROVED' ? accountPaperHint(paper.docType) : 'Already on file: nothing to upload.'}
          hintLink={AUTHORITY_LETTER_PATHS[paper.docType] ? { label: AUTHORITY_LETTER_LINK, href: AUTHORITY_LETTER_PATHS[paper.docType]! } : undefined}
          consented={consented}
          consentVia={consentVia}
          onSent={onSent}
        />
      ))}
    </section>
  );
}

function OwnNameForChange({ paper, onDone }: { paper: ChangePaper; onDone: () => void }) {
  const [ticked, setTicked] = useState(false);
  const sign = useMutation({ mutationFn: () => signOwnNameForChange('v1'), onSuccess: onDone });
  if (paper.state === 'APPROVED' || paper.state === 'PENDING') {
    return (
      <div className="sw-card p-5">
        <p className="font-semibold">{docLabel(paper.docType)}</p>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">{paperStateWords(paper.state)}</p>
      </div>
    );
  }
  return (
    <div className="sw-card space-y-3 p-5">
      <p className="font-semibold">Sign: I trade under my own name</p>
      {paper.note ? <p role="alert" className="text-sm text-[var(--swift-red)]">{paper.note}</p> : null}
      <pre className="whitespace-pre-wrap text-sm">{OWN_NAME_DECLARATION_WEB}</pre>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={ticked} onChange={() => setTicked((t) => !t)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
        <span>{OWN_NAME_TICK}</span>
      </label>
      <button type="button" className="sw-btn" disabled={!ticked || sign.isPending} onClick={() => sign.mutate()}>Sign the declaration</button>
      {sign.isError ? <p role="alert" className="text-sm text-[var(--swift-red)]">{errorWords(sign.error, 'Couldn’t sign the declaration. Try again.')}</p> : null}
    </div>
  );
}
