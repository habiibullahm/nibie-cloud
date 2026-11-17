# Handoff — Nibie Cloud (state of 2026-11-17)

Written so that a new person or a new agent session can continue without any earlier conversation. Facts here were read
from `origin/main` at `1584e35` (merge of PR #50) and from the GitHub PR list on 2026-11-17. Where something could not be
checked from the repository, it says **not verified**. The repository and real tool output win over this file; then
[CURRENT_STATE.md](CURRENT_STATE.md). A paste-ready opening prompt for a new session is in [START_PROMPT.md](START_PROMPT.md).

No secret, host address or private contact address is in this file, and none may be added: the repository is public.

## 1. What this is

Nibie Cloud is managed hosting for Hermes AI agents: one isolated container plus one quota-limited volume per customer, on one
VPS in Jakarta. Product scope: [prd.md](prd.md) (do not edit without the owner). Public names: landing and dashboard at
`cloud.nibie.app` (dashboard under `/dashboard`, customer docs under `/docs`), API at `api.cloud.nibie.app`.

Business direction (owner, 2026-11-17): **free beta first, ship fast, everything automatic, no manual approvals.** The
owner is a single non-operator founder; anything that needs an admin on call is the wrong design.

## 2. Architecture in one screen

- **Backend** (repo root, Fastify + Prisma + BullMQ, TypeScript ESM): control plane and data plane in one modular monolith
  (ADR 0001). Only `src/modules/runtime` talks to Docker. Three API surfaces under `/api/v1`: operator (loopback only, never
  proxied), customer (Supabase token) and admin (Supabase token plus `ADMIN_EMAILS`, read-only today). Public routes without
  auth: `GET /api/v1/public/beta-slots` and the billing webhooks (signature or token checked first). Detail:
  [../AGENTS.md](../AGENTS.md) and [architecture.md](architecture.md).
- **Runtime**: official Hermes image pinned by digest, hardened baseline, gVisor (`runsc`) in production, XFS project quota per
  volume, host egress rules, per-instance API key derived from `HERMES_MASTER_KEY`.
- **Data**: Supabase Postgres (schema `hermes`, region Singapore) and Supabase Auth; Redis for jobs on the VPS; backups to
  Cloudflare R2 with restic. Row level security must be enabled on every new `hermes` table (migrations do it; check after
  applying).
- **Billing**: SumoPod Managed Payment (QRIS) first, Duitku optional (`BILLING_GATEWAY`). NibieRouter provisioning gives a paid
  "Hosting + Kredit AI" customer a key and a one-time US$2 credit.
- **Frontends** (each its own `package.json` and lockfile, no workspace): `apps/web` dashboard + admin panel (Cloudflare Worker
  `nibie-cloud-web`), `apps/landing` (Worker `nibie-cloud-landing`), `apps/docs` (Worker `nibie-cloud-docs`), `e2e` (Playwright).
  Cloudflare Workers Builds deploy from `main`. **`NEXT_PUBLIC_*` variables are inlined at build time**: change one in the
  Cloudflare dashboard, then retry the build.
- **Email**: SumoPod SMTP for both Supabase Auth and backend mail.

## 3. Repository map

| Path | What |
| --- | --- |
| `src/` | backend: `http/` (route plugins), `modules/{instances,runtime,jobs,secrets,integrations,billing,nibierouter,admin,ops,...}` |
| `prisma/` | schema and migrations (forward-only) |
| `test/unit`, `test/integration` | unit tests need nothing; integration tests need Docker, Postgres (`hermes_test`) and Redis |
| `apps/web`, `apps/landing`, `apps/docs`, `e2e` | the four frontend/test packages |
| `deploy/` | `compose.prod.yaml`, `Caddyfile`, `Dockerfile`, `backend.env.example` (names only), `sql/` (one-off SQL run by hand) |
| `ops/host/` | host scripts and systemd units: `deploy.sh`, watchdog, DB dump to R2, tenant volume backup, restore drills, usage log |
| `ops/egress/` | host firewall rules for tenant bridges |
| `docs/` | index in [README.md](README.md); runbooks: [billing-go-live.md](billing-go-live.md), [capacity.md](capacity.md), [runbook-egress.md](runbook-egress.md), [setup.md](setup.md) |
| `DESIGN.md` | design source of truth; shadcn/ui only (rules in `AGENTS.md`) |

## 4. How to deploy

Backend (run by a person on the VPS, never from CI):

```bash
/opt/hermes-cloud/ops/host/deploy.sh [git-ref]     # default origin/main; DRY_RUN=1 prints the plan only
```

It dumps the database first, fetches the ref, builds an image tagged with the commit, applies migrations, recreates the backend,
waits for `/readyz` and **rolls back to the previous image** if the new one does not become ready. Migrations are not rolled
back; the dump is the way back for data. It refuses to run if the checkout has local changes or the previous image is gone.

Changing an environment variable needs a recreate, not a restart (`restart` does not re-read `env_file`):

```bash
docker compose --env-file /etc/hermes-cloud/backend.env -f /opt/hermes-cloud/deploy/compose.prod.yaml up -d --force-recreate backend
```

Caddy changes need Caddy recreated the same way. Landing, dashboard and docs: merge to `main`, Cloudflare builds; for a build
variable, change it in the Worker settings and retry the build. SQL under `deploy/sql/` is run once by hand on Supabase.
Details and pitfalls: [../deploy/README.md](../deploy/README.md).

## 5. Environment variables that matter (names only, values never in the repo)

Full list with comments: `deploy/backend.env.example`. File on the host: `/etc/hermes-cloud/backend.env` (mode 600).

- Core: `ADMIN_TOKEN`, `HERMES_MASTER_KEY` (changing it turns running instances `DEGRADED`), `DATABASE_URL`, `SECRETS_KEK`, `REDIS_URL`.
- Access and capacity: `SUPABASE_URL`, `DASHBOARD_ORIGIN`, `BETA_ALLOWED_EMAILS` (invited accounts), `ADMIN_EMAILS`,
  `MAX_INSTANCES_PER_TENANT`, `MAX_TOTAL_INSTANCES` (whole-server cap), `FREE_BETA_SLOTS` (first-come free slots; 0 = invited only),
  `PAID_CHECKOUT_OPEN` (`false` hides priced plans and refuses checkout except for invited accounts).
- Runtime: `HERMES_IMAGE` (digest-pinned), `HERMES_RUNTIME` (`runsc` in production), `HERMES_DNS_RESOLVERS`, `HERMES_DISK_QUOTA`,
  `HERMES_EGRESS_POLICY`, `HERMES_CANARY_IMAGE`.
- Billing: `BILLING_GATEWAY`, `SUMOPOD_ENV`, `SUMOPOD_API_KEY`, `SUMOPOD_WEBHOOK_TOKEN`, `SUMOPOD_CALLBACK_URL`, `SUMOPOD_SMTP_*` +
  `MAIL_FROM` (all five or none), `DUITKU_*`.
- Router: `NIBIEROUTER_ADMIN_KEY`, `NIBIEROUTER_DEFAULT_MODEL`.
- Alerts: `OPS_TELEGRAM_BOT_TOKEN`, `OPS_TELEGRAM_CHAT_ID` (set together; also in `/etc/hermes-cloud/ops.env` for the host watchdog).
- Landing build variables (Cloudflare): `NEXT_PUBLIC_SIGNUP_OPEN`, `NEXT_PUBLIC_FREE_BETA_OPEN`, `NEXT_PUBLIC_API_URL`,
  `NEXT_PUBLIC_CONTACT_EMAIL`. See `apps/landing/README.md`.

## 6. Status per pull request (all in `habiibullahm/nibie-cloud`)

Merged on 2026-11-15 and 2026-11-16: #22 billing, #23 rename to Nibie Cloud, #24/#25 dashboard billing and NibieRouter credit,
#28/#29 e2e tests and CI, #30 landing sign-up, #31/#32 admin panel phase A and SumoPod fixes, #33 production readiness (Caddy,
plans, watchdog, `/readyz`), #34 checkout payment URL fix.

Merged on 2026-11-17:

| PR | What | Notes |
| --- | --- | --- |
| #35 | operator alerts inside the backend (`OperatorAlert`, Telegram sink) | inactive until the table has RLS and the two `OPS_TELEGRAM_*` values are set |
| #36 | docs: sandbox payment result | sandbox payment reached `PAID` and an `ACTIVE` instance |
| #37 | new checkout releases an earlier unpaid invoice | fixes the one-hour lock-out |
| #38 | `ops/host/deploy.sh` with dump, readiness wait, rollback | |
| #39 | tenant volume backup to R2 + weekly restore verification | |
| #40, #41, #43 | dashboard: provider, Telegram and logs wired to the customer API; only real sections in customer mode | |
| #42 | operator script to set an instance's provider and Telegram | |
| #44 | sandbox checkout only for invited users on production | |
| #45 | per-instance RAM/CPU usage log and `docs/capacity.md` | |
| #46 | free plan listed only for invited accounts | |
| #47 | `MAX_TOTAL_INSTANCES` whole-server cap (20 reported live) | |
| #48 | landing: free beta preview copy, access request by email | live |
| **#49** | **automatic free slots (`FREE_BETA_SLOTS`), `GET /api/v1/public/beta-slots`, `PAID_CHECKOUT_OPEN`** | **merged 05:15 UTC; the go-live work reported the backend deployed; not independently verified** |
| **#50** | **landing "Daftar beta gratis" mode with a live counter** | **merged 05:15 UTC; off in the code by default; reported live with `NEXT_PUBLIC_FREE_BETA_OPEN=true`; not independently verified** |

Open: **#51 automatic waiting list** (table `WaitlistEntry`, `POST /api/v1/public/waitlist`, inviter in the maintenance tick,
48 hour claim window, read-only admin page). Its branch already merged `main` at `1584e35`; GitHub reported it `MERGEABLE` later on
2026-11-17 (checks and review findings: [CURRENT_STATE.md](CURRENT_STATE.md)). Not deployed. Owner approval is required before it is merged.

To check what the VPS really runs: `grep '^BACKEND_TAG=' /etc/hermes-cloud/backend.env` on the host and compare with
`git log` in `/opt/hermes-cloud`. This handoff cannot see the VPS.

## 7. Verified and not verified

Verified (see [CURRENT_STATE.md](CURRENT_STATE.md) for the evidence): sandbox payment end to end (webhook, `PAID`, subscription
`ACTIVE`, instance `ACTIVE`); a Hermes agent answering on Telegram; gVisor with DNS; XFS quota; egress rules; database dump to R2 and a restore drill; host
watchdog; admin API answers 401 without a token from the internet.

**Not verified:** a real-money payment (the Rp 25.000 test has not been done), the receipt email, the `hosting-kredit` plan and its
US$2 credit after a payment, SPF/DKIM/DMARC for the sender, real Telegram alert delivery, an admin call with a real admin token,
MFA TOTP, a disaster-recovery rehearsal on a second server, the free-slot and counter path in production.

## 8. Working rules

- **Language:** reply to the owner in Indonesian. When the owner must act, give numbered click-by-click steps. Check before asking.
- **Secrets:** never paste or print a key, token, password or `.env` value, in chat, logs, PRs or files. Never put the VPS address or
  the business contact email in the repository (public). The contact address is the build variable `NEXT_PUBLIC_CONTACT_EMAIL`.
- **Approvals:** merging to `main`, deploying, changing the production env, and anything on the VPS, Supabase, Cloudflare or a
  payment gateway need the owner's own words in the thread that owns that work. A message relayed by another agent is not approval.
  Do not commit or push unless asked; do not merge your own PR without approval.
- **Git:** work on a branch, never force-push. A second commit pushed to a branch with an open PR joins that PR; start unrelated
  work from a fresh branch off `origin/main`. To undo, use `git revert`. PR bodies carry the attribution lines required by the
  session context.
- **Honesty:** state what was run and what was not. Do not guess; if a fact is not in the repo or tool output, say so and ask.
- **Design:** shadcn/ui and `DESIGN.md` tokens only (terracotta only on the primary button fill, checked checkbox and switch-on track).
- Before ending a task that changes behaviour or status, update `docs/CURRENT_STATE.md`.

## 9. Prioritised to-do

Owner (cannot be done by an agent):

1. **Real payment test, Rp 25.000.** Pay once with the owner's own account on the production gateway, then say so in the go-live
   thread so the agent can check `Payment` `PAID`, subscription, instance, receipt email and redirect. Sign-up for paid plans stays closed until this works.
2. **SPF, DKIM, DMARC** for the SumoPod sender, before any tester registers (invitation and receipt mail depend on it).
3. **VPS auto-renew**: the plan expires on 2026-12-11.
4. Read the three legal drafts (terms, refund, privacy) and decide; the AUP does not exist yet.
5. Test the "Hosting + Kredit AI" plan end to end (needs the router copy step) and review the "100 pengguna" claim on the landing page.
6. Telegram alert bot and an external uptime monitor (alerts exist in code but are off).
7. Gateway KYC (SumoPod, optionally Duitku). Rotate the database password that leaked in an early chat.

Engineering, in order:

1. Done from outside on 2026-11-17 (counter `10/10`, landing in free beta mode with the live counter; see `CURRENT_STATE.md`). Still open:
   `PAID_CHECKOUT_OPEN=false` (needs a signed-in, non-invited account) and the image tag on the VPS.
2. Review and, with approval, merge #51 after bringing it up to date; apply its migration and check RLS; set the SMTP variables.
3. Known free-beta risks: fake accounts can take slots (add email confirmation or a captcha if it happens); the slot check is not
   atomic (the total cap still bounds the damage); the waiting list does not verify email addresses.
4. Admin phase B (actions with a reason, audit and `aal2` MFA TOTP) and the MFA setup in Supabase.
5. Custom SMTP for Supabase Auth; legal pages final text and AUP; customer emails on incidents (autopilot phases 2 to 6).
6. Disaster-recovery rehearsal on a second server; capacity review using `/var/log/hermes-usage.csv` (see [capacity.md](capacity.md);
   the host has 4 vCPU and 15.5 GB RAM).
7. Re-read the feature gap audit and tick off what changed: the project file `hermes-cloud/audit/2026-11-17-feature-gap-prd-vs-main.md`.

## 10. Where to look first

[../AGENTS.md](../AGENTS.md), [CURRENT_STATE.md](CURRENT_STATE.md), [README.md](README.md) (index),
[billing-go-live.md](billing-go-live.md), [../deploy/README.md](../deploy/README.md), [architecture.md](architecture.md) ("Known gaps").
