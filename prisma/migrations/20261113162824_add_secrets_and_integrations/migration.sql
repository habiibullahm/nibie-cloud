-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('BYOK', 'NIBIEROUTER');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('UNTESTED', 'OK', 'FAILED');

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "appliedRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "configRevision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Secret" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "wrapIv" TEXT NOT NULL,
    "wrapTag" TEXT NOT NULL,
    "kekVersion" INTEGER NOT NULL,
    "keyHint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "secretId" UUID NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'UNTESTED',
    "lastTestedAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramConnection" (
    "id" UUID NOT NULL,
    "instanceId" UUID NOT NULL,
    "secretId" UUID NOT NULL,
    "botId" TEXT NOT NULL,
    "botUsername" TEXT NOT NULL,
    "allowedUserIds" TEXT[],
    "status" "IntegrationStatus" NOT NULL DEFAULT 'UNTESTED',
    "lastErrorCode" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TelegramConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Secret_tenantId_idx" ON "Secret"("tenantId");

-- CreateIndex
CREATE INDEX "Secret_kekVersion_idx" ON "Secret"("kekVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConfig_instanceId_key" ON "ProviderConfig"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConfig_secretId_key" ON "ProviderConfig"("secretId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConnection_instanceId_key" ON "TelegramConnection"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConnection_secretId_key" ON "TelegramConnection"("secretId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConnection_botId_key" ON "TelegramConnection"("botId");

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConfig" ADD CONSTRAINT "ProviderConfig_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderConfig" ADD CONSTRAINT "ProviderConfig_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramConnection" ADD CONSTRAINT "TelegramConnection_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramConnection" ADD CONSTRAINT "TelegramConnection_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "Secret"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
