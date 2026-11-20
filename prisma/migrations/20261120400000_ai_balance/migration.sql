-- AI balance in Rupiah and the low-balance reminder (NibieRouter step 3).
ALTER TABLE "Tenant"
    ADD COLUMN "aiLowAlert" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "aiLowThresholdIdr" INTEGER NOT NULL DEFAULT 10000,
    ADD COLUMN "aiLowNotifiedAt" TIMESTAMPTZ(3),
    ADD CONSTRAINT "Tenant_aiLowThresholdIdr_range" CHECK ("aiLowThresholdIdr" BETWEEN 1000 AND 1000000);

-- Admin billing settings, a single row (id = 1). Null rate: the router's own rate is used.
CREATE TABLE "BillingSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "aiCreditIdrPerUsd" INTEGER,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BillingSetting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingSetting_single_row" CHECK ("id" = 1),
    CONSTRAINT "BillingSetting_rate_range" CHECK ("aiCreditIdrPerUsd" IS NULL OR "aiCreditIdrPerUsd" BETWEEN 5000 AND 50000)
);

-- Row level security, like every other table: the backend connects as the owner (which bypasses RLS) and no policy is
-- defined, so Supabase's anon and authenticated roles see nothing through the Data API.
ALTER TABLE "BillingSetting" ENABLE ROW LEVEL SECURITY;
