import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { space } from '@swift/ui';
import { BrandCheckbox, Card, CheckRow, PillButton, T } from '../../kit';
import { DOCUMENT_CONSENT_TEXT } from '../../lib/uploadConsentCopy';
import { documentConsentGivenLine, documentConsentOnRecord } from './documentConsentRecord';
import { DocumentUploadCard } from './DocumentUploadCard';
import { OwnNameDeclarationText } from './OwnNameChoiceCard';
import { accountPaperHelp } from '../../lib/businessBasisCopy';
import { OWN_NAME_HINT, OWN_NAME_TICK } from '../../lib/ownNameCopy';
import { WEBSITE_URL } from '../../lib/websiteUrl';
import { paperStateWords, type ChangePaper } from '../../lib/accountChangeCopy';
import { useVerificationStatus } from '../../hooks/verification';
import { useSignOwnNameForChange } from '../../hooks/accountChange';
import { errorMessage } from '../../lib/apiError';

/** The server's own-name declaration code (OWN_NAME_DOC_TYPE): signed in the app, never uploaded. */
const OWN_NAME_DOC = 'own_name_declaration';

/**
 * [COMPANY-DOCS Part 3] The papers of a change waiting for a person: the new business type's (the account holder), or a
 * new account holder's (the person named). Each upload goes through the ordinary document path (POST
 * /verification/documents), which holds it for the change on the server — so whatever files a paper (this upload card,
 * or Part 2's in-app signed letter, which plugs in beside the letter rows exactly as on the Documents checklist) is held
 * the same way. The consent tick is the person's own, as on the Documents checklist.
 */
export function ChangePapersList({ papers, onChanged }: { papers: ChangePaper[]; onChanged: () => void }) {
  // The consent record is the person's own (any store kind reads it); each paper is filed under its own kind.
  const status = useVerificationStatus(papers[0]?.role ?? 'STORE');
  const [choice, setChoice] = useState<boolean | null>(null);
  const record = documentConsentOnRecord(status.data);
  const consented = choice ?? record.given;
  const recordLine = choice === null && record.given ? documentConsentGivenLine(record.givenAt) : null;
  // An upload refreshes the person's document status (useUploadDocument): the change's own list follows it.
  const seen = useRef(status.dataUpdatedAt);
  useEffect(() => {
    if (status.dataUpdatedAt !== seen.current) { seen.current = status.dataUpdatedAt; onChanged(); }
  }, [status.dataUpdatedAt, onChanged]);
  return (
    <View style={{ gap: space.sm }}>
      <Pressable
        onPress={() => setChoice((c) => !(c ?? record.given))}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consented }}
        accessibilityLabel={DOCUMENT_CONSENT_TEXT}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}
      >
        <BrandCheckbox checked={consented} onToggle={() => setChoice((c) => !(c ?? record.given))} />
        <View style={{ flex: 1 }}>
          <T variant="label" tone="muted">{DOCUMENT_CONSENT_TEXT}</T>
          {recordLine ? <T variant="micro" tone="muted">{recordLine}</T> : null}
        </View>
      </Pressable>
      {papers.map((paper) => paper.docType === OWN_NAME_DOC ? (
        <OwnNameForChange key={paper.docType} paper={paper} />
      ) : (
        <View key={paper.docType}>
          <DocumentUploadCard
            role={paper.role}
            docType={paper.docType}
            status={paper.state === 'MISSING' ? undefined : paper.state}
            reviewNote={paper.note}
            consented={consented}
            consentVia={choice === true ? 'checkbox' : 'record'}
            paperHelp={accountPaperHelp(paper.docType, WEBSITE_URL)}
          />
          {!paper.forChange && paper.state === 'APPROVED' ? <T variant="micro" tone="muted">Already on file: nothing to upload.</T> : null}
        </View>
      ))}
    </View>
  );
}

/** The own-name declaration for a change to "I trade under my own name": signed here, held for the change. */
function OwnNameForChange({ paper }: { paper: ChangePaper }) {
  const sign = useSignOwnNameForChange();
  const [ticked, setTicked] = useState(false);
  if (paper.state === 'APPROVED' || paper.state === 'PENDING') {
    return (
      <View style={{ paddingVertical: space.sm }}>
        <T variant="label" weight="bold">I trade under my own name</T>
        <T variant="caption" tone="muted">{paperStateWords(paper.state)}</T>
      </View>
    );
  }
  return (
    <Card style={{ gap: space.sm }}>
      <T variant="label" weight="bold">Sign: I trade under my own name</T>
      {paper.note ? <T variant="caption" tone="error">{paper.note}</T> : null}
      <T variant="caption" tone="muted">{OWN_NAME_HINT}</T>
      <OwnNameDeclarationText />
      <CheckRow checked={ticked} onToggle={() => setTicked((t) => !t)} label={OWN_NAME_TICK} />
      <PillButton label="Sign the declaration" disabled={!ticked} loading={sign.isPending} onPress={() => sign.mutate()} />
      {sign.isError ? <T variant="caption" tone="error">{errorMessage(sign.error, 'Couldn’t sign the declaration. Try again.')}</T> : null}
    </Card>
  );
}
