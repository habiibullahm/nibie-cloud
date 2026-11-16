# Billing go-live runbook (SumoPod first, Duitku as an option)

Owner decision of 2026-11-17: **SumoPod Managed Payment** is the first gateway. Duitku stays supported
(`BILLING_GATEWAY=duitku` or `both`) and is a fallback. Nothing in this file contains a credential; the real
values live only in `/etc/hermes-cloud/backend.env` (mode 600) and in the gateway dashboards.

## State before go-live (checked 2026-11-17)

- VPS runs the backend with the billing code, but **no gateway variable is set**, so billing is off and the
  checkout answers "not available". The signup button on the landing page is closed
  (`NEXT_PUBLIC_SIGNUP_OPEN=false` on the Worker `nibie-cloud-landing`).
- Caddy forwards `/api/v1/billing/sumopod/webhook` and `/api/v1/billing/duitku/callback` (PR #33). The SumoPod route
  answers 404 until the SumoPod variables are set, because the backend registers it only then.
- Plans in the database match the landing: `hosting` Rp 25.000 and `hosting-kredit` Rp 50.000 (beta), 1 CPU,
  1 GB RAM, 1 GB storage; `hosting-kredit` grants a one-time US$2 NibieRouter credit.
- The dashboard Worker `nibie-cloud-web` already runs in `customer` mode against `https://api.cloud.nibie.app`.
- Checkout must return the payment URL. The fix is in the owner's uncommitted `billing-service.ts` change
  (return the updated payment row); it must be on `main` before the first real check-out.

## Variables to set (names only)

| Variable | Sandbox | Production |
| --- | --- | --- |
| `BILLING_GATEWAY` | `sumopod` | `sumopod` |
| `SUMOPOD_ENV` | `sandbox` | `production` (needs `NODE_ENV=production`, which the VPS already has) |
| `SUMOPOD_API_KEY` | sandbox key from the SumoPod dashboard | production key (after KYC) |
| `SUMOPOD_WEBHOOK_TOKEN` | token shown for the sandbox webhook | token shown for the production webhook |
| `SUMOPOD_CALLBACK_URL` | `https://api.cloud.nibie.app/api/v1/billing/sumopod/webhook` | same |
| `SUMOPOD_SMTP_*`, `MAIL_FROM` | all five or none | all five (receipts and reminders) |

The return URL after payment is built from `DASHBOARD_ORIGIN` (`https://cloud.nibie.app`, already https).
The webhook URL is also entered in the SumoPod dashboard; the variable only has to be a valid https URL.

## Steps on the VPS (operator)

1. Back up the env file: `sudo cp /etc/hermes-cloud/backend.env /etc/hermes-cloud/backend.env.bak-$(date -u +%Y%m%dT%H%M%SZ)`.
2. Add the variables above to `/etc/hermes-cloud/backend.env` (editor, not shell history; no spaces, no quotes).
3. Recreate: `docker compose --env-file /etc/hermes-cloud/backend.env -f /opt/hermes-cloud/deploy/compose.prod.yaml up -d --force-recreate backend`
   (`restart` does not re-read `env_file`). A wrong or half-set group makes the backend refuse to start; read
   `docker logs` and fix the variable named in the message.
4. From outside: `POST https://api.cloud.nibie.app/api/v1/billing/sumopod/webhook` without the token must answer
   401/403, not 404. A 404 means the SumoPod variables are not all set.
5. In the SumoPod dashboard set the webhook URL to the same address and press "Save & Test"; a `payment.test`
   delivery must answer 200.

## Sandbox test, then production

1. Sandbox: with a test account in `BETA_ALLOWED_EMAILS` or a normal account, open the dashboard, pick a plan,
   check out. SumoPod's sandbox has no "simulate payment" control, so a full `PAID` path can only be proven with a
   real production payment of the smallest plan (Rp 25.000) after KYC. Until then the webhook is covered by
   `test/integration/sumopod-webhook.test.ts` (fake gateway) and SumoPod's own "Save & Test".
2. Production: swap `SUMOPOD_ENV`, `SUMOPOD_API_KEY` and `SUMOPOD_WEBHOOK_TOKEN` for the production values, set
   the same webhook URL in the production project, recreate the backend, then buy the cheapest plan once with
   your own account and check, in order: the redirect back to the dashboard, `Payment` row `PAID`, the
   subscription `ACTIVE`, the instance reaching `ACTIVE`, the receipt email, and (for `hosting-kredit`) the
   router credit.
3. Only then open sign-up: remove `NEXT_PUBLIC_SIGNUP_OPEN` (or set it to `true`) on the landing Worker and retry
   the build.

## Rollback

Remove the SumoPod variables (or set `SUMOPOD_ENV=sandbox`), recreate the backend, set
`NEXT_PUBLIC_SIGNUP_OPEN=false` on the landing Worker and retry its build. Subscriptions already paid stay as they
are; the billing tick keeps running only for configured gateways.

## KYC

Not verified here: neither gateway's current KYC requirements could be read from an official page. The owner has to
read them in each dashboard (verification or activation menu) and in the gateway's support channel. Documents
commonly asked of an individual merchant are an identity card, a selfie with it, a tax number and a live website
with legal pages; `https://cloud.nibie.app` already has Terms, Refund and Privacy pages, a contact page and prices.
