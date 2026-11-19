-- Storage 5 GB -> 10 GB for the plan with AI credit (owner decision, 2026-11-20). Hosting stays at 5 GB.
-- Applied by hand on 2026-11-20 against the Supabase project. Idempotent: safe to re-run.
-- Affects instances created afterwards only: a volume's quota is set when it is created (no Kredit instance existed).
-- Tenant volumes share one 100 GB XFS image (/srv/hermes-volumes.img), so stock x storage of all priced plans should stay
-- within it; see docs/disk-quota-host-notes.md.

update hermes."Plan" set "storageMb" = 10240 where slug = 'hosting-kredit' and "storageMb" <> 10240;

select slug, name, "storageMb", "monthlyPriceIdr", "stockLimit" from hermes."Plan" order by slug;
