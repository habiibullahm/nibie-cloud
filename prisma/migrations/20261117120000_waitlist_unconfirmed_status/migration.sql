-- Double opt-in for the beta waiting list, part 1. A new enum value cannot be used in the same transaction that adds it,
-- so the column default that uses it is set in the next migration.
ALTER TYPE "WaitlistStatus" ADD VALUE IF NOT EXISTS 'UNCONFIRMED' BEFORE 'WAITING';
