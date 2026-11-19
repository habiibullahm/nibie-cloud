-- CreateEnum
CREATE TYPE "WalletEntryKind" AS ENUM ('TOPUP', 'HOSTING', 'AUTO_RENEW', 'AI_CREDIT', 'ADMIN_CREDIT', 'ADMIN_DEBIT');

-- CreateTable
CREATE TABLE "Wallet" (
    "tenantId" UUID NOT NULL,
    "balanceIdr" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "WalletEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "amountIdr" INTEGER NOT NULL,
    "kind" "WalletEntryKind" NOT NULL,
    "refId" TEXT NOT NULL,
    "balanceAfterIdr" INTEGER NOT NULL,
    "note" TEXT,
    "actorEmail" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTopup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "merchantOrderId" TEXT NOT NULL,
    "amountIdr" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "reference" TEXT,
    "paymentUrl" TEXT,
    "resultCode" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WalletTopup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletEntry_tenantId_createdAt_idx" ON "WalletEntry"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletEntry_kind_refId_key" ON "WalletEntry"("kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTopup_merchantOrderId_key" ON "WalletTopup"("merchantOrderId");

-- CreateIndex
CREATE INDEX "WalletTopup_status_expiresAt_idx" ON "WalletTopup"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTopup_tenantId_idempotencyKey_key" ON "WalletTopup"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEntry" ADD CONSTRAINT "WalletEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTopup" ADD CONSTRAINT "WalletTopup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The balance can never go below zero, whatever code path writes it.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_balanceIdr_nonnegative" CHECK ("balanceIdr" >= 0);

-- Row level security: balances and payments of customers. The backend connects as the table owner (which bypasses RLS);
-- no policy is defined, so any other role, including Supabase's anon and authenticated roles through the Data API, sees nothing.
ALTER TABLE "Wallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalletEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WalletTopup" ENABLE ROW LEVEL SECURITY;
