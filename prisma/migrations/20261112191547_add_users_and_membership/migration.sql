-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('OWNER');

-- AlterTable
-- `name` is added nullable and backfilled from `slug` so existing rows survive, then made required.
ALTER TABLE "Plan" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "name" TEXT;
UPDATE "Plan" SET "name" = "slug" WHERE "name" IS NULL;
ALTER TABLE "Plan" ALTER COLUMN "name" SET NOT NULL;

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantMember" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TenantRole" NOT NULL DEFAULT 'OWNER',

    CONSTRAINT "TenantMember_pkey" PRIMARY KEY ("tenantId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantMember_userId_key" ON "TenantMember"("userId");

-- AddForeignKey
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
