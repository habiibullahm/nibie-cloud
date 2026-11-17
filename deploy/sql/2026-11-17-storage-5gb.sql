-- Storage 1 GB -> 5 GB for the paid 1 CPU / 1 GB plans (owner decision, 2026-11-17).
-- Why: Hermes warns "Low disk space" whenever its disk has less than 2 GiB free, so a 1 GB volume warned on every
-- instance. 5 GB keeps 20 instances (MAX_TOTAL_INSTANCES) within the
-- 100 GB tenant XFS image even when every volume is full.
--
-- Run by hand against the Supabase project, after the owner approves it. Idempotent: safe to re-run.
-- Affects instances created afterwards only: a volume's quota is set when it is created. Existing volumes keep their
-- size and record one `disk.quota_mismatch` event; growing them is a host step (docs/disk-quota-host-notes.md).
-- beta-starter (the free plan) already has 5 GB and is not touched.

update hermes."Plan" set "storageMb" = 5120 where slug in ('hosting', 'hosting-kredit') and "storageMb" <> 5120;

select slug, name, "storageMb", "monthlyPriceIdr" from hermes."Plan" order by slug;
