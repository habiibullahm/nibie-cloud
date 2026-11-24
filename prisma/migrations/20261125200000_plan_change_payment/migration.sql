-- Paid-to-paid plan changes: new payment/invoice kinds and prorated target/credit snapshot.
ALTER TYPE "PaymentPurpose" ADD VALUE 'PLAN_CHANGE';
ALTER TYPE "InvoiceKind" ADD VALUE 'HOSTING_PLAN_CHANGE';

ALTER TABLE "Payment"
    ADD COLUMN "fromPlanId" UUID,
    ADD COLUMN "targetPlanId" UUID,
    ADD COLUMN "creditNano" BIGINT;
