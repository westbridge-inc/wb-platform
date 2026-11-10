/** @jsxImportSource react */
import { View } from 'react-native';
import { space } from '@swift/ui';
import { Card, CheckRow, T } from '../../kit';
import {
  BUSINESS_NAME_CHOICE, OWN_NAME_CHOICE, OWN_NAME_DECLARATION_V1, OWN_NAME_HINT, OWN_NAME_QUESTION, OWN_NAME_TICK,
  ownNameDeclarationDisplay, ownNameSigningFor,
} from '../../lib/ownNameCopy';
import {
  COMPANY_CHOICE, COMPANY_HINT, MANAGER_HINT, MANAGER_TICK, PERSON_CHECKS, REGISTERED_HINT, SERVICE_OWNER_CHOICE, SERVICE_OWNER_HINT,
  basisChoicesFor, managerPathApplies, type SignupBasis,
} from '../../lib/businessBasisCopy';

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

export type NameBasis = SignupBasis;

/**
 * [ROLE-DOCS · owner 21 Oct 2026] The store sign-up's first question for a store asked for a business registration:
 * the law (Business Names (Registration) Act s.3) does not ask one person trading under their own name to register
 * it, so they sign a declaration instead. The server checks the name; a person checks the ID.
 * [OWNER-ASKS 9 Nov 2026] Every box says what it is: the choices are radio buttons with their words, and the
 * declaration's tick reads "I have read and agree to this declaration."
 * A tap on the choice already chosen reports nothing: the sign-up clears the declaration's tick on every reported
 * choice, so re-tapping "My own name" must not silently untick it (the website's radio does not fire either).
 * [COMPANY-DOCS · owner 10 Nov 2026] ONE choice with three options, in the owner's order: a registered company, a
 * registered business (with "I'm the manager, not the owner" under it), or my own name. Each says what it will upload.
 * A service business is offered the company and its owner (it has no registration, so no manager or own-name path).
 */
export function OwnNameChoiceCard({ storeName, nameBasis, ownNameTick, onNameBasis, onToggleTick, vendorType = 'STORE', managerNotOwner = false, onToggleManager }: {
  storeName: string;
  nameBasis: NameBasis;
  ownNameTick: boolean;
  onNameBasis: (basis: NameBasis) => void;
  onToggleTick: () => void;
  vendorType?: string;
  managerNotOwner?: boolean;
  onToggleManager?: () => void;
}) {
  const signingFor = ownNameSigningFor(storeName);
  const store = managerPathApplies(vendorType);
  const words: Record<NameBasis, string> = {
    COMPANY: COMPANY_CHOICE,
    REGISTERED: store ? BUSINESS_NAME_CHOICE : SERVICE_OWNER_CHOICE,
    OWN_NAME: OWN_NAME_CHOICE,
  };
  return (
    <Card style={{ marginTop: space.xl, gap: space.sm }}>
      <T variant="heading">{OWN_NAME_QUESTION}</T>
      {basisChoicesFor(vendorType).map((basis) => (
        <CheckRow
          key={basis}
          kind="radio"
          checked={nameBasis === basis}
          onToggle={() => { if (nameBasis !== basis) onNameBasis(basis); }}
          label={words[basis]}
        />
      ))}
      {nameBasis === 'COMPANY' ? <T variant="caption" tone="muted">{COMPANY_HINT}</T> : null}
      {nameBasis === 'REGISTERED' ? (
        store ? (
          <>
            <T variant="caption" tone="muted">{managerNotOwner ? MANAGER_HINT : REGISTERED_HINT}</T>
            {onToggleManager ? <CheckRow checked={managerNotOwner} onToggle={onToggleManager} label={MANAGER_TICK} /> : null}
          </>
        ) : <T variant="caption" tone="muted">{SERVICE_OWNER_HINT}</T>
      ) : null}
      {nameBasis === 'OWN_NAME' && store ? (
        <>
          <T variant="caption" tone="muted">{OWN_NAME_HINT}</T>
          {signingFor ? <T variant="caption" weight="bold">{signingFor}</T> : null}
          <OwnNameDeclarationText />
          <CheckRow checked={ownNameTick} onToggle={onToggleTick} label={OWN_NAME_TICK} />
        </>
      ) : null}
      <T variant="caption" tone="muted">{PERSON_CHECKS}</T>
    </Card>
  );
}
