/** @jsxImportSource react */
import React, { useCallback, useState } from 'react';
import { ScrollView } from 'react-native';
import { space } from '@swift/ui';
import { Card, ErrorState, Header, LabeledInput, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { useAccountChange, useNameNewHolder, useWithdrawAccountChange } from '../../../hooks/accountChange';
import { useStepUp } from '../../../hooks/useStepUp';
import { isStepUpDismissed } from '../../../lib/stepUp';
import { errorMessage } from '../../../lib/apiError';
import {
  HANDOVER_BUTTON, HANDOVER_EXPLAIN, HANDOVER_MMG_NOTE, HANDOVER_NOT_APPLICABLE, HANDOVER_PHONE_LABEL, HANDOVER_TITLE, WITHDRAW_BUTTON, changeStatusLine,
} from '../../../lib/accountChangeCopy';

/**
 * [COMPANY-DOCS Part 3 · owner ruling 10 Nov 2026 (d)] A company's account holder names the person who will hold the
 * account next (a fresh "confirm it's you"). The person named says yes and files their own papers in their own app; a
 * person at Swift decides. Until then nothing changes, and the holder may withdraw it.
 */
export function VendorHandoverScreen() {
  const q = useAccountChange();
  const stepUp = useStepUp();
  const name = useNameNewHolder(stepUp.withStepUp);
  const withdraw = useWithdrawAccountChange();
  const [phone, setPhone] = useState('');
  const refetch = useCallback(() => { void q.refetch(); }, [q]);
  const data = q.data;
  const change = data?.change ?? null;
  const pending = change?.status === 'PENDING' && change.kind === 'HOLDER_HANDOVER' ? change : null;
  const otherPending = change?.status === 'PENDING' && change.kind !== 'HOLDER_HANDOVER';
  const nameError = name.isError && !isStepUpDismissed(name.error) ? errorMessage(name.error, 'Couldn’t name that person. Try again.') : null;

  return (
    <Screen>
      <Header title={HANDOVER_TITLE} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space['3xl'] }}>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState onRetry={refetch} message="Couldn't load your account." /> : null}
        {data && !data.handoverOpen ? <T variant="label">{HANDOVER_NOT_APPLICABLE}</T> : null}
        {data && data.handoverOpen ? (
          <>
            <Card style={{ gap: space.sm }}>
              <T variant="label">{HANDOVER_EXPLAIN}</T>
              <T variant="caption" tone="muted">{HANDOVER_MMG_NOTE}</T>
            </Card>
            {change && change.kind === 'HOLDER_HANDOVER' ? (
              <Card><T variant="label">{changeStatusLine(change)}</T></Card>
            ) : null}
            {pending ? (
              <>
                <PillButton label={WITHDRAW_BUTTON} variant="soft" loading={withdraw.isPending} onPress={() => withdraw.mutate(pending.id)} />
                {withdraw.isError ? <T variant="caption" tone="error">{errorMessage(withdraw.error, 'Couldn’t withdraw the handover. Try again.')}</T> : null}
              </>
            ) : otherPending ? (
              <T variant="caption" tone="muted">A change of business type is waiting. Withdraw it first to hand over the account.</T>
            ) : (
              <Card style={{ gap: space.sm }}>
                <LabeledInput label={HANDOVER_PHONE_LABEL} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="+592" />
                <PillButton label={HANDOVER_BUTTON} disabled={phone.trim().length < 8} loading={name.isPending} onPress={() => name.mutate(phone.trim())} />
                {nameError ? <T variant="caption" tone="error">{nameError}</T> : null}
              </Card>
            )}
          </>
        ) : null}
      </ScrollView>
      {stepUp.sheet}
    </Screen>
  );
}
