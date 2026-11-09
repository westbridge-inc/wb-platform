-- [CARD-READY] Weekly-fee money a partner paid ahead by card is paid back to the same card through
-- the card provider's documented refund (PowerTranz Ecommerce API Guide v2.7 sec. 5.2 / 7.5:
-- POST /api/refund naming the ORIGINAL TransactionIdentifier). One row per original card payment,
-- ever: it is the durable claim written BEFORE the one call, and it records the provider's answer.
-- Additive: one new table, no existing row changes.
--
-- ROLLBACK: rollback.sql beside this file (refused once any refund was asked).

SET lock_timeout = '10s';

CREATE TABLE "card_credit_refunds" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "cardSessionId" TEXT NOT NULL,
    "setAsideId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'SENDING',
    "providerRefundRef" TEXT,
    "outcomeReason" TEXT,
    "answerSha256" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "billingEventId" TEXT,

    CONSTRAINT "card_credit_refunds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "card_credit_refunds_cardSessionId_key" ON "card_credit_refunds"("cardSessionId");

CREATE UNIQUE INDEX "card_credit_refunds_approvalId_key" ON "card_credit_refunds"("approvalId");

CREATE UNIQUE INDEX "card_credit_refunds_billingEventId_key" ON "card_credit_refunds"("billingEventId");

CREATE INDEX "card_credit_refunds_tenantId_idx" ON "card_credit_refunds"("tenantId");

CREATE INDEX "card_credit_refunds_subscriptionId_idx" ON "card_credit_refunds"("subscriptionId");

CREATE INDEX "card_credit_refunds_setAsideId_idx" ON "card_credit_refunds"("setAsideId");

ALTER TABLE "card_credit_refunds"
  ADD CONSTRAINT "card_credit_refunds_state_check" CHECK ("state" IN ('SENDING', 'REFUNDED', 'FAILED', 'UNKNOWN', 'PENDING')),
  ADD CONSTRAINT "card_credit_refunds_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "card_credit_refunds_refunded_check"
    CHECK (("state" = 'REFUNDED') = ("providerRefundRef" IS NOT NULL AND "billingEventId" IS NOT NULL AND "answeredAt" IS NOT NULL));

-- What was asked is written once; the claim only moves forward, once: SENDING -> one answer.
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
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (OLD."state" = 'SENDING' AND NEW."state" IN ('REFUNDED', 'FAILED', 'UNKNOWN', 'PENDING')) THEN
    RAISE EXCEPTION 'card_credit_refunds row %: a refund claim only moves forward, once (% -> %) [CARD-READY]', OLD.id, OLD."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'SENDING' AND (NEW."providerRefundRef" IS DISTINCT FROM OLD."providerRefundRef"
       OR NEW."billingEventId" IS DISTINCT FROM OLD."billingEventId" OR NEW."answeredAt" IS DISTINCT FROM OLD."answeredAt"
       OR NEW."outcomeReason" IS DISTINCT FROM OLD."outcomeReason" OR NEW."answerSha256" IS DISTINCT FROM OLD."answerSha256") THEN
    RAISE EXCEPTION 'card_credit_refunds row %: an answered refund is final [CARD-READY]', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER card_credit_refunds_guard BEFORE INSERT OR UPDATE ON "card_credit_refunds"
  FOR EACH ROW EXECUTE FUNCTION card_credit_refunds_guard();

ALTER TABLE "card_credit_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "card_credit_refunds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "card_credit_refunds";
CREATE POLICY "tenant_isolation" ON "card_credit_refunds"
      USING (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')))
      WITH CHECK (("tenantId" = current_setting('app.current_tenant', true)
      OR pg_has_role(current_user, 'swift_bypass_rls', 'MEMBER')));
