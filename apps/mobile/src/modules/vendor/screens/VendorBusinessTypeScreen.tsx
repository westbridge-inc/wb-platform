/** @jsxImportSource react */
import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView } from 'react-native';
import { space } from '@swift/ui';
import { BrandCheckbox, Card, ErrorState, Header, LoadingBlock, PillButton, Screen, SettingsRow, T } from '../../../kit';
import { ChangePapersList } from '../../../components/onboarding/ChangePapersList';
import { useAccountChange, useStartBusinessTypeChange, useWithdrawAccountChange } from '../../../hooks/accountChange';
import { errorMessage } from '../../../lib/apiError';
import {
  ASK_BUTTON, BUSINESS_TYPE_TITLE, HANDOVER_ROW, HANDOVER_ROW_SUB, KEEPS_SELLING, WITHDRAW_BUTTON, changeStatusLine, optionWords,
  type BusinessTypeOption,
} from '../../../lib/accountChangeCopy';

/**
 * [COMPANY-DOCS Part 3 · owner ruling 10 Nov 2026 (c)] "Change business type" (Account, the account holder only): a store
 * that chose the wrong kind of business when it joined picks the right one and uploads that answer's papers. A person at
 * Swift checks them, then the change. The store keeps selling on its old papers meanwhile; refused, nothing changes and
 * the store reads why. A company's account is handed over from here too (VendorHandover).
 */
export function VendorBusinessTypeScreen({ navigation }: { navigation?: { navigate?: (s: string) => void } }) {
  const q = useAccountChange();
  const start = useStartBusinessTypeChange();
  const withdraw = useWithdrawAccountChange();
  const [picked, setPicked] = useState<BusinessTypeOption | null>(null);
  const refetch = useCallback(() => { void q.refetch(); }, [q]);
  const data = q.data;
  const change = data?.change ?? null;
  const pending = change?.status === 'PENDING' && change.kind === 'BUSINESS_TYPE' ? change : null;
  const handoverPending = change?.status === 'PENDING' && change.kind === 'HOLDER_HANDOVER';

  return (
    <Screen>
      <Header title={BUSINESS_TYPE_TITLE} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space['3xl'] }}>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState onRetry={refetch} message="Couldn't load your business type." /> : null}
        {data ? (
          <>
            <Card style={{ gap: space.xs }}>
              <T variant="label" tone="muted">Your business type now</T>
              <T variant="label" weight="bold">{optionWords(data.current)}</T>
            </Card>
            {change && change.kind === 'BUSINESS_TYPE' ? (
              <Card style={{ gap: space.sm }}>
                <T variant="label">{changeStatusLine(change)}</T>
                {pending ? <T variant="caption" tone="muted">{KEEPS_SELLING}</T> : null}
              </Card>
            ) : null}
            {pending ? (
              <>
                <ChangePapersList papers={pending.papers} onChanged={refetch} />
                <PillButton label={WITHDRAW_BUTTON} variant="soft" loading={withdraw.isPending} onPress={() => withdraw.mutate(pending.id)} />
                {withdraw.isError ? <T variant="caption" tone="error">{errorMessage(withdraw.error, 'Couldn’t withdraw the change. Try again.')}</T> : null}
              </>
            ) : handoverPending ? (
              <T variant="caption" tone="muted">A handover of this account is waiting. Withdraw it first to change the business type.</T>
            ) : (
              <Card style={{ gap: space.sm }}>
                <T variant="label" weight="bold">Change it to</T>
                {data.options.map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => setPicked(option)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: picked === option }}
                    accessibilityLabel={optionWords(option)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs }}
                  >
                    <BrandCheckbox checked={picked === option} onToggle={() => setPicked(option)} />
                    <T variant="label" style={{ flex: 1 }}>{optionWords(option)}</T>
                  </Pressable>
                ))}
                <T variant="caption" tone="muted">{KEEPS_SELLING}</T>
                <PillButton label={ASK_BUTTON} disabled={!picked} loading={start.isPending} onPress={() => { if (picked) start.mutate(picked); }} />
                {start.isError ? <T variant="caption" tone="error">{errorMessage(start.error, 'Couldn’t ask for the change. Try again.')}</T> : null}
              </Card>
            )}
            {data.handoverOpen ? (
              <Card style={{ paddingVertical: space.sm }}>
                <SettingsRow icon="users" label={HANDOVER_ROW} sub={HANDOVER_ROW_SUB} onPress={() => navigation?.navigate?.('VendorHandover')} />
              </Card>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
