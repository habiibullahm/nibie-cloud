-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "leaseExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "operationOwner" UUID;

-- CreateIndex
CREATE INDEX "Instance_status_leaseExpiresAt_idx" ON "Instance"("status", "leaseExpiresAt");
