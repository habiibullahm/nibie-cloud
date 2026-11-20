-- AI credit bought from the wallet (NibieRouter step 4): a CreditGrant without a subscription.
ALTER TABLE "CreditGrant"
    ALTER COLUMN "subscriptionId" DROP NOT NULL,
    ADD COLUMN "amountIdr" INTEGER,
    ADD COLUMN "idempotencyKey" TEXT,
    ADD CONSTRAINT "CreditGrant_purchase_shape" CHECK (
        ("subscriptionId" IS NOT NULL AND "amountIdr" IS NULL AND "idempotencyKey" IS NULL)
        OR ("subscriptionId" IS NULL AND "amountIdr" > 0 AND "idempotencyKey" IS NOT NULL)
    );

CREATE UNIQUE INDEX "CreditGrant_tenantId_idempotencyKey_key" ON "CreditGrant"("tenantId", "idempotencyKey");
