-- +goose Up
-- Copied verbatim from prisma/migrations/20261119100000_add_admin_api_key/migration.sql (Go port, spec section 3).

-- CreateTable
CREATE TABLE "AdminApiKey" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AdminApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminApiKey_hash_key" ON "AdminApiKey"("hash");


-- Row level security: these rows unlock the admin API. The backend connects as the table owner (which bypasses RLS); no
-- policy is defined, so any other role, including Supabase's anon and authenticated roles through the Data API, sees nothing.
ALTER TABLE "AdminApiKey" ENABLE ROW LEVEL SECURITY;
