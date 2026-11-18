-- +goose Up
-- Copied verbatim from prisma/migrations/20261117120100_waitlist_confirmation/migration.sql (Go port, spec section 3).

-- Double opt-in for the beta waiting list, part 2. New entries start UNCONFIRMED and count only after the person
-- confirms the address. Existing rows (if any) keep their status. Row level security stays enabled on this table.
ALTER TABLE "WaitlistEntry" ALTER COLUMN "status" SET DEFAULT 'UNCONFIRMED';
ALTER TABLE "WaitlistEntry" ADD COLUMN "confirmTokenHash" TEXT,
ADD COLUMN "confirmSentAt" TIMESTAMPTZ(3),
ADD COLUMN "confirmExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN "confirmedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_confirmTokenHash_key" ON "WaitlistEntry"("confirmTokenHash");
