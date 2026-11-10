'use client';

// [ROLE-DOCS · #2046 · perf] The own-name choice and the declaration's words (BNA s.3), loaded on the business
// step only for a store type that is asked for a business registration (own-name-loader.ts; page-size.test.ts).
// The page keeps the choice and the tick, and signs after the store exists; this block only shows them.
// [COMPANY-DOCS · owner rulings 10 Nov 2026] ONE choice with three options, in the owner's order and the phone's words
// (apps/mobile lib/businessBasisCopy): a registered company, a registered business (with "I'm the manager, not the
// owner" under it), or my own name. Each says what it will upload. A service business sees the company and its owner.
import { BUSINESS_NAME_CHOICE, OWN_NAME_CHOICE, OWN_NAME_DECLARATION_WEB, OWN_NAME_TICK, ownNameDeclarationDisplay, ownNameSigningFor } from '@/lib/own-name-copy';
import {
  BASIS_QUESTION, COMPANY_CHOICE, COMPANY_HINT, MANAGER_HINT, MANAGER_TICK, PERSON_CHECKS, REGISTERED_HINT, SERVICE_OWNER_CHOICE, SERVICE_OWNER_HINT,
  basisChoicesFor, managerPathApplies, type SignupBasis,
} from '@/lib/business-basis';
import styles from '../auth-flow.module.css';

export type NameBasis = SignupBasis;

export function OwnNameChoice({ storeName, vendorType = 'STORE', nameBasis, onNameBasis, tick, onTick, managerNotOwner = false, onManagerNotOwner }: {
  storeName: string;
  vendorType?: string;
  nameBasis: NameBasis;
  onNameBasis: (_basis: NameBasis) => void;
  tick: boolean;
  onTick: (_ticked: boolean) => void;
  managerNotOwner?: boolean;
  onManagerNotOwner?: (_manager: boolean) => void;
}) {
  const shown = ownNameDeclarationDisplay(OWN_NAME_DECLARATION_WEB);
  const store = managerPathApplies(vendorType);
  const words: Record<NameBasis, string> = { COMPANY: COMPANY_CHOICE, REGISTERED: store ? BUSINESS_NAME_CHOICE : SERVICE_OWNER_CHOICE, OWN_NAME: OWN_NAME_CHOICE };
  return (
    <fieldset className={styles.field}>
      <legend className={styles.label}>{BASIS_QUESTION}</legend>
      {basisChoicesFor(vendorType).map((basis) => (
        <label key={basis}><input type="radio" name="name-basis" checked={nameBasis === basis} onChange={() => { onNameBasis(basis); onTick(false); }} /> {words[basis]}</label>
      ))}
      {nameBasis === 'COMPANY' ? <p className={styles.bodyCopy} data-basis-hint>{COMPANY_HINT}</p> : null}
      {nameBasis === 'REGISTERED' ? (store ? (
        <>
          <p className={styles.bodyCopy} data-basis-hint>{managerNotOwner ? MANAGER_HINT : REGISTERED_HINT}</p>
          {onManagerNotOwner ? (
            <label className={styles.legal} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }} data-manager-tick>
              <input type="checkbox" checked={managerNotOwner} onChange={(e) => onManagerNotOwner(e.target.checked)} />
              <span>{MANAGER_TICK}</span>
            </label>
          ) : null}
        </>
      ) : <p className={styles.bodyCopy} data-basis-hint>{SERVICE_OWNER_HINT}</p>) : null}
      {nameBasis === 'OWN_NAME' && store ? (
        <>
          <p className={styles.bodyCopy}>The law does not ask you to register your own name as a business name, so you sign a short declaration instead of uploading a business registration. A person on our team checks it against your ID.</p>
          {ownNameSigningFor(storeName) ? <p className={styles.bodyCopy}><strong>{ownNameSigningFor(storeName)}</strong></p> : null}
          {/* [OWNER-ASKS 9 Nov 2026] a plain title and its version in place of the raw first line; the signed words unchanged */}
          <p className={styles.bodyCopy} data-own-name-title><strong>{shown.title}</strong>{shown.version ? <><br /><small>{shown.version}</small></> : null}</p>
          <pre className={styles.bodyCopy} style={{ whiteSpace: 'pre-wrap' }}>{shown.body}</pre>
          {/* [FLOW-QA2 F24] the same tick as the sign-up's others: a 20 px box in a 44 px row */}
          <label className={styles.legal} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }} data-own-name-tick>
            <input type="checkbox" checked={tick} onChange={(e) => onTick(e.target.checked)} />
            <span>{OWN_NAME_TICK}</span>
          </label>
        </>
      ) : null}
      <p className={styles.bodyCopy}>{PERSON_CHECKS}</p>
    </fieldset>
  );
}
