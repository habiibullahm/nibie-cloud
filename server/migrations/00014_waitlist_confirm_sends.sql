-- +goose Up
-- Copied verbatim from prisma/migrations/20261118090000_waitlist_confirm_sends/migration.sql (Go port, spec section 3).

-- How many confirmation emails one waiting-list entry has been sent. The backend stops at a small number per address,
-- so a stranger cannot make the platform mail the same inbox again and again. Existing rows start at 0.
-- Row level security stays enabled on this table.
ALTER TABLE "WaitlistEntry" ADD COLUMN "confirmSends" INTEGER NOT NULL DEFAULT 0;
