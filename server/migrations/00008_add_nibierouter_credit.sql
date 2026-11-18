-- +goose Up
-- Copied verbatim from prisma/migrations/20261115010000_add_nibierouter_credit/migration.sql (Go port, spec section 3).

-- CreateEnum
CREATE TYPE "CreditGrantStatus" AS ENUM ('PENDING', 'DONE');

-- CreateEnum
CREATE TYPE "RouterProvisioningStatus" AS ENUM ('PENDING', 'DONE');

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "includedCreditNano" BIGINT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "routerUserId" TEXT;

-- CreateTable
CREATE TABLE "CreditGrant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "amountNano" BIGINT NOT NULL,
    "note" TEXT NOT NULL,
    "status" "CreditGrantStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "balanceAfterNano" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RouterProvisioning" (
    "instanceId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subscriptionId" UUID,
    "status" "RouterProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RouterProvisioning_pkey" PRIMARY KEY ("instanceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreditGrant_subscriptionId_key" ON "CreditGrant"("subscriptionId");

-- AddForeignKey
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

