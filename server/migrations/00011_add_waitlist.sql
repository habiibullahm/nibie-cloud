-- +goose Up
-- Copied verbatim from prisma/migrations/20261117050000_add_waitlist/migration.sql (Go port, spec section 3).

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'INVITED', 'REGISTERED');

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "useCase" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invitedAt" TIMESTAMPTZ(3),
    "inviteExpiresAt" TIMESTAMPTZ(3),
    "inviteFailures" INTEGER NOT NULL DEFAULT 0,
    "registeredAt" TIMESTAMPTZ(3),

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_email_key" ON "WaitlistEntry"("email");

-- CreateIndex
CREATE INDEX "WaitlistEntry_status_createdAt_idx" ON "WaitlistEntry"("status", "createdAt");


-- Row level security: the waiting list holds names, emails and free text. The backend connects as the table owner
-- (which bypasses RLS); no policy is defined, so any other role, including Supabase's anon and authenticated roles
-- through the Data API, sees nothing.
ALTER TABLE "WaitlistEntry" ENABLE ROW LEVEL SECURITY;
