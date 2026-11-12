/** @jsxImportSource react */
import React, { useCallback } from 'react';
import { ScrollView, View } from 'react-native';
import { space } from '@swift/ui';
import { Card, ErrorState, Header, LoadingBlock, PillButton, Screen, T } from '../../../kit';
import { ChangePapersList } from '../../../components/onboarding/ChangePapersList';
import { useAnswerHandover, useHandoversNamingMe } from '../../../hooks/accountChange';
import { errorMessage } from '../../../lib/apiError';
import { NAMED_EXPLAIN, NAMED_NO, NAMED_TITLE, NAMED_WAITING, NAMED_YES, namedLine, type HandoverNamingMe } from '../../../lib/accountChangeCopy';

/**
 * [COMPANY-DOCS Part 3 · owner ruling 10 Nov 2026 (d)] A company named this person as its new account holder. They say
 * yes or no here; after a yes they upload their own papers (their ID, the new letter naming them, and the company's
 * papers), which a person at Swift checks. Only a person's approval moves the account to them.
 */
export function AccountHandoverScreen() {
  const q = useHandoversNamingMe();
  const refetch = useCallback(() => { void q.refetch(); }, [q]);
  return (
    <Screen>
      <Header title={NAMED_TITLE} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space['3xl'] }}>
        {q.isLoading ? <LoadingBlock /> : null}
        {q.isError ? <ErrorState onRetry={refetch} message="Couldn't load this." /> : null}
        {q.data && q.data.length === 0 && !q.isError ? <T variant="label">No account is waiting for you.</T> : null}
        {(q.data ?? []).map((handover) => <NamedHandover key={handover.id} handover={handover} onChanged={refetch} />)}
      </ScrollView>
    </Screen>
  );
}

function NamedHandover({ handover, onChanged }: { handover: HandoverNamingMe; onChanged: () => void }) {
  const answer = useAnswerHandover();
  return (
    <View style={{ gap: space.md }}>
      <Card style={{ gap: space.sm }}>
        <T variant="label" weight="bold">{namedLine(handover)}</T>
        <T variant="caption" tone="muted">{NAMED_EXPLAIN}</T>
        {handover.accepted && handover.papersComplete ? <T variant="label">{NAMED_WAITING}</T> : null}
      </Card>
      {!handover.accepted ? (
        <View style={{ gap: space.sm }}>
          <PillButton label={NAMED_YES} loading={answer.isPending && answer.variables?.accept === true} onPress={() => answer.mutate({ id: handover.id, accept: true })} />
          <PillButton label={NAMED_NO} variant="soft" loading={answer.isPending && answer.variables?.accept === false} onPress={() => answer.mutate({ id: handover.id, accept: false })} />
        </View>
      ) : (
        <>
          <ChangePapersList papers={handover.papers} onChanged={onChanged} />
          <PillButton label="I won’t hold the account after all" variant="soft" loading={answer.isPending} onPress={() => answer.mutate({ id: handover.id, accept: false })} />
        </>
      )}
      {answer.isError ? <T variant="caption" tone="error">{errorMessage(answer.error, 'That didn’t go through. Try again.')}</T> : null}
    </View>
  );
}
