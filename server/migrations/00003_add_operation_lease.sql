-- +goose Up
-- Copied verbatim from prisma/migrations/20261111153306_add_operation_lease/migration.sql (Go port, spec section 3).

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "leaseExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "operationOwner" UUID;

-- CreateIndex
CREATE INDEX "Instance_status_leaseExpiresAt_idx" ON "Instance"("status", "leaseExpiresAt");
