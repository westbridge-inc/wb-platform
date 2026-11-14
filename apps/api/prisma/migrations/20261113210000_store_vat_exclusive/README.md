# 20261113210000_store_vat_exclusive: prices before VAT

What it adds (additive only, no table rewrite):

- `StoreVatMode` value `PRICES_EXCLUDE_VAT` (a store's prices are before VAT; a "VAT 14%" line is added at checkout).
- `orders."vatOnTop"` (`BOOLEAN NOT NULL DEFAULT false`): the placed order's VAT was ADDED on top of its goods
  (`taxAmount` = `vatAmount`, inside `totalAmount`; `vatBase` excludes the VAT).
- `order_items."substituteVatClass"` (nullable): a proposed substitute's VAT class, frozen when the store proposes it.

Nothing changes for any store until `STORE_VAT_EXCLUSIVE=1` and a person approves a store on the new basis.

## Rolling back (in this order)

Run `rollback.sql` while the NEW code is still serving, and only roll the code back after it.

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

Nothing is dropped. `orders."vatOnTop"` is the only record of each placed order's VAT basis; the previous release ignores
it. The migration stays recorded as applied, so rolling forward again does not re-run it.

Known limit after the code rollback: the previous release's VAT report reads every VAT order as VAT-inclusive, so for a
period holding on-top orders its line 17 is short by their VAT. Use the new release's report, or the order export
(`tax` and `vat_basis`), for such periods.

## STORE_VAT and STORE_VAT_EXCLUSIVE are not full off-switches for these stores

A store a person approved on "prices before VAT" keeps adding its VAT line even with either switch off (its typed
prices exclude VAT: dropping the line would undercharge it 14%). To stop VAT on such a store, a person withdraws its VAT
(Admin -> Store VAT -> withdraw) or approves its change to "prices include VAT"; the store itself can still turn its
VAT off in its own settings while the switch is off.
