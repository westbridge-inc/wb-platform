'use client';

import { useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { formatAmount, parseAmount } from '@/lib/money';
import type { MenuItem, OptionGroup } from '@/lib/customer';
import {
  clearableSingle, followUpFor, groupGuidance, isChosen, maxChoices, onSale as choiceOnSale, placementOf, requiredGroup,
  singleChoice, sortedOptions, topLevelGroups, halfPrice, type Placement,
} from '@/lib/menu-options';
import { Photo } from '@/components/order-ui';
import { Sheet } from '@/components/sheet';
import styles from './storefront.module.css';

/**
 * [W6 · size] The API's own option engine (judge and price a selection) and the sheet model (defaults, what a tap
 * does, a kept selection restored) arrive with the sheet, never in the store
 * page's first load: a selection only exists once the sheet is open. The page reaches these through this module
 * (storefront-experience.tsx `itemSheetModule` / `loadItemSheet`); they are lib/menu-options' functions themselves.
 */
export {
  OptionSelectionError, chooseOption, defaultSelection, placeOption, restoreSelection, selectionNames, selectionPrice, singleChoice,
  validateSelectedOptions,
} from '@/lib/menu-options';

/**
 * [W6] An item's sheet on the store page: its choices, the quantity and the
 * Add. It is only needed after a tap (or a link that names an item), so the
 * store page loads this code after its first paint instead of before it
 * (storefront-experience.tsx `loadItemSheet`). Everything it decides comes
 * from the page: the choices made, the price, the error, and what Add does.
 */

const gyMoney = (value: unknown) => formatAmount(value, '$');

const PLACEMENTS: ReadonlyArray<{ key: Placement; label: string }> = [
  { key: 'WHOLE', label: 'Whole' },
  { key: 'LEFT', label: 'Left half' },
  { key: 'RIGHT', label: 'Right half' },
];

/** [MENU-OPTIONS] What a choice's row says about money: a size its PRICE (it is the item's price), any other choice
 *  what it adds; nothing when it is free. Null when the server's figure cannot be read. */
function choicePrice(group: OptionGroup, amount: number | null, vatAdded = false): string | null | '' {
  if (amount === null) return null;
  // [STORE-VAT-EXCLUSIVE · REVIEW-B S3-1] A standard-rated item of a store pricing before VAT: its choices say "+ VAT" too.
  const vat = vatAdded ? ' + VAT' : '';
  if (group.setsPrice === true) return `${gyMoney(amount)}${vat}`;
  return amount > 0 ? `+${gyMoney(amount)}${vat}` : '';
}

/** [P35 · board 4b] About three lines of the sheet's description; past this it is clamped behind "Read more". */
export const SHEET_DESCRIPTION_CLAMP_CHARS = 140;

/** [P35 · board 4b] Who sells the item: "Craft & Kind · Georgetown", and "Verified seller" when a person approved
 *  the store's papers (the public store page only exists for such a store: public.routes.ts PUBLIC_WHERE). */
export interface ItemSheetSeller { name: string; city: string | null | undefined; verified: boolean }

export interface ItemSheetProps {
  item: MenuItem & { optionGroups?: OptionGroup[] };
  /** Absent: the sheet shows no seller line (tests, older callers). */
  seller?: ItemSheetSeller;
  vendorType: string | null | undefined;
  /** The choices as the API reads them: `id`, `id:left`, `id:right`. */
  selectedOptions: Record<string, string[]>;
  onChoose: (_group: OptionGroup, _optionId: string) => void;
  /** [MENU-OPTIONS] A chosen topping of a half-and-half group moves to the whole item, the left or the right half. */
  onPlace?: (_group: OptionGroup, _optionId: string, _placement: Placement) => void;
  quantity: number;
  onQuantity: (_next: (_count: number) => number) => void;
  error: string | null;
  busy: boolean;
  cartLoading: boolean;
  unitPrice: number | null;
  /** [STORE-VAT-EXCLUSIVE · REVIEW-B S3-1] A standard-rated item of a store pricing before VAT (the storefront's
   *  itemVatAddedHint): every price on the sheet says "+ VAT". Absent: nothing changes. */
  vatAdded?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ItemSheet({
  item, seller, vendorType, selectedOptions, onChoose, onPlace, quantity, onQuantity, error, busy, cartLoading, unitPrice, vatAdded = false, onConfirm, onClose,
}: ItemSheetProps) {
  const groups = item.optionGroups ?? [];
  return (
    <Sheet labelledBy="menu-options-title" onClose={onClose} className={styles.sheet}>
      <div className={styles.sheetHeader}>
        <Photo src={item.imageUrl} alt="" vendorType={vendorType} sizes="72px" iconSize={26} className={styles.sheetPhoto} />
        <div className={styles.sheetHeading}>
          <h2 id="menu-options-title" className={styles.modalTitle}>{item.name}</h2>
          {seller ? (
            <p className={styles.sheetSeller}>
              <span>{seller.city?.trim() ? `${seller.name} · ${seller.city.trim()}` : seller.name}</span>
              {seller.verified ? <span className="sw-status sw-status-success">Verified seller</span> : null}
            </p>
          ) : null}
          {item.description ? <SheetDescription text={item.description} /> : null}
        </div>
        <button data-modal-initial-focus type="button" className={styles.closeButton} onClick={onClose} aria-label="Close item options">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.options}>
        {/* [MENU-OPTIONS · owner 11 Nov 2026] Like a pizza shop's sheet: each group says Required and how many to
            choose; a size shows its price; a chosen half-and-half topping goes on the Whole item, the Left half or
            the Right half; a follow-up group opens right under the choice that opens it, only while it is chosen. */}
        {topLevelGroups(groups).map((group) => (
          <div key={group.id} className={styles.optionBlock}>
            <OptionGroupFields group={group} groups={groups} selectedOptions={selectedOptions} onChoose={onChoose} onPlace={onPlace} nested={false} vatAdded={vatAdded} />
          </div>
        ))}
      </div>

      <div className={styles.sheetFooter}>
        {error ? <p id="menu-options-error" className={styles.modalAlert} role="alert">{error}</p> : null}
        <div className={styles.sheetFooterRow}>
          <div className={styles.quantity} role="group" aria-label="Quantity">
            <button type="button" className={styles.quantityButton} aria-label="Decrease quantity" disabled={quantity <= 1 || busy} onClick={() => onQuantity((count) => Math.max(1, count - 1))}><Minus size={18} aria-hidden="true" /></button>
            <span className={styles.quantityCount} role="status" aria-label={`Quantity ${quantity}`}>{quantity}</span>
            <button type="button" className={styles.quantityButton} aria-label="Increase quantity" disabled={quantity >= 99 || busy} onClick={() => onQuantity((count) => Math.min(99, count + 1))}><Plus size={18} aria-hidden="true" /></button>
          </div>
          <button
            type="button"
            className={`${styles.primaryButton} ${styles.sheetAdd}`}
            disabled={cartLoading || busy || unitPrice === null}
            aria-describedby={error ? 'menu-options-error' : undefined}
            onClick={onConfirm}
          >
            Add to order · {gyMoney(unitPrice === null ? null : unitPrice * quantity)}{vatAdded ? ' + VAT' : ''}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** [P35 · board 4b "Read more"] Three lines until asked; a short description is whole, with no button. */
function SheetDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const clamp = text.trim().length > SHEET_DESCRIPTION_CLAMP_CHARS;
  return (
    <>
      <p className={clamp && !open ? `${styles.modalDescription} ${styles.modalDescriptionClamped}` : styles.modalDescription}>{text}</p>
      {clamp ? (
        <button type="button" className={styles.readMore} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Read more'}
        </button>
      ) : null}
    </>
  );
}

interface OptionGroupFieldsProps {
  group: OptionGroup;
  groups: OptionGroup[];
  selectedOptions: Record<string, string[]>;
  onChoose: ItemSheetProps['onChoose'];
  onPlace: ItemSheetProps['onPlace'];
  nested: boolean;
  vatAdded?: boolean;
}

/** One group of choices (and, under a chosen option that opens one, its follow-up group). */
function OptionGroupFields({ group, groups, selectedOptions, onChoose, onPlace, nested, vatAdded = false }: OptionGroupFieldsProps) {
  const selectedCount = (selectedOptions[group.id] ?? []).length;
  const single = singleChoice(group);
  const multiLimitReached = !single && selectedCount >= maxChoices(group);
  const options = sortedOptions(group);
  const anyOnSale = options.some(choiceOnSale);
  const required = requiredGroup(group);
  return (
    <fieldset className={nested ? `${styles.optionGroup} ${styles.followUpGroup}` : styles.optionGroup} data-option-group={group.id}>
      <legend className={styles.optionHeading}>
        <span className={styles.optionTitle}>{group.name}</span>
        <span className={styles.optionMeta}>
          {required ? <span className={styles.required}>Required</span> : <span className={styles.optionGuidance}>Optional</span>}
        </span>
      </legend>
      <p className={styles.optionGuidance}>{groupGuidance(group)}</p>
      {!anyOnSale ? <p className={styles.optionGuidance}>Every choice here is sold out right now.</p> : null}
      {options.map((option) => {
        if (!choiceOnSale(option)) {
          // [F4] Shown so the menu stays honest, never chosen (the server refuses it anyway).
          return (
            <p key={option.id} className={`${styles.optionLabel} ${styles.optionLabelDisabled}`}>
              <span className={styles.optionChoice}>{option.name}</span>
              <span className={styles.optionPrice}>Sold out</span>
            </p>
          );
        }
        const checked = isChosen(selectedOptions, group.id, option.id);
        const blockedByLimit = multiLimitReached && !checked;
        // [W6] A choice whose price cannot be read is never priced: the row says so.
        const extra = parseAmount(option.additionalPrice);
        const price = choicePrice(group, extra, vatAdded);
        const placement = checked && group.allowHalves === true ? placementOf(selectedOptions, group.id, option.id) : null;
        const opens = checked && !nested ? followUpFor(groups, group, option) : null;
        return (
          <div key={option.id} className={styles.optionRow}>
            <label className={`${styles.optionLabel} ${blockedByLimit ? styles.optionLabelDisabled : ''}`}>
              <span className={styles.optionChoice}>
                <input
                  type={single && !clearableSingle(group) ? 'radio' : 'checkbox'}
                  name={group.id}
                  checked={checked}
                  disabled={blockedByLimit}
                  onChange={() => onChoose(group, option.id)}
                />
                {option.name}
              </span>
              {extra === null ? (
                <span className={styles.optionPrice}>Price unavailable</span>
              ) : price ? (
                <span className={styles.optionPrice}>{price}</span>
              ) : null}
            </label>
            {placement && onPlace ? (
              <div className={styles.halfPicker}>
                <div role="radiogroup" aria-label={`Where ${option.name} goes`} className={styles.halfChoices}>
                  {PLACEMENTS.map((place) => (
                    <button
                      key={place.key}
                      type="button"
                      role="radio"
                      aria-checked={placement === place.key}
                      className={placement === place.key ? `${styles.halfChoice} ${styles.halfChoiceOn}` : styles.halfChoice}
                      onClick={() => onPlace(group, option.id, place.key)}
                    >
                      {place.label}
                    </button>
                  ))}
                </div>
                {extra !== null && extra > 0 ? (
                  <p className={styles.optionGuidance}>Whole +{gyMoney(extra)} · half +{gyMoney(halfPrice(extra, group.halfPricePercent ?? 100))}{vatAdded ? ' (+ VAT)' : ''}</p>
                ) : null}
              </div>
            ) : null}
            {opens ? (
              <OptionGroupFields group={opens} groups={groups} selectedOptions={selectedOptions} onChoose={onChoose} onPlace={onPlace} nested vatAdded={vatAdded} />
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}
