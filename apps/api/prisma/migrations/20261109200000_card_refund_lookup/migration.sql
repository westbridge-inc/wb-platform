-- [CARD-REFUND-LOOKUP] A refund to a card whose answer was lost (UNKNOWN), or is still pending, is settled by the card
-- provider's own record of the ORIGINAL transaction (GET /api/Transactions/{id}: TotalCreditAmount, VoidDateTime),
-- read only when a person asks and a second admin approves. When the record shows the WHOLE payment back, the claim
-- moves on to REFUNDED, once. Nothing else changes: every other transition stays refused, an answered refund is
-- otherwise final, and nothing here sends anything.
-- Additive in effect: two guard functions gain one allowed transition each; no table, column or row changes.
--
-- ROLLBACK: rollback.sql beside this file (puts back the previous guards; rows already moved stay as they are).

SET lock_timeout = '10s';

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
  IF NEW."providerVoidState" IS DISTINCT FROM OLD."providerVoidState" AND NOT (
       (OLD."providerVoidState" IS NULL AND NEW."providerVoidState" = 'SENDING')
    OR (OLD."providerVoidState" = 'SENDING' AND NEW."providerVoidState" IN ('VOIDED', 'FAILED', 'UNKNOWN'))
  ) THEN
    RAISE EXCEPTION 'card_sessions row %: a void claim only moves forward (% -> %) [PT-4]', OLD.id, OLD."providerVoidState", NEW."providerVoidState" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."providerRefundState" IS DISTINCT FROM OLD."providerRefundState" AND NOT (
       (OLD."providerRefundState" IS NULL AND NEW."providerRefundState" = 'SENDING')
    OR (OLD."providerRefundState" IN ('SENDING', 'PENDING') AND NEW."providerRefundState" IN ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN'))
    -- [CARD-REFUND-LOOKUP] A refund whose answer was lost is REFUNDED once the provider's own record shows the whole
    -- payment back (a person asked, two people). Never anything else from UNKNOWN.
    OR (OLD."providerRefundState" = 'UNKNOWN' AND NEW."providerRefundState" = 'REFUNDED')
  ) THEN
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
  IF OLD."providerRefundState" IS NULL AND NEW."providerRefundState" IS NOT NULL
     AND (OLD."status" = 'SUCCEEDED'
       OR EXISTS (SELECT 1 FROM "subscription_payments" p WHERE p."id" = NEW."paymentId" AND p."status" = 'CAPTURED')
       OR EXISTS (SELECT 1 FROM "billing_events" e WHERE e."idempotencyKey" = 'bank:' || NEW."paymentId")) THEN
    RAISE EXCEPTION 'card_sessions row %: a booked payment is never refunded here [PT-4]', OLD.id USING ERRCODE = 'check_violation';
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
    OR (OLD."state" IN ('UNKNOWN', 'PENDING') AND NEW."state" = 'REFUNDED')) THEN
    RAISE EXCEPTION 'card_credit_refunds row %: a refund claim only moves forward, once (% -> %) [CARD-READY]', OLD.id, OLD."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'SENDING'
     AND NOT (OLD."state" IN ('UNKNOWN', 'PENDING') AND NEW."state" = 'REFUNDED' AND OLD."providerRefundRef" IS NULL AND OLD."billingEventId" IS NULL)
     AND (NEW."providerRefundRef" IS DISTINCT FROM OLD."providerRefundRef"
       OR NEW."billingEventId" IS DISTINCT FROM OLD."billingEventId" OR NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt"
       OR NEW."outcomeReason" IS DISTINCT FROM OLD."outcomeReason" OR NEW."answerSha256" IS DISTINCT FROM OLD."answerSha256") THEN
    RAISE EXCEPTION 'card_credit_refunds row %: an answered refund is final [CARD-READY]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
