-- [REVIEW-2484-B S4-4] A refund to the card may now be PART of a card payment (owner 10 Nov 2026: a partly used card
-- payment's weeks that have not started). Swift's code asks only for the payment's money in the refund set-aside
-- (card-credit-refund.ts cardRefundPart); this is the database's own wall under it: a refund to the card is never more
-- than the card payment it names, and is in that payment's currency. Checked when the refund is written (what was asked
-- is written once: card_credit_refunds_guard), against the card session it names; a session that cannot be read here
-- (none, no amount, or another tenant's) is refused.
-- Additive: one function and one trigger; no row changes.
--
-- ROLLBACK: rollback.sql beside this file.

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION card_credit_refunds_within_payment() RETURNS trigger AS $$
DECLARE
  paid NUMERIC;
  paid_currency TEXT;
BEGIN
  SELECT s."amount", s."currencyCode" INTO paid, paid_currency FROM "card_sessions" s WHERE s."id" = NEW."cardSessionId";
  IF paid IS NULL OR paid_currency IS NULL THEN
    RAISE EXCEPTION 'card_credit_refunds: card session % has no payment to refund [REVIEW-2484-B S4-4]', NEW."cardSessionId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount" > paid OR NEW."currencyCode" <> paid_currency THEN
    RAISE EXCEPTION 'card_credit_refunds: a refund to the card is never more than its card payment, and in its currency (% % of % %) [REVIEW-2484-B S4-4]',
      NEW."amount", NEW."currencyCode", paid, paid_currency USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER card_credit_refunds_within_payment BEFORE INSERT ON "card_credit_refunds"
  FOR EACH ROW EXECUTE FUNCTION card_credit_refunds_within_payment();
