-- Stock per priced plan, set from the admin panel. Null: no limit.
ALTER TABLE "Plan" ADD COLUMN "stockLimit" INTEGER;
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_stockLimit_nonnegative" CHECK ("stockLimit" IS NULL OR "stockLimit" >= 0);
