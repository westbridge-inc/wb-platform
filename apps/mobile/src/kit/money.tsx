/** @jsxImportSource react */
import React from 'react';
import { money } from '../lib/money';
import { T, type TP } from './text';

/**
 * Money, rendered right: the shared formatter (lib/money) in a tabular num
 * step — `numM` (17) for rows and lists, `numL` (24) for totals and hero
 * amounts. Hand-built money strings are a lint error (Part 11 money law);
 * screens migrate onto this as their flow is elevated.
 */
export function Money({
  amount,
  size = 'm',
  from = false,
  vatAdded = false,
  ...rest
}: Omit<TP, 'variant' | 'children'> & {
  amount: number | null | undefined; size?: 'm' | 'l';
  /** [MENU-OPTIONS] The item's size sets its price: `amount` is its smallest size, read "From $X". */
  from?: boolean;
  /** [STORE-VAT-EXCLUSIVE · REVIEW-B S3-1] A standard-rated price of a store pricing before VAT (the server's
   *  `vatAddedAtCheckout`): read "$X + VAT", since its VAT is added at checkout. */
  vatAdded?: boolean;
}) {
  return (
    <T variant={size === 'l' ? 'numL' : 'numM'} {...rest}>
      {from ? 'From ' : ''}{money(amount)}{vatAdded ? ' + VAT' : ''}
    </T>
  );
}
