-- [LEGAL-CARDS 12 Nov 2026 · VOID-REFUND-CHECK F1-F5] PowerTranz's written answer (12 Nov 2026): VOID a card sale the
-- bank has not settled, REFUND it once settled (settled by the acquiring bank, typically 2-3 business days); a DECLINED
-- transaction can never be refunded (Response Code 12). Swift now chooses the reversal by the sale's age
-- (card-settlement.ts: VOID while it may be unsettled, REFUND once certainly settled), and a reversal the provider
-- REFUSES is never followed automatically by another: a person checks it with the card provider.
--
--   card_sessions (finance's decision on a HELD Pay now):
--     providerReversalKind  VOID or REFUND: what finance's reversal sent (its state stays providerRefundState).
--     reversalCheck         what a check of a REFUSED reversal found: SALE_STANDS (approved, captured, unreversed:
--                           one more reversal may be sent) or NOT_TAKEN (declined / never completed: "nothing taken").
--     reversalRetryAt       the one further reversal, claimed once (FAILED -> SENDING, only after SALE_STANDS).
--   card_credit_refunds (a refund of set-aside credit to its card):
--     kind                  VOID (a whole payment not yet certainly settled) or REFUND; written once.
--     checkedAt             a check of a REFUSED reversal found nothing back: only then may the money be paid back
--                           another way (Record payout), or — after a refused VOID — refunded to the card once.
--     One reversal of each kind per card payment, ever (partial unique indexes); a refund beside a void only once
--     that void was refused and checked (trigger).
-- Additive in effect: new nullable / defaulted columns, two guard functions gain the transitions above, and the one-row
-- rule becomes one row per kind. No existing row changes meaning (existing rows are REFUND).
--
-- ROLLBACK: rollback.sql beside this file — ONLY AFTER the code is rolled back, and refused once a VOID row exists.

SET lock_timeout = '10s';

ALTER TABLE "card_sessions"
  ADD COLUMN "providerReversalKind" TEXT,
  ADD COLUMN "reversalCheck" TEXT,
  ADD COLUMN "reversalRetryAt" TIMESTAMP(3);

ALTER TABLE "card_sessions"
  ADD CONSTRAINT "card_sessions_reversal_kind_check"
    CHECK ("providerReversalKind" IS NULL OR ("providerReversalKind" IN ('VOID', 'REFUND') AND "providerRefundState" IS NOT NULL)),
  ADD CONSTRAINT "card_sessions_reversal_check_check"
    CHECK ("reversalCheck" IS NULL OR "reversalCheck" IN ('SALE_STANDS', 'NOT_TAKEN'));

ALTER TABLE "card_credit_refunds"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'REFUND',
  ADD COLUMN "checkedAt" TIMESTAMP(3),
  -- [REVIEW-2496-B S3-2 · OWNER 12 Nov 2026] Who checked it, and how: LOOKUP:<record sha256> (the provider's record), or
  -- PORTAL:<typed portal reference> (the owner and a second person confirmed in the console that nothing went back).
  ADD COLUMN "checkedBy" TEXT,
  ADD COLUMN "checkedRef" TEXT;

ALTER TABLE "card_credit_refunds"
  ADD CONSTRAINT "card_credit_refunds_kind_check" CHECK ("kind" IN ('VOID', 'REFUND'));

DROP INDEX "card_credit_refunds_cardSessionId_key";
CREATE INDEX "card_credit_refunds_cardSessionId_idx" ON "card_credit_refunds"("cardSessionId");
CREATE UNIQUE INDEX "card_credit_refunds_one_refund_per_payment" ON "card_credit_refunds"("cardSessionId") WHERE "kind" = 'REFUND';
CREATE UNIQUE INDEX "card_credit_refunds_one_void_per_payment" ON "card_credit_refunds"("cardSessionId") WHERE "kind" = 'VOID';

CREATE OR REPLACE FUNCTION card_sessions_provider_actions() RETURNS trigger AS $$
BEGIN
  IF OLD."completionClaimedAt" IS NOT NULL AND NEW."completionClaimedAt" IS DISTINCT FROM OLD."completionClaimedAt" THEN
    RAISE EXCEPTION 'card completion claim is written once' USING ERRCODE='check_violation';
  END IF;
  IF OLD."completionEvidence" IS NOT NULL AND NEW."completionEvidence" IS DISTINCT FROM OLD."completionEvidence" THEN
    RAISE EXCEPTION 'card completion evidence is written once' USING ERRCODE='check_violation';
  END IF;
  IF OLD."providerTransactionRef" IS NOT NULL AND NEW."providerTransactionRef" IS DISTINCT FROM OLD."providerTransactionRef" THEN
    RAISE EXCEPTION 'card_sessions row %: the provider transaction reference is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerVoidState" IS DISTINCT FROM OLD."providerVoidState" AND NOT COALESCE(
       (OLD."providerVoidState" IS NULL AND NEW."providerVoidState" = 'SENDING')
    OR (OLD."providerVoidState" = 'SENDING' AND NEW."providerVoidState" IN ('VOIDED', 'FAILED', 'UNKNOWN')),
    false) THEN
    RAISE EXCEPTION 'card_sessions row %: a void claim only moves forward (% -> %) [PT-4]', OLD.id, OLD."providerVoidState", NEW."providerVoidState" USING ERRCODE = 'check_violation';
  END IF;
  -- [REVIEW-2496 round 2] COALESCE(..., false): a comparison with a NULL state is NULL, and NOT NULL would let any move
  -- through (NULL -> REFUNDED passed the earlier guard). Every allowed move must be TRUE.
  IF NEW."providerRefundState" IS DISTINCT FROM OLD."providerRefundState" AND NOT COALESCE(
       (OLD."providerRefundState" IS NULL AND NEW."providerRefundState" = 'SENDING')
    OR (OLD."providerRefundState" IN ('SENDING', 'PENDING') AND NEW."providerRefundState" IN ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN'))
    -- [CARD-REFUND-LOOKUP] A refund whose answer was lost is REFUNDED once the provider's own record shows the whole
    -- payment back (a person asked, two people). Never anything else from UNKNOWN.
    OR (OLD."providerRefundState" = 'UNKNOWN' AND NEW."providerRefundState" = 'REFUNDED')
    -- [VOID-REFUND-CHECK F3] A reversal the provider REFUSED is checked with the card provider (two people): its record
    -- shows the payment voided or credited back (REFUNDED), or the sale still standing, approved and unreversed — then
    -- ONE more reversal may be claimed, once (reversalRetryAt, written once), under a new key. Never a third.
    -- [REVIEW-2496-A S4-3] ... only on a payment still HELD for a person.
    OR (OLD."providerRefundState" = 'FAILED' AND NEW."providerRefundState" = 'REFUNDED' AND OLD."status" = 'HELD')
    OR (OLD."providerRefundState" = 'FAILED' AND NEW."providerRefundState" = 'SENDING'
        AND OLD."reversalRetryAt" IS NULL AND NEW."reversalRetryAt" IS NOT NULL AND OLD."reversalCheck" = 'SALE_STANDS'),
    false) THEN
    RAISE EXCEPTION 'card_sessions row %: a refund claim only moves forward (% -> %) [PT-4]', OLD.id, OLD."providerRefundState", NEW."providerRefundState" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."bookClaimedAt" IS NOT NULL AND NEW."bookClaimedAt" IS DISTINCT FROM OLD."bookClaimedAt" THEN
    RAISE EXCEPTION 'card_sessions row %: a booking claim is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- [Review S2-2 · one money movement] A session whose money a void or a
  -- refund may have returned is never booked; a session with a payment is
  -- never voided; a booked payment is never refunded here. (A void or refund
  -- the provider REFUSED moved nothing, so it does not count.)
  IF OLD."providerVoidState" IS NULL AND NEW."providerVoidState" IS NOT NULL AND NEW."paymentId" IS NOT NULL THEN
    RAISE EXCEPTION 'card_sessions row %: a session with a payment is never voided [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."paymentId" IS NULL AND NEW."paymentId" IS NOT NULL
     AND NEW."providerVoidState" IS NOT NULL AND NEW."providerVoidState" <> 'FAILED' THEN
    RAISE EXCEPTION 'card_sessions row %: a session whose void may have taken effect never takes a payment [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF ((OLD."bookClaimedAt" IS NULL AND NEW."bookClaimedAt" IS NOT NULL) OR (OLD."status" <> 'SUCCEEDED' AND NEW."status" = 'SUCCEEDED'))
     AND ((NEW."providerVoidState" IS NOT NULL AND NEW."providerVoidState" <> 'FAILED')
       OR (NEW."providerRefundState" IS NOT NULL AND NEW."providerRefundState" <> 'FAILED')) THEN
    RAISE EXCEPTION 'card_sessions row %: a payment a void or refund may have returned is never booked [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerRefundState" = 'SENDING' AND OLD."providerRefundState" IS DISTINCT FROM 'SENDING'
     AND (OLD."status" = 'SUCCEEDED'
       OR EXISTS (SELECT 1 FROM "subscription_payments" p WHERE p."id" = NEW."paymentId" AND p."status" = 'CAPTURED')
       OR EXISTS (SELECT 1 FROM "billing_events" e WHERE e."idempotencyKey" = 'bank:' || NEW."paymentId")) THEN
    RAISE EXCEPTION 'card_sessions row %: a booked payment is never refunded here [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- [REVIEW-2496-B S3-1] Every reversal claim spends the check that allowed it: a claim that keeps one is refused, so a
  -- stale "the sale stands" can never authorise a later retry.
  IF NEW."providerRefundState" = 'SENDING' AND OLD."providerRefundState" IS DISTINCT FROM 'SENDING' AND NEW."reversalCheck" IS NOT NULL THEN
    RAISE EXCEPTION 'card_sessions row %: a reversal claim spends its check [REVIEW-2496-B S3-1]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- [REVIEW-2496-A S4-3] A check's verdict is written only on a payment whose reversal was refused, or whose own void got no answer.
  IF NEW."reversalCheck" IS NOT NULL AND NEW."reversalCheck" IS DISTINCT FROM OLD."reversalCheck"
     AND NOT COALESCE(OLD."status" = 'HELD' AND (OLD."providerRefundState" = 'FAILED' OR (OLD."providerRefundState" IS NULL AND OLD."providerVoidState" = 'UNKNOWN')), false) THEN
    RAISE EXCEPTION 'card_sessions row %: a check is recorded only on a refused or unanswered reversal [REVIEW-2496-A S4-3]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."reversalRetryAt" IS NOT NULL AND NEW."reversalRetryAt" IS DISTINCT FROM OLD."reversalRetryAt" THEN
    RAISE EXCEPTION 'card_sessions row %: the one further reversal is claimed once [VOID-REFUND-CHECK F3]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- The kind of finance's reversal (VOID or REFUND) is written only with the claim that sends it.
  IF NEW."providerReversalKind" IS DISTINCT FROM OLD."providerReversalKind"
     AND NOT COALESCE(NEW."providerRefundState" = 'SENDING' AND OLD."providerRefundState" IS DISTINCT FROM 'SENDING', false) THEN
    RAISE EXCEPTION 'card_sessions row %: a reversal''s kind is written with its claim only [VOID-REFUND-CHECK F1]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."resolution" IS NOT NULL AND (NEW."resolution" IS DISTINCT FROM OLD."resolution"
       OR NEW."resolvedBy" IS DISTINCT FROM OLD."resolvedBy" OR NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt") THEN
    RAISE EXCEPTION 'card_sessions row %: a finance resolution is written once [PT-4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION card_credit_refunds_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'SENDING' THEN
      RAISE EXCEPTION 'card_credit_refunds: a refund is born SENDING [CARD-READY]' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
     OR NEW."cardSessionId" IS DISTINCT FROM OLD."cardSessionId"
     OR NEW."setAsideId" IS DISTINCT FROM OLD."setAsideId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currencyCode" IS DISTINCT FROM OLD."currencyCode"
     OR NEW."requestedByUserId" IS DISTINCT FROM OLD."requestedByUserId"
     OR NEW."approvalId" IS DISTINCT FROM OLD."approvalId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'card_credit_refunds row %: what was asked is written once [CARD-READY]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
       (OLD."state" = 'SENDING' AND NEW."state" IN ('REFUNDED', 'FAILED', 'UNKNOWN', 'PENDING'))
    -- [CARD-REFUND-LOOKUP] A refund whose answer is not known (UNKNOWN, PENDING) becomes REFUNDED, once, when the
    -- provider's own record shows the whole payment back (a person asked, two people). Nothing else moves it.
    OR (OLD."state" IN ('UNKNOWN', 'PENDING') AND NEW."state" = 'REFUNDED')
    -- [VOID-REFUND-CHECK F5] A REFUSED reversal whose original the provider's own record shows voided or credited
    -- back (a person asked, two people): REFUNDED, once, under Swift's lookup reference only (never a typed one), and
    -- never paid back a second way.
    OR (OLD."state" = 'FAILED' AND NEW."state" = 'REFUNDED' AND NEW."providerRefundRef" LIKE 'LOOKUP-CREDIT-%' AND OLD."checkedAt" IS NULL)) THEN
    RAISE EXCEPTION 'card_credit_refunds row %: a refund claim only moves forward, once (% -> %) [CARD-READY]', OLD.id, OLD."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'SENDING'
     -- [REVIEW-2461-B S3-1] Moving on to REFUNDED sets the reference and the refund record once; the refund's own
     -- answer (answeredAt, answerSha256) stays exactly as it was.
     AND NOT (OLD."state" IN ('UNKNOWN', 'PENDING', 'FAILED') AND NEW."state" = 'REFUNDED' AND OLD."providerRefundRef" IS NULL AND OLD."billingEventId" IS NULL
              AND NEW."answeredAt" IS NOT DISTINCT FROM OLD."answeredAt" AND NEW."answerSha256" IS NOT DISTINCT FROM OLD."answerSha256")
     AND (NEW."providerRefundRef" IS DISTINCT FROM OLD."providerRefundRef"
       OR NEW."billingEventId" IS DISTINCT FROM OLD."billingEventId" OR NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt"
       OR NEW."outcomeReason" IS DISTINCT FROM OLD."outcomeReason" OR NEW."answerSha256" IS DISTINCT FROM OLD."answerSha256") THEN
    RAISE EXCEPTION 'card_credit_refunds row %: an answered refund is final [CARD-READY]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- [VOID-REFUND-CHECK F1/F4] A reversal's kind is written once, when it is asked.
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'card_credit_refunds row %: a reversal''s kind is written once [VOID-REFUND-CHECK F4]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  -- [VOID-REFUND-CHECK F5] A check that found nothing back is recorded once, and only on a refused reversal.
  IF (NEW."checkedAt" IS DISTINCT FROM OLD."checkedAt" OR NEW."checkedBy" IS DISTINCT FROM OLD."checkedBy" OR NEW."checkedRef" IS DISTINCT FROM OLD."checkedRef")
     AND NOT (OLD."checkedAt" IS NULL AND OLD."checkedBy" IS NULL AND OLD."checkedRef" IS NULL AND OLD."state" = 'FAILED' AND NEW."state" = 'FAILED'
              AND NEW."checkedAt" IS NOT NULL AND NEW."checkedBy" IS NOT NULL AND NEW."checkedRef" IS NOT NULL) THEN
    RAISE EXCEPTION 'card_credit_refunds row %: a refused reversal is checked once [VOID-REFUND-CHECK F5]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- [VOID-REFUND-CHECK F4] A void is of the WHOLE payment ("partial voids are not supported", guide sec. 5.2 / 7.6) and is
-- the first reversal of it; a refund beside an earlier row only when that row is a void the provider refused and a
-- person's check found nothing back. Checked when the row is written, under the payer lock the code already holds.
CREATE OR REPLACE FUNCTION card_credit_refunds_one_reversal() RETURNS trigger AS $$
DECLARE
  paid NUMERIC;
BEGIN
  IF NEW."kind" = 'VOID' THEN
    SELECT s."amount" INTO paid FROM "card_sessions" s WHERE s."id" = NEW."cardSessionId";
    IF paid IS NULL OR NEW."amount" <> paid THEN
      RAISE EXCEPTION 'card_credit_refunds: a void is of the whole card payment [VOID-REFUND-CHECK F4]' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "card_credit_refunds" r WHERE r."cardSessionId" = NEW."cardSessionId"
             AND NOT (NEW."kind" = 'REFUND' AND r."kind" = 'VOID' AND r."state" = 'FAILED' AND r."checkedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'card_credit_refunds: card payment % already has a reversal [VOID-REFUND-CHECK F4]', NEW."cardSessionId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER card_credit_refunds_one_reversal BEFORE INSERT ON "card_credit_refunds"
  FOR EACH ROW EXECUTE FUNCTION card_credit_refunds_one_reversal();
