# 20261113210000_store_vat_exclusive: prices before VAT

What it adds (additive only, no table rewrite):

- `StoreVatMode` value `PRICES_EXCLUDE_VAT` (a store's prices are before VAT; a "VAT 14%" line is added at checkout).
- `orders."vatOnTop"` (`BOOLEAN NOT NULL DEFAULT false`): the placed order's VAT was ADDED on top of its goods
  (`taxAmount` = `vatAmount`, inside `totalAmount`; `vatBase` excludes the VAT).
- `order_items."substituteVatClass"` (nullable): a proposed substitute's VAT class, frozen when the store proposes it.

Nothing changes for any store until `STORE_VAT_EXCLUSIVE=1` and a person approves a store on the new basis.

## Rolling back (in this order)

Run `rollback.sql` while the NEW code is still serving, and only roll the code back after it.

0. **Switch STORE_VAT_EXCLUSIVE off** (unset in deploy/.env, recreate api + worker) and confirm it is off
   (`GET /vendor/vat` `modesOffered` no longer lists `PRICES_EXCLUDE_VAT`). While it is on, a store or a person could put
   `PRICES_EXCLUDE_VAT` back on a store row after step 3, and the previous release cannot read that row.
1. **Close** every store on "prices before VAT": its open-now switch off (Admin, or the store). Check:
   `SELECT count(*) FROM vendors WHERE "vatMode" = 'PRICES_EXCLUDE_VAT' AND "vatStatus" = 'APPROVED' AND "isCurrentlyOpen" AND "acceptingOrders";` = 0.
2. **Let their orders finish.** Check:
   `SELECT count(*) FROM orders WHERE "vatOnTop" AND status NOT IN ('DELIVERED','COMPLETED','CANCELLED','REFUNDED','FAILED','RETURNED');` = 0.
3. **Run `rollback.sql`** (new code still live; a role that bypasses row-level security). It refuses, and changes
   nothing, while step 1 or 2 is not done. It moves each such store back to PENDING on "My prices do not include VAT",
   so nothing is added to its prices until a person approves it again.
4. **Roll the code back.**

Never the other way round: the previous release's Prisma client cannot read a store row carrying `PRICES_EXCLUDE_VAT`
(every read of that store fails until the SQL runs), and an open on-top order under the previous code tells its rider to
pay the store the goods without the VAT the rider collected at the door.

Nothing is dropped. The previous release ignores `orders."vatOnTop"` either way; keeping it keeps each placed order's VAT
basis for a later roll-forward (a re-added column would default to false for good). The migration stays recorded as
applied, so rolling forward again does not re-run it.

Known limits after the code rollback, for orders placed on "prices before VAT" (settle these by hand until rolled forward):

- **VAT report:** the previous release reads every VAT order as VAT-inclusive, so for a period holding such orders its
  line 17 is short by their VAT. Use the order export (`tax` and `vat_basis`) for such periods.
- **Receipts:** the previous release re-renders such an order's receipt as "VAT included" with no "VAT 14%" row, so its
  rows add up to less than its Total (the Total, the amount paid, is right).
- **Returns:** the previous release computes a return of such an order without the VAT added on top, so the refund it
  shows is short by that VAT. Settle every return of such an order by hand (the order's `taxAmount` comes back too).

## STORE_VAT and STORE_VAT_EXCLUSIVE are not full off-switches for these stores

A store a person approved on "prices before VAT" keeps adding its VAT line even with either switch off (its typed
prices exclude VAT: dropping the line would undercharge it 14%). To stop VAT on such a store, a person withdraws its VAT
(Admin -> Store VAT -> withdraw) or approves its change to "prices include VAT"; the store itself can still turn its
VAT off in its own settings while the switch is off.
