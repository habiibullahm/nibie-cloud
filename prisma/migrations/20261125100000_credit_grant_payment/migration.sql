-- Payment-keyed credit grants (renewal or plan change); the first payment's credit stays keyed on subscriptionId.
ALTER TABLE "CreditGrant"
    DROP CONSTRAINT "CreditGrant_purchase_shape",
    ADD COLUMN "paymentId" UUID,
    ADD CONSTRAINT "CreditGrant_purchase_shape" CHECK (
        ("subscriptionId" IS NOT NULL AND "paymentId" IS NULL AND "amountIdr" IS NULL AND "idempotencyKey" IS NULL)
        OR ("subscriptionId" IS NULL AND "paymentId" IS NOT NULL AND "amountIdr" IS NULL AND "idempotencyKey" IS NULL)
        OR ("subscriptionId" IS NULL AND "paymentId" IS NULL AND "amountIdr" > 0 AND "idempotencyKey" IS NOT NULL)
    );

CREATE UNIQUE INDEX "CreditGrant_paymentId_key" ON "CreditGrant"("paymentId");
