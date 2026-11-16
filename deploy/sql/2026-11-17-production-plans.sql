-- Production plans that match the landing page (apps/landing/src/lib/site.ts), beta prices.
-- Run by hand against the Supabase project once. Idempotent: safe to re-run.
-- Never part of a Prisma migration (prices are an operator decision, see scripts/seed-sandbox-plans.ts).
--
--   hosting         Rp 25.000 / 30 days (beta)   1 CPU, 1 GB RAM, 1 GB storage
--   hosting-kredit  Rp 50.000 / 30 days (beta)   same limits + one-time NibieRouter credit of US$2
--
-- `beta-starter` (2 GB RAM, 5 GB storage) is kept for the instances that already run on it, but is no
-- longer for sale (price null), so the sandbox test price of Rp 10.000 is gone.

insert into hermes."Plan" (id, slug, name, active, "cpuMillis", "memoryMb", pids, "storageMb", "monthlyPriceIdr", "includedCreditNano")
values
  (gen_random_uuid(), 'hosting',        'Hosting',              true, 1000, 1024, 256, 1024, 25000, null),
  (gen_random_uuid(), 'hosting-kredit', 'Hosting + Kredit AI',  true, 1000, 1024, 256, 1024, 50000, 2000000000)
on conflict (slug) do update set
  name = excluded.name,
  active = excluded.active,
  "cpuMillis" = excluded."cpuMillis",
  "memoryMb" = excluded."memoryMb",
  pids = excluded.pids,
  "storageMb" = excluded."storageMb",
  "monthlyPriceIdr" = excluded."monthlyPriceIdr",
  "includedCreditNano" = excluded."includedCreditNano";

update hermes."Plan" set "monthlyPriceIdr" = null where slug = 'beta-starter';
