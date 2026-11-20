-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('QRIS', 'WALLET');

-- AlterTable: every existing payment was made by QRIS.
ALTER TABLE "Payment" ADD COLUMN "method" "PaymentMethod" NOT NULL DEFAULT 'QRIS';

-- AlterTable: renewal from the wallet is on by default (owner decision 2026-11-20); it only runs while WALLET_AUTO_RENEW is on.
ALTER TABLE "Subscription" ADD COLUMN "autoRenew" BOOLEAN NOT NULL DEFAULT true;
