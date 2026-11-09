/** @jsxImportSource react */
import { View } from 'react-native';
import { space } from '@swift/ui';
import { Card, CheckRow, T } from '../../kit';
import {
  BUSINESS_NAME_CHOICE, OWN_NAME_CHOICE, OWN_NAME_DECLARATION_V1, OWN_NAME_HINT, OWN_NAME_QUESTION, OWN_NAME_TICK,
  ownNameDeclarationDisplay, ownNameSigningFor,
} from '../../lib/ownNameCopy';

/**
 * [OWNER-ASKS 9 Nov 2026] The declaration as shown: a plain title and its version, then the signed words unchanged
 * (OWN_NAME_DECLARATION_V1 is still what is signed and versioned).
 */
export function OwnNameDeclarationText() {
  const shown = ownNameDeclarationDisplay(OWN_NAME_DECLARATION_V1);
  return (
    <View style={{ gap: space.xs }}>
      <T variant="label" weight="bold">{shown.title}</T>
      {shown.version ? <T variant="caption" tone="muted">{shown.version}</T> : null}
      <T variant="caption">{shown.body}</T>
    </View>
  );
}

export type NameBasis = 'OWN_NAME' | 'REGISTERED';

/**
 * [ROLE-DOCS · owner 21 Oct 2026] The store sign-up's first question for a store asked for a business registration:
 * the law (Business Names (Registration) Act s.3) does not ask one person trading under their own name to register
 * it, so they sign a declaration instead. The server checks the name; a person checks the ID.
 * [OWNER-ASKS 9 Nov 2026] Every box says what it is: the two choices are radio buttons with their words, and the
 * declaration's tick reads "I have read and agree to this declaration."
 * A tap on the choice already chosen reports nothing: the sign-up clears the declaration's tick on every reported
 * choice, so re-tapping "My own name" must not silently untick it (the website's radio does not fire either).
 */
export function OwnNameChoiceCard({ storeName, nameBasis, ownNameTick, onNameBasis, onToggleTick }: {
  storeName: string;
  nameBasis: NameBasis;
  ownNameTick: boolean;
  onNameBasis: (basis: NameBasis) => void;
  onToggleTick: () => void;
}) {
  const signingFor = ownNameSigningFor(storeName);
  return (
    <Card style={{ marginTop: space.xl, gap: space.sm }}>
      <T variant="heading">{OWN_NAME_QUESTION}</T>
      {(['OWN_NAME', 'REGISTERED'] as const).map((basis) => (
        <CheckRow
          key={basis}
          kind="radio"
          checked={nameBasis === basis}
          onToggle={() => { if (nameBasis !== basis) onNameBasis(basis); }}
          label={basis === 'OWN_NAME' ? OWN_NAME_CHOICE : BUSINESS_NAME_CHOICE}
        />
      ))}
      {nameBasis === 'OWN_NAME' ? (
        <>
          <T variant="caption" tone="muted">{OWN_NAME_HINT}</T>
          {signingFor ? <T variant="caption" weight="bold">{signingFor}</T> : null}
          <OwnNameDeclarationText />
          <CheckRow checked={ownNameTick} onToggle={onToggleTick} label={OWN_NAME_TICK} />
        </>
      ) : null}
    </Card>
  );
}
