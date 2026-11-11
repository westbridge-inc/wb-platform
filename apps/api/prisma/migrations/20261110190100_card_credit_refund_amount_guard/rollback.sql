-- Rollback of 20261110190100_card_credit_refund_amount_guard: drops the database's wall under the refund amount.
-- Safe at any time (the code refuses an amount above the payment on its own: cardRefundPart ABOVE_PAYMENT).
DROP TRIGGER IF EXISTS card_credit_refunds_within_payment ON "card_credit_refunds";
DROP FUNCTION IF EXISTS card_credit_refunds_within_payment();
