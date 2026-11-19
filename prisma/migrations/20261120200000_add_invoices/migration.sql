-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('HOSTING_NEW', 'HOSTING_RENEWAL', 'TOPUP');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "planName" TEXT,
    "instanceName" TEXT,
    "amountIdr" INTEGER NOT NULL,
    "paidAt" TIMESTAMPTZ(3) NOT NULL,
    "paymentId" UUID,
    "walletTopupId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceCounter" (
    "period" TEXT NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "InvoiceCounter_pkey" PRIMARY KEY ("period")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_paymentId_key" ON "Invoice"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_walletTopupId_key" ON "Invoice"("walletTopupId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_paidAt_idx" ON "Invoice"("tenantId", "paidAt");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_walletTopupId_fkey" FOREIGN KEY ("walletTopupId") REFERENCES "WalletTopup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An invoice is for exactly one paid thing.
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_one_source" CHECK (("paymentId" IS NULL) <> ("walletTopupId" IS NULL));

-- Invoices for everything already paid, numbered per month (Asia/Jakarta) in the order it was paid.
WITH paid AS (
  SELECT p."id" AS "paymentId", NULL::uuid AS "walletTopupId", s."tenantId", p."amountIdr", p."paidAt",
         (CASE p."purpose" WHEN 'RENEWAL' THEN 'HOSTING_RENEWAL' ELSE 'HOSTING_NEW' END)::"InvoiceKind" AS "kind",
         pl."name" AS "planName", s."intendedName" AS "instanceName"
  FROM "Payment" p
  JOIN "Subscription" s ON s."id" = p."subscriptionId"
  JOIN "Plan" pl ON pl."id" = s."planId"
  WHERE p."status" = 'PAID' AND p."paidAt" IS NOT NULL
  UNION ALL
  SELECT NULL::uuid, t."id", t."tenantId", t."amountIdr", t."paidAt", 'TOPUP'::"InvoiceKind", NULL, NULL
  FROM "WalletTopup" t
  WHERE t."status" = 'PAID' AND t."paidAt" IS NOT NULL
), numbered AS (
  SELECT paid.*, to_char(paid."paidAt" AT TIME ZONE 'Asia/Jakarta', 'YYYY/MM') AS "period"
  FROM paid
), sequenced AS (
  SELECT numbered.*,
         row_number() OVER (PARTITION BY "period" ORDER BY "paidAt", COALESCE("paymentId", "walletTopupId")) AS "seq"
  FROM numbered
)
INSERT INTO "Invoice" ("id", "number", "tenantId", "kind", "planName", "instanceName", "amountIdr", "paidAt", "paymentId", "walletTopupId")
SELECT gen_random_uuid(), 'INV/' || "period" || '/' || lpad("seq"::text, 4, '0'), "tenantId", "kind", "planName", "instanceName",
       "amountIdr", "paidAt", "paymentId", "walletTopupId"
FROM sequenced;

INSERT INTO "InvoiceCounter" ("period", "last")
SELECT substring("number" FROM 5 FOR 7), count(*)::int FROM "Invoice" GROUP BY 1;

-- Row level security, like the other customer tables: no policy, so only the table owner (the backend) reads them.
ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceCounter" ENABLE ROW LEVEL SECURITY;
