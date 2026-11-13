-- [AUDIT C2-5 · 13 Nov 2026] billing_events is the weekly fee's money history ("Immutable billing audit log — every
-- money event, append-only", schema.prisma). App code never deletes a row, but nothing in the database said so: one
-- stray DELETE would erase a payment's record. A row is now removed only with its subscription (the FK cascade, when the
-- parent row is already gone in the same statement) or by an explicit purge that sets swift.billing_events_purge = 'on'
-- for its own session (the disposable test databases set it, see src/__tests__/setup/billing-cutover.ts). Production
-- code never sets it. TRUNCATE is refused the same way.
CREATE OR REPLACE FUNCTION "billing_events_no_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The subscription's own deletion cascades here after its row is gone.
    IF NOT EXISTS (SELECT 1 FROM "subscriptions" s WHERE s."id" = OLD."subscriptionId") THEN
      RETURN OLD;
    END IF;
  END IF;
  IF coalesce(current_setting('swift.billing_events_purge', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NULL END;
  END IF;
  RAISE EXCEPTION 'billing_events is append-only: a billing event is never deleted (record a correcting event instead)'
    USING ERRCODE = 'restrict_violation';
END;
$$;
-- statement-breakpoint
CREATE TRIGGER "billing_events_no_delete"
  BEFORE DELETE ON "billing_events"
  FOR EACH ROW EXECUTE FUNCTION "billing_events_no_delete"();
-- statement-breakpoint
CREATE TRIGGER "billing_events_no_truncate"
  BEFORE TRUNCATE ON "billing_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "billing_events_no_delete"();
