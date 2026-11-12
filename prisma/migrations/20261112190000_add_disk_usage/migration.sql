-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "diskLevel" TEXT NOT NULL DEFAULT 'ok',
ADD COLUMN     "diskUsedBytes" BIGINT;
