-- +goose Up
-- Copied verbatim from prisma/migrations/20261111145959_add_stopping_status/migration.sql (Go port, spec section 3).

-- AlterEnum
ALTER TYPE "InstanceStatus" ADD VALUE 'STOPPING';
