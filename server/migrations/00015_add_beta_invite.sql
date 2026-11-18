-- +goose Up
-- Copied verbatim from prisma/migrations/20261118100000_add_beta_invite/migration.sql (Go port, spec section 3).

-- CreateTable
CREATE TABLE "BetaInvite" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "addedBy" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BetaInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BetaInvite_email_key" ON "BetaInvite"("email");


-- Row level security: the invite list holds email addresses. The backend connects as the table owner (which bypasses
-- RLS); no policy is defined, so any other role, including Supabase's anon and authenticated roles through the Data
-- API, sees nothing.
ALTER TABLE "BetaInvite" ENABLE ROW LEVEL SECURITY;
