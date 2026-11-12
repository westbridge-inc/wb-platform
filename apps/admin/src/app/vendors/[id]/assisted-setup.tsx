'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyAssistedMenu, fetchAssistedSetup, previewAssistedMenuCsv, previewAssistedMenuXlsx, recordAssistedConsent, uploadAssistedItemPhoto,
  uploadAssistedPaper, errorCode, errorDetails, type AssistedAgreedAs, type AssistedChannel, type AssistedConsent, type AssistedPaper,
  type AssistedSetupView, type MenuColumnChoice, type MenuPreview,
} from '@/lib/api';
import { documentName } from '@/components/mc/ActivationChecklist';
import { MutationError } from '@/components/MutationError';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { gyDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [ASSISTED SETUP · owner 12 Nov 2026] On a store's page: set the store up FOR it, with its OK.
//
// 1. Record the store's OK (who agreed: the account holder or a manager; how, when, a reference), after reading it the words.
// 2. Upload its papers: its own required and optional list, each filed exactly as if the store sent it.
// 3. Import its menu: preview first (the row errors the store itself would see), then apply.
// 4. Add item photos.
// Every step asks why (the record keeps it) and is done under the admin's own name with the OK named. A paper you upload
// must be approved by another admin when there is one.
// ---------------------------------------------------------------------------

export const ASSISTED_CHANNEL_WORDS: Record<AssistedChannel, string> = {
  IN_PERSON: 'In person',
  PHONE: 'Phone call',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
};

/** [#2495 review] Who said yes, as a choice. A person's own papers (an ID) need the account holder's own OK. */
export const ASSISTED_AGREED_AS_WORDS: Record<AssistedAgreedAs, string> = {
  ACCOUNT_HOLDER: 'The account holder themself',
  MANAGER: 'A manager at the store',
};

/** What the panel says on a step the store signs, ticks or consents to itself (no upload offered). */
export const STORE_DOES_THIS_ITSELF = 'The store does this itself, in the Swift app or on the website.';
/** On a person's own paper while the OK covering today is a manager's. */
export const NEEDS_HOLDER_OK = 'A person’s own paper: Swift adds it only with the account holder’s own OK.';

/** A refusal that means the OK no longer covers today (14 days passed, or the account changed hands): read it again. */
export const OK_ENDED_CODES: ReadonlySet<string> = new Set(['ASSISTED_CONSENT_REQUIRED']);

export const ASSISTED_SAME_ADMIN_NOTE =
  'A paper you upload here must be approved by another admin. If you are the only admin, the Review Center asks you to confirm you checked it yourself.';

/** The OK that covers what is done now: the newest one still within its days, for the store's current account holder. */
export function liveConsentOf(consents: readonly AssistedConsent[]): AssistedConsent | null {
  return consents.find((c) => c.live) ?? null;
}

/** A paper's place on the store's list, from the newest copy the store has of that type. [#2495 review B S3-1] An expired
 *  copy says so, and an approved copy the gate still counts as missing (past its date) is out of date. */
export function paperState(docType: string, documents: readonly AssistedPaper[], missing: readonly string[] = []): { words: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; addedBySwift: boolean } {
  const doc = documents.find((d) => d.docType === docType);
  if (!doc) return { words: 'Not sent yet', tone: 'neutral', addedBySwift: false };
  const addedBySwift = doc.addedBySwift === true;
  if (doc.status === 'EXPIRED') return { words: 'Expired', tone: 'bad', addedBySwift };
  if (doc.status === 'APPROVED') return missing.includes(docType) ? { words: 'Out of date', tone: 'bad', addedBySwift } : { words: 'Approved', tone: 'good', addedBySwift };
  if (doc.status === 'REJECTED') return { words: 'Rejected', tone: 'bad', addedBySwift };
  return { words: 'Waiting for review', tone: 'warn', addedBySwift };
}

/** One OK in words: who (their name, as the admin typed it, and who they are), how, when, the reference. */
export function consentLine(c: AssistedConsent): string {
  const who = `${c.agreedByName} (${(ASSISTED_AGREED_AS_WORDS[c.agreedAs] ?? 'Someone at the store').toLowerCase()})`;
  return `${who}, ${ASSISTED_CHANNEL_WORDS[c.channel].toLowerCase()}, ${gyDate(c.agreedAt)}${c.reference ? ` · ${c.reference}` : ''}`;
}

const nowLocal = () => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

function ConsentStep({ view, vendorId, onDone }: { view: AssistedSetupView; vendorId: string; onDone: () => void }) {
  const dialog = useActionDialog();
  const [name, setName] = useState('');
  const [agreedAs, setAgreedAs] = useState<AssistedAgreedAs | ''>('');
  const [channel, setChannel] = useState<AssistedChannel>('IN_PERSON');
  const [agreedAt, setAgreedAt] = useState(nowLocal);
  const [reference, setReference] = useState('');
  const [read, setRead] = useState(false);
  const record = useMutation({
    mutationFn: async () => {
      const reason = await dialog.ask({ action: 'record this store’s OK for Swift to set it up', subject: view.store.name });
      if (!reason) return null;
      return recordAssistedConsent(vendorId, {
        agreedByName: name.trim(), agreedAs: agreedAs as AssistedAgreedAs, channel, agreedAt: new Date(agreedAt).toISOString(),
        ...(reference.trim() ? { reference: reference.trim() } : {}), consentVersion: view.script.consentVersion,
      }, reason);
    },
    onSuccess: (result) => { if (result) { setName(''); setAgreedAs(''); setReference(''); setRead(false); onDone(); } },
  });
  const ready = name.trim().length >= 2 && agreedAs !== '' && read && !!agreedAt;
  return (
    <div className="grid gap-3">
      <h3 className="font-semibold">1. The store’s OK</h3>
      <p className="mc-muted text-sm">Ask the store, and read it these words. Record who said yes. An OK covers {view.validDays} days.</p>
      <blockquote className="mc-card" style={{ margin: 0 }}>
        <p className="font-semibold">{view.script.question}</p>
        <p className="mt-2">“{view.script.consentText}”</p>
      </blockquote>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="mc-field">Who agreed (their name)<input className="mc-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
        <label className="mc-field">Who they are<select className="mc-input" value={agreedAs} onChange={(e) => setAgreedAs(e.target.value as AssistedAgreedAs | '')}>
          <option value="">Choose…</option>
          {(Object.keys(ASSISTED_AGREED_AS_WORDS) as AssistedAgreedAs[]).map((a) => <option key={a} value={a}>{ASSISTED_AGREED_AS_WORDS[a]}</option>)}
        </select></label>
        <label className="mc-field">How<select className="mc-input" value={channel} onChange={(e) => setChannel(e.target.value as AssistedChannel)}>
          {(Object.keys(ASSISTED_CHANNEL_WORDS) as AssistedChannel[]).map((c) => <option key={c} value={c}>{ASSISTED_CHANNEL_WORDS[c]}</option>)}
        </select></label>
        <label className="mc-field">When<input className="mc-input" type="datetime-local" value={agreedAt} onChange={(e) => setAgreedAt(e.target.value)} /></label>
        <label className="mc-field sm:col-span-2">Reference (optional)<input className="mc-input" value={reference} maxLength={120} placeholder="A message or call reference" onChange={(e) => setReference(e.target.value)} /></label>
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
        I read these words to them and they said yes.</label>
      <MutationError error={record.error} label="The OK was not recorded" />
      <div><button type="button" className="mc-btn mc-btn-primary" disabled={!ready || record.isPending} onClick={() => record.mutate()}>
        {record.isPending ? 'Recording…' : 'Record the store’s OK…'}</button></div>
      {view.consents.length > 0 ? (
        <ul className="grid gap-1 text-sm">
          {view.consents.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className={`mc-badge${c.live ? ' mc-tone-good' : ''}`}>{c.live ? 'Covers today' : 'Ended'}</span>
              <span>{consentLine(c)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PapersStep({ view, vendorId, consent, onDone }: { view: AssistedSetupView; vendorId: string; consent: AssistedConsent | null; onDone: () => void }) {
  const consentId = consent?.id ?? null;
  const dialog = useActionDialog();
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async (docType: string) => {
      const file = files[docType];
      if (!file || !consentId) return null;
      const reason = await dialog.ask({ action: `upload the ${documentName(docType).toLowerCase()} for the store`, subject: view.store.name });
      if (!reason) return null;
      await uploadAssistedPaper(vendorId, consentId, docType, file, file.name, reason);
      return docType;
    },
    onSuccess: (docType) => {
      if (!docType) return;
      setFiles((f) => ({ ...f, [docType]: null }));
      setNotice(`${documentName(docType)} sent. It waits in the Review Center. ${ASSISTED_SAME_ADMIN_NOTE}`);
      onDone();
    },
    // [#2495 review S4] An OK that ended while the panel was open: read it again, so it says "Ended".
    onError: (error) => { if (OK_ENDED_CODES.has(errorCode(error) ?? '')) onDone(); },
  });
  const storeOnly = new Set(view.papers.storeOnly ?? []);
  const personal = new Set(view.papers.personal ?? []);
  const list: Array<{ docType: string; required: boolean }> = [
    ...view.papers.checklist.map((docType) => ({ docType, required: true })),
    ...view.papers.optional.filter((d) => !view.papers.checklist.includes(d)).map((docType) => ({ docType, required: false })),
  ];
  return (
    <div className="grid gap-3">
      <h3 className="font-semibold">2. Papers</h3>
      <p className="mc-muted text-sm">The store’s own list. Each paper is filed as if the store sent it, with your name and the OK on the record. {ASSISTED_SAME_ADMIN_NOTE}</p>
      {notice ? <p className="mc-muted text-sm" role="status">{notice}</p> : null}
      <ul className="grid gap-2">
        {list.map(({ docType, required }) => {
          const state = paperState(docType, view.papers.documents, view.papers.missing);
          const own = storeOnly.has(docType);
          // A person's own paper only on the account holder's own OK.
          const needsHolder = personal.has(docType) && consent !== null && consent.agreedAs !== 'ACCOUNT_HOLDER';
          return (
            <li key={docType} className={`mc-doc mc-doc-${state.tone}`}>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{documentName(docType)} <span className="mc-muted text-xs">{required ? 'Required' : 'Optional'}</span></p>
                {state.addedBySwift ? <p className="mc-muted text-xs">Added by Swift with the store’s OK</p> : null}
                {own ? <p className="mc-muted text-xs">{STORE_DOES_THIS_ITSELF}</p> : null}
                {needsHolder ? <p className="mc-muted text-xs">{NEEDS_HOLDER_OK}</p> : null}
                {own ? null : (
                  <input aria-label={`File for ${documentName(docType)}`} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={!consentId || needsHolder}
                    onChange={(e) => setFiles((f) => ({ ...f, [docType]: e.target.files?.[0] ?? null }))} />
                )}
              </div>
              <span className={`mc-badge${state.tone === 'neutral' ? '' : ` mc-tone-${state.tone}`}`}>{state.words}</span>
              {own ? null : <button type="button" className="mc-btn" disabled={!consentId || needsHolder || !files[docType] || upload.isPending} onClick={() => upload.mutate(docType)}>Upload…</button>}
            </li>
          );
        })}
      </ul>
      <MutationError error={upload.error} label="The paper was not sent" />
    </div>
  );
}

/** [#2495 review B S3-2] The columns a menu file must have, in words, for the column picker. */
export const MENU_FIELD_WORDS: Record<string, string> = { name: 'Item name', basePrice: 'Price', category: 'Section' };

/** What the server asks for when it cannot read a file by itself: a till store to choose, or columns to pick. */
export function menuQuestion(error: unknown): { tillStores: string[] } | { headers: string[]; unmapped: string[] } | null {
  const code = errorCode(error);
  const details = errorDetails(error) ?? {};
  if (code === 'CHOOSE_TILL_STORE' && Array.isArray(details['stores'])) return { tillStores: details['stores'] as string[] };
  if (code === 'UNMAPPED_COLUMNS' && Array.isArray(details['headers'])) {
    const mapping = (details['mapping'] ?? {}) as Record<string, string>;
    return { headers: (details['headers'] as string[]).filter(Boolean), unmapped: Object.keys(MENU_FIELD_WORDS).filter((f) => !mapping[f]) };
  }
  return null;
}

function MenuStep({ view, vendorId, consentId, onDone }: { view: AssistedSetupView; vendorId: string; consentId: string | null; onDone: () => void }) {
  const dialog = useActionDialog();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<MenuPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The store's own choices, as its own import asks them: its till store, and the columns it picks.
  const [choice, setChoice] = useState<MenuColumnChoice>({});
  const read = useMutation({
    mutationFn: async () => {
      if (!file || !consentId) return null;
      const isXlsx = /\.xlsx$/i.test(file.name);
      const answer = isXlsx ? await previewAssistedMenuXlsx(vendorId, consentId, file, file.name, choice) : await previewAssistedMenuCsv(vendorId, consentId, await file.text(), choice);
      return answer.data;
    },
    onSuccess: (data) => { setPreview(data ?? null); setNotice(null); },
    onError: (error) => { if (OK_ENDED_CODES.has(errorCode(error) ?? '')) onDone(); },
  });
  const question = read.isError ? menuQuestion(read.error) : null;
  const apply = useMutation({
    mutationFn: async () => {
      if (!preview || !consentId) return null;
      const reason = await dialog.ask({ action: `import ${preview.plan.imported} menu items for the store`, subject: view.store.name });
      if (!reason) return null;
      return (await applyAssistedMenu(vendorId, consentId, preview.automap.normalizedCsv, reason)).data;
    },
    onSuccess: (result) => {
      if (!result) return;
      setPreview(null); setFile(null);
      setNotice(`Added ${result.imported} item${result.imported === 1 ? '' : 's'}.${result.failedCount ? ` ${result.failedCount} row${result.failedCount === 1 ? ' was' : 's were'} not added.` : ''}`);
      onDone();
    },
    onError: (error) => { if (OK_ENDED_CODES.has(errorCode(error) ?? '')) onDone(); },
  });
  return (
    <div className="grid gap-3">
      <h3 className="font-semibold">3. Menu</h3>
      <p className="mc-muted text-sm">A CSV or Excel file. Preview it first: you see what would be added and every row the store’s own import would refuse. Nothing is added until you apply it.</p>
      {!view.canAddItems ? <p className="mc-verdict mc-verdict-warn">This store cannot add new items until its papers are approved. You can preview a file now and apply it after.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Menu file" type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={!consentId}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setChoice({}); }} />
        <button type="button" className="mc-btn" disabled={!consentId || !file || read.isPending} onClick={() => read.mutate()}>{read.isPending ? 'Reading…' : 'Preview'}</button>
      </div>
      <MutationError error={read.error} label="The file could not be read" />
      {question && 'tillStores' in question ? (
        <label className="mc-field">Which till store is this Swift store?<select className="mc-input" value={choice.tillStore ?? ''} onChange={(e) => setChoice((c) => ({ ...c, tillStore: e.target.value || undefined }))}>
          <option value="">Choose…</option>
          {question.tillStores.map((t) => <option key={t} value={t}>{t}</option>)}
        </select></label>
      ) : null}
      {question && 'headers' in question ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {question.unmapped.map((field) => (
            <label key={field} className="mc-field">{MENU_FIELD_WORDS[field]} column<select className="mc-input" value={choice.mapping?.[field] ?? ''}
              onChange={(e) => setChoice((c) => ({ ...c, mapping: { ...(c.mapping ?? {}), [field]: e.target.value } }))}>
              <option value="">Choose…</option>
              {question.headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select></label>
          ))}
        </div>
      ) : null}
      {question ? <div><button type="button" className="mc-btn" disabled={read.isPending} onClick={() => read.mutate()}>Preview again with these choices</button></div> : null}
      {preview ? (
        <div className="grid gap-2">
          <p className="text-sm"><strong>{preview.plan.imported}</strong> item{preview.plan.imported === 1 ? '' : 's'} would be added; <strong>{preview.plan.failedCount}</strong> row{preview.plan.failedCount === 1 ? '' : 's'} would not.</p>
          {preview.plan.failures.length > 0 ? (
            <ul className="grid gap-1 text-sm" aria-label="Rows that would not be added">
              {preview.plan.failures.map((f) => <li key={f.row}><span className="mc-badge mc-tone-bad">Row {f.row}</span> {f.errors.join('; ')}</li>)}
            </ul>
          ) : null}
          {preview.plan.rows.length > 0 ? (
            <ul className="grid gap-1 text-sm" aria-label="Items that would be added">
              {preview.plan.rows.map((r) => <li key={r.row}>Row {r.row}: {r.name} · {r.category} · <span className="mc-numbers">G${r.basePrice.toLocaleString('en-GY')}</span></li>)}
            </ul>
          ) : null}
          {preview.plan.notes.length > 0 ? <ul className="grid gap-1 text-xs mc-muted">{preview.plan.notes.map((n) => <li key={n.row}>Row {n.row}: {n.note}</li>)}</ul> : null}
          <div><button type="button" className="mc-btn mc-btn-primary" disabled={!view.canAddItems || preview.plan.imported === 0 || apply.isPending} onClick={() => apply.mutate()}>
            {apply.isPending ? 'Adding…' : 'Apply…'}</button></div>
        </div>
      ) : null}
      {notice ? <p className="mc-muted text-sm" role="status">{notice}</p> : null}
      <MutationError error={apply.error} label="The menu was not imported" />
    </div>
  );
}

function PhotosStep({ data, vendorId, consentId, onDone }: { data: AssistedSetupView; vendorId: string; consentId: string | null; onDone: () => void }) {
  const view = data;
  const dialog = useActionDialog();
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const upload = useMutation({
    mutationFn: async (item: { id: string; name: string }) => {
      const file = files[item.id];
      if (!file || !consentId) return null;
      const reason = await dialog.ask({ action: `add a photo of ${item.name} for the store`, subject: view.store.name });
      if (!reason) return null;
      await uploadAssistedItemPhoto(vendorId, consentId, item.id, file, file.name, reason);
      return item.id;
    },
    onSuccess: (id) => { if (id) { setFiles((f) => ({ ...f, [id]: null })); onDone(); } },
    onError: (error) => { if (OK_ENDED_CODES.has(errorCode(error) ?? '')) onDone(); },
  });
  return (
    <div className="grid gap-3">
      <h3 className="font-semibold">4. Item photos</h3>
      {data && data.items.length === 0 ? <p className="mc-muted text-sm">No items yet.</p> : (
        <ul className="grid gap-2">
          {view.items.map((item) => (
            <li key={item.id} className="mc-doc mc-doc-neutral">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{item.name} {item.category ? <span className="mc-muted text-xs">{item.category}</span> : null}</p>
                <p className="mc-muted text-xs">{item.photoAddedBySwiftAt ? `Photo added by Swift on ${gyDate(item.photoAddedBySwiftAt)}` : item.imageUrl ? 'Has the store’s own photo' : 'No photo'}</p>
                <input aria-label={`Photo for ${item.name}`} type="file" accept="image/jpeg,image/png,image/webp" disabled={!consentId}
                  onChange={(e) => setFiles((f) => ({ ...f, [item.id]: e.target.files?.[0] ?? null }))} />
              </div>
              <button type="button" className="mc-btn" disabled={!consentId || !files[item.id] || upload.isPending} onClick={() => upload.mutate(item)}>Add photo…</button>
            </li>
          ))}
        </ul>
      )}
      <MutationError error={upload.error} label="The photo was not added" />
    </div>
  );
}

export function AssistedSetupPanel({ vendorId }: { vendorId: string }) {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ['assisted-setup', vendorId], queryFn: () => fetchAssistedSetup(vendorId) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['assisted-setup', vendorId] });
    void queryClient.invalidateQueries({ queryKey: ['vendor-checklist', vendorId] });
  };
  // An answer without the panel's shape (an older server) is not drawn as an empty setup.
  const answer = view.data?.data;
  const data = answer && Array.isArray(answer.consents) && Array.isArray(answer.items) && answer.papers && answer.script ? answer : undefined;
  const malformed = view.isSuccess && !data;
  const consent = data ? liveConsentOf(data.consents) : null;
  return (
    <section aria-labelledby="assisted-setup" className="mc-card">
      <h2 id="assisted-setup" className="mc-label">Assisted setup</h2>
      <p className="mc-muted text-sm">Set this store up for it, with its OK: its papers, its menu and its item photos. Everything is recorded under your name.</p>
      {view.isError ? <QueryFailed what="the assisted setup" error={view.error} onRetry={() => void view.refetch()} /> : null}
      {malformed ? <p className="mc-muted text-sm">This server does not offer assisted setup yet.</p> : null}
      {!data && !view.isError && !malformed ? <p aria-busy="true" className="mc-muted">Loading…</p> : null}
      {data ? (
        <div className="grid gap-6 mt-3">
          <ConsentStep view={data} vendorId={vendorId} onDone={refresh} />
          {!consent ? <p className="mc-verdict mc-verdict-warn">Record the store’s OK first. Papers, menu and photos open after it.</p> : null}
          <PapersStep view={data} vendorId={vendorId} consent={consent} onDone={refresh} />
          <MenuStep view={data} vendorId={vendorId} consentId={consent?.id ?? null} onDone={refresh} />
          <PhotosStep data={data} vendorId={vendorId} consentId={consent?.id ?? null} onDone={refresh} />
        </div>
      ) : null}
    </section>
  );
}
