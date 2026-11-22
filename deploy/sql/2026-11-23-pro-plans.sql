-- Pro plans: 2 CPU, 2 GB RAM, 20 GB storage (owner decision, 2026-11-23). Match apps/landing/src/lib/plans.ts.
-- Run by hand against the Supabase project. Idempotent: safe to re-run.
-- Never part of a Prisma migration (prices are an operator decision, see scripts/seed-sandbox-plans.ts).
--
--   pro         Rp 49.000 / 30 days (beta)   2 CPU, 2 GB RAM, 20 GB storage, no AI credit
--   pro-kredit  Rp 79.000 / 30 days (beta)   same limits + one-time NibieRouter credit of US$3
--
-- New rows start with stock 0 (sold out; null would mean unlimited). Stock is then set through the admin API
-- (POST /api/v1/admin/plans/:planId/stock), so it is audited, and a re-run never touches it:
-- hosting 3, hosting-kredit 6, pro 2, pro-kredit 2 on the one node (4 vCPU, 16 GB). RAM limits then add up to
-- 17 GB plus the free beta instances; storage caps add up to 155 GB on the shared 100 GB XFS volume image
-- (docs/disk-quota-host-notes.md), which relies on real use staying far below the caps.

insert into hermes."Plan" (id, slug, name, active, "cpuMillis", "memoryMb", pids, "storageMb", "monthlyPriceIdr", "includedCreditNano", "stockLimit")
values
  (gen_random_uuid(), 'pro',        'Pro',              true, 2000, 2048, 256, 20480, 49000, null,       0),
  (gen_random_uuid(), 'pro-kredit', 'Pro + Kredit AI',  true, 2000, 2048, 256, 20480, 79000, 3000000000, 0)
on conflict (slug) do update set
  name = excluded.name,
  active = excluded.active,
  "cpuMillis" = excluded."cpuMillis",
  "memoryMb" = excluded."memoryMb",
  pids = excluded.pids,
  "storageMb" = excluded."storageMb",
  "monthlyPriceIdr" = excluded."monthlyPriceIdr",
  "includedCreditNano" = excluded."includedCreditNano";

select slug, name, "cpuMillis", "memoryMb", "storageMb", "monthlyPriceIdr", "includedCreditNano", "stockLimit"
from hermes."Plan" order by slug;
