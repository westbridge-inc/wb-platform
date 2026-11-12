import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { Card, DialCodeChip, LabeledInput, LinkText, PillButton, T } from '../../kit';
import { vendorApi } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import {
  ESIGN_CANCEL, ESIGN_PAPER_FALLBACK, ESIGN_SEND, SIGNER_DIGITS, esignFieldLabels, esignIntro, esignOffered, esignTitle, letterErrorLine, letterFormState,
  letterRequestFor, letterStatusLine, resendState, type LetterField,
} from '../../lib/authorityLetterCopy';

const EMPTY = { businessName: '', registrationNumber: '', requesterName: '', requesterRole: '', signerName: '', signerDigits: '' };
const TEXT_FIELDS: Array<Exclude<LetterField, 'signerPhone'>> = ['businessName', 'registrationNumber', 'requesterName', 'requesterRole', 'signerName'];

/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] Under the letter of authority on the store's Documents checklist:
 * "Ask a director (the owner) to sign in Swift". A short form; Swift writes the one-page letter and texts the signer a
 * link they open on their own phone (no app, no account); then where it stands ("Waiting for Devon to sign"), with
 * resend and cancel. The server decides everything (the phone rule, the limits); the paper upload stays above it.
 * The app never opens the signing page itself: the link goes only to the signer, by text.
 */
export function AuthorityLetterEsignCard({ role, docType, kind, docRejected = false, forChange = false }: {
  role: string; docType: string; kind: 'director' | 'owner';
  /** The letter on file was not accepted: the form is offered again. */
  docRejected?: boolean;
  /** [FOLLOWUPS-2475] On a business type change's papers (ChangePapersList): the letter the change asks for, named, since
   *  it is not the account's own (the server checks the change waiting asks for it). */
  forChange?: boolean;
}) {
  const qc = useQueryClient();
  const ownPhone = useAuthStore((s) => (s.user as { phone?: string } | null)?.phone ?? null);
  const read = useQuery({
    queryKey: ['authority-letter'],
    queryFn: () => vendorApi.authorityLetter().then((r) => r.data?.data),
    refetchInterval: (q) => ((q.state.data as { request?: { status?: string } } | undefined)?.request?.status === 'SENT' ? 20_000 : false),
  });
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<LetterField, boolean>>>({});
  const labels = esignFieldLabels(kind);
  const state = letterFormState({ ...form, ownPhone }, kind);
  const settle = () => void qc.invalidateQueries({ queryKey: ['authority-letter'] });
  const ask = useMutation({ mutationFn: () => vendorApi.askAuthorityLetter(forChange ? { ...state.body, docType } : state.body), onSuccess: () => { setForm(EMPTY); setTouched({}); settle(); } });
  const resend = useMutation({ mutationFn: (id: string) => vendorApi.resendAuthorityLetter(id), onSuccess: settle });
  const cancel = useMutation({ mutationFn: (id: string) => vendorApi.cancelAuthorityLetter(id), onSuccess: settle });

  const newest = letterRequestFor(docType, read.data);
  const request = newest && !(newest.status === 'SIGNED' && docRejected) ? newest : null;
  const failed = ask.error ?? resend.error ?? cancel.error;
  // Signed while this screen was open: the checklist reads the filed letter (once).
  const told = useRef(false);
  useEffect(() => {
    if (request?.status === 'SIGNED' && !told.current) {
      told.current = true;
      void qc.invalidateQueries({ queryKey: ['verification', role] });
    }
  }, [request?.status, qc, role]);

  if (read.isLoading) return null;
  // Switched off (until the owner approves the privacy wording) or an older server: the paper letter only.
  if (!request && !esignOffered(read.data)) return null;
  if (request) {
    const again = resendState(request);
    return (
      <Card style={{ marginTop: space.sm, gap: space.sm }}>
        <T variant="label" weight="bold">{esignTitle(kind)}</T>
        <T variant="caption" tone="muted" accessibilityRole="text" accessibilityLiveRegion="polite">{letterStatusLine(request)}</T>
        {request.status !== 'SIGNED' ? (
          <View style={{ gap: space.sm }}>
            <PillButton label={again.label} variant="soft" size="sm" disabled={!again.allowed} loading={resend.isPending} onPress={() => resend.mutate(request.id)} />
            <LinkText label={ESIGN_CANCEL} tone="muted" disabled={cancel.isPending} onPress={() => cancel.mutate(request.id)} />
          </View>
        ) : null}
        {failed ? <T variant="caption" tone="error">{letterErrorLine(failed)}</T> : null}
      </Card>
    );
  }

  const shown = (field: LetterField) => (touched[field] ? state.errors[field] : undefined);
  return (
    <Card style={{ marginTop: space.sm, gap: space.sm }}>
      <T variant="label" weight="bold">{esignTitle(kind)}</T>
      <T variant="caption" tone="muted">{esignIntro(kind)}</T>
      {TEXT_FIELDS.map((field) => (
        <LabeledInput
          key={field}
          label={labels[field]}
          value={form[field]}
          autoCapitalize={field === 'registrationNumber' ? 'characters' : 'words'}
          error={shown(field)}
          onChangeText={(v) => setForm((f) => ({ ...f, [field]: v }))}
          onBlur={() => setTouched((t) => ({ ...t, [field]: true }))}
        />
      ))}
      <LabeledInput
        label={labels.signerPhone}
        value={form.signerDigits}
        keyboardType="number-pad"
        maxLength={SIGNER_DIGITS}
        error={shown('signerPhone')}
        right={<DialCodeChip countryCode="GY" dialCode="+592" countryName="Guyana" />}
        onChangeText={(v) => setForm((f) => ({ ...f, signerDigits: v.replace(/\D/g, '').slice(0, SIGNER_DIGITS) }))}
        onBlur={() => setTouched((t) => ({ ...t, signerPhone: true }))}
      />
      <PillButton label={ESIGN_SEND} disabled={!state.canSubmit} loading={ask.isPending} onPress={() => ask.mutate()} />
      {failed ? <T variant="caption" tone="error">{letterErrorLine(failed)}</T> : null}
      <T variant="micro" tone="muted">{ESIGN_PAPER_FALLBACK}</T>
    </Card>
  );
}
