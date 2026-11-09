'use client';

// [ROLE-DOCS · #2046 · perf] The own-name choice and the declaration's words (BNA s.3), loaded on the business
// step only for a store type that is asked for a business registration (own-name-loader.ts; page-size.test.ts).
// The page keeps the choice and the tick, and signs after the store exists; this block only shows them.
import { BUSINESS_NAME_CHOICE, OWN_NAME_CHOICE, OWN_NAME_DECLARATION_WEB, OWN_NAME_TICK, ownNameDeclarationDisplay, ownNameSigningFor } from '@/lib/own-name-copy';
import styles from '../auth-flow.module.css';

export type NameBasis = 'REGISTERED' | 'OWN_NAME';

export function OwnNameChoice({ storeName, nameBasis, onNameBasis, tick, onTick }: {
  storeName: string;
  nameBasis: NameBasis;
  onNameBasis: (_basis: NameBasis) => void;
  tick: boolean;
  onTick: (_ticked: boolean) => void;
}) {
  const shown = ownNameDeclarationDisplay(OWN_NAME_DECLARATION_WEB);
  return (
    <fieldset className={styles.field}>
      <legend className={styles.label}>What name does your store use?</legend>
      <label><input type="radio" name="name-basis" checked={nameBasis === 'OWN_NAME'} onChange={() => { onNameBasis('OWN_NAME'); onTick(false); }} /> {OWN_NAME_CHOICE}</label>
      <label><input type="radio" name="name-basis" checked={nameBasis === 'REGISTERED'} onChange={() => { onNameBasis('REGISTERED'); onTick(false); }} /> {BUSINESS_NAME_CHOICE}</label>
      {nameBasis === 'OWN_NAME' ? (
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
    </fieldset>
  );
}
