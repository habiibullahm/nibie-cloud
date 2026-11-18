-- +goose Up
-- Copied verbatim from prisma/migrations/20261112190000_add_disk_usage/migration.sql (Go port, spec section 3).

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "diskLevel" TEXT NOT NULL DEFAULT 'ok',
ADD COLUMN     "diskUsedBytes" BIGINT;
