# Runbook: SumoPod payments

What to check and what to do when a customer paid by QRIS but nothing happened on our side. Setting up or switching
the gateway is in [billing-go-live.md](billing-go-live.md); the code is `src/modules/billing` and
`src/http/sumopod-callback.ts`.

A payment reaches us only through SumoPod's webhook (`POST /api/v1/billing/sumopod/webhook`). There is no API we
can ask for a payment's status, and SumoPod does not retry a failed delivery on its own: it marks it failed and
waits for someone to press **Resend**. So a webhook that never arrived, or that we refused, means the customer was
charged and got nothing until an operator acts. Facts in this file were read from the SumoPod dashboard on
2026-11-20.

## Where to look

- **SumoPod dashboard** (`sumopod.com/dashboard/managed-payment`): sign in with the **Nibie Cloud** SumoPod account and
  pick **Live**. NibieRouter takes its payments through a separate SumoPod account (orders `SR-...`); its tabs look
  the same, so check the order prefixes before acting.
  - **Payments** tab: every invoice with order id, amount, fee, net, status (Pending, Completed, Expired).
  - **Webhooks** tab: every delivery with event type, payment reference, status (Success or Failed), attempts,
    our HTTP answer, and the **Resend** button.
  - **Settings** tab: API Key, Webhook (URL, signing secret, token), Redirect URLs, Fee Settings.
- **Admin panel**: Langganan & pembayaran (hosting invoices) and the customer page (wallet and its top-ups).
- **Backend log** on the VPS:
  `docker compose --env-file /etc/hermes-cloud/backend.env -f /opt/hermes-cloud/deploy/compose.prod.yaml logs backend | grep <order id>`

Order ids tell what was paid: `nc-...` is a hosting invoice, `nw-...` a wallet top-up. The SumoPod "reference" on
the Webhooks tab is SumoPod's `payment_id`, the same value our admin panel shows as the payment reference.

## Daily check (2 minutes)

1. SumoPod, Live, **Webhooks** tab: any row whose status is not **Success** → open it, press **Resend**, and check
   that the new attempt answers `200`.
2. SumoPod **Payments** tab, filter **Today**: every **Completed** `nc-` order must be `PAID` in the admin panel, and
   every Completed `nw-` order must be a credited top-up on that customer's wallet. If not, go to playbook A.

## After a deploy or an outage

Write down when the backend was down. In the Webhooks tab, resend every failed delivery from that window, then do
the daily check.

## Playbook A: "I paid but nothing happened"

1. Find the order in the SumoPod **Payments** tab (by time and amount, or the order id the customer sees). It must
   be **Completed**. If it is Pending or Expired, the customer has not paid that invoice.
2. Open the **Webhooks** tab and find the `payment.completed` row with the same reference.
   - **No row**: SumoPod never sent it. Ask SumoPod support to send it.
   - **Failed**: press **Resend**.
     - Answer `400`: our check of the signature or token refused it. Compare the Webhook settings with the
       backend's `SUMOPOD_WEBHOOK_SECRET`, `SUMOPOD_WEBHOOK_TOKEN` and `SUMOPOD_ENV` (Live goes with
       `production`). Fix the env, recreate the backend (see billing-go-live.md, step 3), resend again.
     - Answer `404`: the backend runs without the SumoPod variables.
     - Answer `5xx` or a timeout: the backend is down or slow; fix that, then resend.
   - **Success with `200`**: go to playbook B.
3. A resend of a delivery we already applied is harmless: it is recorded once and answered `duplicate`.

## Playbook B: SumoPod shows Success, but nothing was credited

Read the backend log for the order id. Every accepted webhook writes `sumopod webhook processed` with its `outcome`
and `merchantOrderId` (a refused one, answered `400`, writes nothing):

| `outcome` | Meaning | Action |
| --- | --- | --- |
| `activated` / `topped_up` | Applied. | Check the instance or wallet again; activation runs right after the answer, and the billing tick repairs a stopped one within minutes. |
| `amount_mismatch` | The amount differs from our invoice. Also logged as an error. Nothing was credited. | Check Fee Settings: "Charge fee to customer" must be OFF. Settle the customer by hand (refund, or for `nw-` a wallet adjust). |
| `unknown_order` | No invoice with that order id here. Also logged as a warning. | The webhook came from another project or mode (for example NibieRouter's `SR-` orders, or Sandbox). Fix the webhook URL in that project. |
| `paid_after_end` | Paid after the subscription had ended. Also logged as an error. | Refund by hand, or reinstate the customer. |
| `already_paid` / `duplicate` | A second delivery for an invoice already paid. | Nothing. |
| `failed` / `ignored_failure` | `payment.failed` (invoice becomes FAILED) or `payment.expired` (EXPIRED). `ignored_failure`: the invoice was already expired, failed or paid here, or it was SumoPod's `payment.test`. | Nothing; the customer did not pay that invoice. |
| `ignored_event` | An event type or status we do not know. Logged as a warning with the event type and status. Nothing was changed. | Tell the developer: SumoPod has added something new. |

## Playbook C: the webhook cannot be resent

- **Wallet top-up (`nw-`)**: first make sure in the Webhooks tab that the delivery is final and no retry is pending.
  Then credit the amount with the admin wallet adjust and put the order id in the reason. **Never resend that
  webhook afterwards**: the top-up row is still unpaid on our side, so a late delivery would credit it a second time.
- **Hosting invoice (`nc-`)**: there is no admin action that marks an invoice paid. Escalate to the developer.

## Settings that must not change

- Fee Settings, **Charge fee to customer: OFF**. Our webhook check expects `amount` to equal the invoice price; with
  the fee added on top every payment becomes `amount_mismatch`.
- Webhook URL, signing secret and token, and Redirect URLs are set separately for Sandbox and Live. After rolling a
  secret or the API key in SumoPod, update the backend env and recreate it in the same sitting.
- Invoices are created with a one-hour expiry (`expires_in_hours: 1`), matching our own 60 minutes, so an old QR
  cannot be paid after the customer opened a new invoice.

## Open questions for SumoPod

- Is a resent delivery signed again with a fresh `svix-timestamp`? We refuse signatures older than 5 minutes
  (`src/modules/billing/svix.ts`). Resending an old Success row once answers this: `200` means yes, `400` means no.
- How long after the payment can a delivery still be resent?
- Is there an API to read one payment's status, so we could check missed webhooks without the dashboard?
