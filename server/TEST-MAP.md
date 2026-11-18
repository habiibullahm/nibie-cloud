# TEST-MAP: TypeScript tests and their Go counterparts

Every test case of the Node backend (`test/unit`, `test/integration`) has one row: the Go test that covers it, or the
milestone that will port it, or why it is not ported. A milestone's PR fills in its rows. Spec:
`docs/superpowers/specs/2026-11-19-backend-go-port-design.md`, section 4.

Status: `golden` (covered by a Node-generated golden fixture), `ported`, `later: M<n>`, `not ported: <reason>`.
One row per `it(`, `test(` or `it.each(` line; an `it.each` row stands for all of its cases.

Rows: 917 (golden 72, ported 8, later 835, not ported 2).

| TS file | TS test | Go test | Status |
| --- | --- | --- | --- |
| `test/unit/admin-api-keys.test.ts` | makes a random, prefixed key whose hash and prefix are all that is stored |  | later: M6 |
| `test/unit/admin-api-keys.test.ts` | is usable only before its expiry and while not revoked |  | later: M6 |
| `test/unit/admin-auth-rules.test.ts` | treats every method that can change data as mutating |  | later: M6 |
| `test/unit/admin-auth-rules.test.ts` | lets an allowlisted admin read only at aal2; a read at aal1 is mfa_required |  | later: M6 |
| `test/unit/admin-auth-rules.test.ts` | refuses an email that is not on the allowlist, for reads and writes alike |  | later: M6 |
| `test/unit/admin-auth-rules.test.ts` | matches the allowlist case-insensitively |  | later: M6 |
| `test/unit/admin-auth-rules.test.ts` | refuses a write at aal1 with mfa_required, and allows it at aal2 |  | later: M6 |
| `test/unit/admin-auth-rules.test.ts` | checks the allowlist before the second factor, so a stranger never learns about MFA |  | later: M6 |
| `test/unit/admin-auth-rules.test.ts` | refuses everybody when the allowlist is empty |  | later: M6 |
| `test/unit/alerter.test.ts` | sends the first alert once and suppresses repeats inside the cooldown |  | later: M6 |
| `test/unit/alerter.test.ts` | reminds again after the cooldown (critical 1 hour, warning 6 hours) |  | later: M6 |
| `test/unit/alerter.test.ts` | reports a condition that gets worse at once, even inside the cooldown |  | later: M6 |
| `test/unit/alerter.test.ts` | sends an INFO alert only once per condition |  | later: M6 |
| `test/unit/alerter.test.ts` | keeps the alert unsent when delivery fails, and tries again on the next raise |  | later: M6 |
| `test/unit/alerter.test.ts` | never throws when the sink throws |  | later: M6 |
| `test/unit/alerter.test.ts` | records the alert but sends nothing when no sink is configured |  | later: M6 |
| `test/unit/alerter.test.ts` | limits a storm to 20 messages per 10 minutes and sends the rest later |  | later: M6 |
| `test/unit/alerter.test.ts` | removes token-like strings from what it sends |  | later: M6 |
| `test/unit/alerter.test.ts` | sends one recovery message for an alert that had been delivered |  | later: M6 |
| `test/unit/alerter.test.ts` | closes silently an alert that was never delivered |  | later: M6 |
| `test/unit/alerter.test.ts` | opens a fresh alert (and sends it) when the condition returns after recovery |  | later: M6 |
| `test/unit/alerter.test.ts` | resolveMissing resolves only open alerts under the prefix that are not active any more |  | later: M6 |
| `test/unit/alerter.test.ts` | keeps UUIDs and truncates very long text |  | later: M6 |
| `test/unit/api-key.test.ts` | is deterministic for the same master key and instance |  | later: M1 |
| `test/unit/api-key.test.ts` | differs per instance |  | later: M1 |
| `test/unit/api-key.test.ts` | differs per master key |  | later: M1 |
| `test/unit/api-key.test.ts` | is 64 lowercase hex characters |  | later: M1 |
| `test/unit/api-key.test.ts` | treats upper and lower case ids as the same instance |  | later: M1 |
| `test/unit/api-key.test.ts` | rejects a non-UUID instance id |  | later: M1 |
| `test/unit/api-key.test.ts` | matches HMAC-SHA256 over the versioned label and the lower-cased id |  | later: M1 |
| `test/unit/backoff.test.ts` | doubles from 2s and caps at 60s with jitter in [0.5, 1] |  | later: M2 |
| `test/unit/billing-lifecycle.test.ts` | first payment: 30 days from now |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | renewal before expiry extends from the current end, so no paid day is lost |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | renewal in %s starts at the payment time |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | an ACTIVE row whose end already passed (tick not yet run) starts at the payment time |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | does nothing before the period ends, and exactly at the end moves to GRACE |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | a cancelled subscription follows the same path at the period end (PRD 10.4) |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | GRACE becomes SUSPENDED when the grace ends, with 30 days of retention from the suspension |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | SUSPENDED past retention ends the subscription and deletes the instance |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | %s never moves by itself |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | sends reminders 7, 3 and 1 day before the end, each once |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | after downtime sends only the most imminent reminder, not a backlog |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | a cancelled subscription gets no renewal reminders |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | grace: one notice at the start, one a day before suspension |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | suspended: notice at suspension, deletion warning 7 days before retention ends |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | never sends an earlier notice after a later one was sent |  | later: M5 |
| `test/unit/billing-lifecycle.test.ts` | PENDING_PAYMENT and ENDED never get notices |  | later: M5 |
| `test/unit/client-ip.test.ts` | takes the last X-Forwarded-For entry, the one the proxy wrote |  | later: M3 |
| `test/unit/client-ip.test.ts` | falls back to the socket address when the header is missing or not an address |  | later: M3 |
| `test/unit/client-ip.test.ts` | keeps an IPv4 address as it is |  | later: M3 |
| `test/unit/client-ip.test.ts` | gives every address in one IPv6 /64 the same key |  | later: M3 |
| `test/unit/client-ip.test.ts` | gives different /64 networks different keys |  | later: M3 |
| `test/unit/client-ip.test.ts` | expands compressed forms before taking the prefix |  | later: M3 |
| `test/unit/client-ip.test.ts` | treats an IPv4-mapped IPv6 address as the IPv4 address |  | later: M3 |
| `test/unit/client-ip.test.ts` | uses the socket address when the header is unusable |  | later: M3 |
| `test/unit/config.test.ts` | throws when %s is missing | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | throws when ADMIN_TOKEN is shorter than 24 chars | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | defaults port to 3000, nodeEnv to development and socket path | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | does not echo secret values in validation errors | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a 31 character HERMES_MASTER_KEY and accepts 32 | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | does not echo HERMES_MASTER_KEY in errors | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | defaults HERMES_RUNTIME to runc and accepts runsc (with HERMES_DNS_RESOLVERS set) | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects an unknown HERMES_RUNTIME | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | defaults HERMES_DISK_QUOTA to enforce | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects HERMES_DISK_QUOTA=off when NODE_ENV=production without echoing the value | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | accepts HERMES_DISK_QUOTA=off outside production | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects an unknown HERMES_DISK_QUOTA | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | defaults HERMES_DISK_CHECK_INTERVAL_MS to 300000 and rejects a non-integer | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | defaults HERMES_EGRESS_POLICY to enforce | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects HERMES_EGRESS_POLICY=off when NODE_ENV=production without echoing the value | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | requires HERMES_RUNTIME=runsc in production, and keeps runc as the default elsewhere | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects an unknown HERMES_EGRESS_POLICY | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | accepts HERMES_EGRESS_POLICY=off outside production without a canary image | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | requires HERMES_CANARY_IMAGE when enforce | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | requires HERMES_CANARY_IMAGE pinned by digest under runsc even when egress is off | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a tag-only HERMES_CANARY_IMAGE and accepts name@sha256:<64 hex> | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | does not echo HERMES_CANARY_IMAGE in errors | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | accepts an IPv4 HERMES_CANARY_PRIVATE_IP, treats empty as unset, and rejects anything else | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | leaves HERMES_DNS_RESOLVERS empty by default under runc | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | parses space- or comma-separated IPv4 HERMES_DNS_RESOLVERS | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a non-IPv4 entry in HERMES_DNS_RESOLVERS | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | requires HERMES_DNS_RESOLVERS when HERMES_RUNTIME is runsc, and accepts it when set | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | leaves the customer API disabled when SUPABASE_URL and DASHBOARD_ORIGIN are unset | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | strips a trailing slash from SUPABASE_URL | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects SUPABASE_URL %s | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | does not echo SUPABASE_URL in errors | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | CORS_EXTRA_ORIGINS: a list of bare origins in development, refused with a path or in production | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | accepts a bare origin for DASHBOARD_ORIGIN and rejects a path | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | parses BETA_ALLOWED_EMAILS lowercased and trimmed, empty means nobody | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | defaults MAX_INSTANCES_PER_TENANT to 1 and rejects 0 and non-numbers | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | has no admin when ADMIN_EMAILS is unset or empty (fail closed) | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | parses ADMIN_EMAILS lowercased and trimmed | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a malformed ADMIN_EMAILS entry without echoing the value | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | leaves Redis unset by default | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | accepts redis: and rediss: URLs | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects another scheme without echoing the value | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | requires REDIS_URL in production | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is null when SECRETS_KEK is unset outside production | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | parses the current key with version 1 by default | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | parses a previous key for rotation | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a key that is not 32 bytes of base64, naming SECRETS_KEK without echoing it | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects the same version number for two different keys and a previous key without a current one | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is required in production | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is null when nothing is set, including empty values from a .env file | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | parses a complete block | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a block without %s and names the key | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a bad port or sender without echoing the password | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | requires DASHBOARD_ORIGIN for the return URL | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is null when nothing is set, including empty values from a .env file | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | parses a complete block and defaults the environment to sandbox | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a block without %s and names the key | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects an unknown DUITKU_ENV and a non-https callback URL | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | refuses the production Duitku environment outside NODE_ENV=production | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | never echoes the API key in an error | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is optional outside production and passed through when set | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is required in production when SumoPod is configured | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | rejects a value that is not whsec_ base64, without echoing it | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is required in production while the waiting list is on, and only then | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is off by default | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is on when the admin key and the default model are both set, with the documented defaults | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | refuses %s | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | refuses API URL %s | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | does not echo the admin key in a validation error | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | is off by default | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | reads the Telegram channel | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | refuses %s | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/config.test.ts` | does not echo the bot token in an error | internal/config: TestConfigMatchesNodeGolden (+ TestErrorsNeverEchoValues) | golden |
| `test/unit/disk-level.test.ts` | ok to warning at 90% |  | later: M2 |
| `test/unit/disk-level.test.ts` | ok to full at 99% |  | later: M2 |
| `test/unit/disk-level.test.ts` | warning stays warning at 89% and 90% |  | later: M2 |
| `test/unit/disk-level.test.ts` | warning to ok only below 85% |  | later: M2 |
| `test/unit/disk-level.test.ts` | warning to full at 99% |  | later: M2 |
| `test/unit/disk-level.test.ts` | full to warning only below 97% |  | later: M2 |
| `test/unit/disk-level.test.ts` | full stays full at 98% |  | later: M2 |
| `test/unit/disk-level.test.ts` | full jumps straight to ok below 85% |  | later: M2 |
| `test/unit/disk-level.test.ts` | a zero or negative limit returns the previous level |  | later: M2 |
| `test/unit/disk-level.test.ts` | a negative or non-finite usage returns the previous level |  | later: M2 |
| `test/unit/disk-quota-check.test.ts` | does nothing and never calls Docker when off |  | later: M1 |
| `test/unit/disk-quota-check.test.ts` | creates and removes a 64 MB probe volume when enforce |  | later: M1 |
| `test/unit/disk-quota-check.test.ts` | removes the probe volume even when creation succeeds but inspection shows no quota |  | later: M1 |
| `test/unit/disk-quota-check.test.ts` | fails with a message naming HERMES_DISK_QUOTA when Docker rejects the size option |  | later: M1 |
| `test/unit/disk-quota-check.test.ts` | fails with a message naming HERMES_DISK_QUOTA when Docker is unreachable |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | does nothing when there are no resolvers |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | creates the volume when missing, then seeds it with a container |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | does not recreate the volume when it already exists |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | runs the seed script with resolvers as argv, not interpolated into the script body |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | mounts the shared volume at /dns, with no other binds, and drops all capabilities |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | runs the seed container under the given OCI runtime, with a raised pids limit under runsc |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | always removes the seed container, even when the volume already existed |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | rejects with DnsResolvConfError, not a raw Docker error, when the volume cannot be inspected |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | rejects with DnsResolvConfError when the volume cannot be created |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | rejects with DnsResolvConfError when the container cannot be created, and still resolves without a remove call |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | rejects with DnsResolvConfError and still removes the container when starting it fails |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | rejects with DnsResolvConfError and still removes the container when waiting fails |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | rejects with DnsResolvConfError when the seed script exits non-zero |  | later: M1 |
| `test/unit/dns-resolv-conf.test.ts` | does not throw when removing the container fails, but logs the failure by reason only |  | later: M1 |
| `test/unit/duitku-client.test.ts` | signs with HMAC-SHA256(merchantCode + timestamp) and posts the sandbox endpoint |  | later: M5 |
| `test/unit/duitku-client.test.ts` | uses the production endpoint when configured |  | later: M5 |
| `test/unit/duitku-client.test.ts` | it.each([ ['order id over 50 characters', { merchantOrderId: 'x'.repeat(51) }],  |  | later: M5 |
| `test/unit/duitku-client.test.ts` | turns a non-00 statusCode into a fixed rejection without provider text or the key |  | later: M5 |
| `test/unit/duitku-client.test.ts` | treats an HTML or malformed answer as a rejection, and a 5xx as unavailable |  | later: M5 |
| `test/unit/duitku-client.test.ts` | turns a network failure or timeout into PaymentProviderUnavailableError |  | later: M5 |
| `test/unit/duitku-client.test.ts` | refuses a payment URL that is not https |  | later: M5 |
| `test/unit/duitku-client.test.ts` | accepts HMAC-SHA256(merchantCode + amount + merchantOrderId) |  | later: M5 |
| `test/unit/duitku-client.test.ts` | it.each([ ['tampered amount', { amount: '1', merchantOrderId: good.merchantOrder |  | later: M5 |
| `test/unit/duitku-client.test.ts` | rejects a signature made with another key |  | later: M5 |
| `test/unit/egress-canary.test.ts` | passes when nothing connected |  | later: M1 |
| `test/unit/egress-canary.test.ts` | throws EgressPolicyError naming the first connected check only |  | later: M1 |
| `test/unit/egress-canary.test.ts` | resolves when no probe connects |  | later: M1 |
| `test/unit/egress-canary.test.ts` | rejects with EgressPolicyError naming gateway only when the gateway probe connects |  | later: M1 |
| `test/unit/egress-canary.test.ts` | adds the private probe only when a private IP is configured |  | later: M1 |
| `test/unit/egress-canary.test.ts` | opens a listener on the gateway and on the private IP and probes those exact ports |  | later: M1 |
| `test/unit/egress-canary.test.ts` | the metadata probe targets 169.254.169.254:80 and never gets a listener |  | later: M1 |
| `test/unit/egress-canary.test.ts` | closes the listeners, removes the container and removes the network when everything passes |  | later: M1 |
| `test/unit/egress-canary.test.ts` | does the same cleanup when a probe connects |  | later: M1 |
| `test/unit/egress-canary.test.ts` | does the same cleanup, and rejects with a different error, when the container cannot be created |  | later: M1 |
| `test/unit/egress-canary.test.ts` | does the same cleanup, and rejects with a different error, when the image is missing |  | later: M1 |
| `test/unit/egress-canary.test.ts` | cleans up and rejects with EgressCanaryError when waiting for the container fails |  | later: M1 |
| `test/unit/egress-canary.test.ts` | cannot pass silently: a missing result, a script error or a non-zero exit is a canary failure, not a pass |  | later: M1 |
| `test/unit/egress-canary.test.ts` | rejects with EgressCanaryError when the network has no gateway |  | later: M1 |
| `test/unit/egress-canary.test.ts` | uses a network built by buildNetworkConfig with an hn bridge name so the rules match it |  | later: M1 |
| `test/unit/egress-canary.test.ts` | runs the canary with CapDrop ALL, a read-only rootfs, no volumes and small memory and pids limits |  | later: M1 |
| `test/unit/egress-canary.test.ts` | runs the canary under the configured OCI runtime so it tests the tenants path |  | later: M1 |
| `test/unit/egress-canary.test.ts` | logs a cleanup failure by reason only (a leaked network must not be silent) and still tries the network |  | later: M1 |
| `test/unit/egress-canary.test.ts` | error messages and logs never contain the probe addresses |  | later: M1 |
| `test/unit/egress-canary.test.ts` | reports "blocked" for a closed port and "connected" for an open one, with a working nc |  | later: M1 |
| `test/unit/egress-canary.test.ts` | fails with error=nc_missing and no probe lines when nc is absent |  | later: M1 |
| `test/unit/egress-canary.test.ts` | fails with error=nc_unusable and never prints "blocked" when nc cannot do a loopback connect (positive control) |  | later: M1 |
| `test/unit/egress-rules.test.ts` | creates chain HERMES-EGRESS and jumps to it from DOCKER-USER and INPUT for -i hn+ |  | later: M1 |
| `test/unit/egress-rules.test.ts` | accepts established traffic first |  | later: M1 |
| `test/unit/egress-rules.test.ts` | accepts DNS only to each configured resolver |  | later: M1 |
| `test/unit/egress-rules.test.ts` | emits no exception rules when EXCEPTIONS is empty and one ACCEPT per ip:port otherwise, before the rejects |  | later: M1 |
| `test/unit/egress-rules.test.ts` | rejects TCP 25 before the rate cap and before the range rejects |  | later: M1 |
| `test/unit/egress-rules.test.ts` | rate-caps new connections per source with hashlimit, dropping above the cap, before the range rejects |  | later: M1 |
| `test/unit/egress-rules.test.ts` | uses NEW_CONN_RATE from the config and rejects a malformed one |  | later: M1 |
| `test/unit/egress-rules.test.ts` | rejects every blocked range from the spec, including 169.254.0.0/16 |  | later: M1 |
| `test/unit/egress-rules.test.ts` | rejects addresses local to the host (only INPUT traffic can match) after the exceptions |  | later: M1 |
| `test/unit/egress-rules.test.ts` | ends with RETURN so Docker and the host firewall still see the public traffic |  | later: M1 |
| `test/unit/egress-rules.test.ts` | contains no rule that matches a hostname |  | later: M1 |
| `test/unit/egress-rules.test.ts` | ignores comments and blank lines in the config |  | later: M1 |
| `test/unit/egress-rules.test.ts` | rejects a malformed resolver or exception: non-zero exit and nothing printed |  | later: M1 |
| `test/unit/egress-rules.test.ts` | rejects an unknown config key and never executes the config |  | later: M1 |
| `test/unit/egress-rules.test.ts` | fails with a clear message when the config file is missing |  | later: M1 |
| `test/unit/egress-rules.test.ts` | prints the same commands on a second run (deterministic, idempotent shape) |  | later: M1 |
| `test/unit/egress-rules.test.ts` | remove deletes the jumps, then flushes and deletes the chain |  | later: M1 |
| `test/unit/egress-rules.test.ts` | status --dry-run lists the checks it would run, including the rules that end the chain |  | later: M1 |
| `test/unit/egress-rules.test.ts` | closes IPv6 for tenant bridges on apply and reopens nothing on remove |  | later: M1 |
| `test/unit/egress-rules.test.ts` | refuses an unknown subcommand |  | later: M1 |
| `test/unit/egress-rules.test.ts` | applies on start and reload and never removes the rules on stop or restart |  | later: M1 |
| `test/unit/egress-rules.test.ts` | starts after Docker and follows its restarts |  | later: M1 |
| `test/unit/email-templates.test.ts` | %s: Indonesian, escaped, no raw HTML from the instance name |  | later: M5 |
| `test/unit/email-templates.test.ts` | formats dates in Jakarta time |  | later: M5 |
| `test/unit/email-templates.test.ts` | payment_received shows the amount in rupiah |  | later: M5 |
| `test/unit/email-templates.test.ts` | links to the dashboard only where an action is expected |  | later: M5 |
| `test/unit/email-templates.test.ts` | escapes the dashboard URL attribute |  | later: M5 |
| `test/unit/email-templates.test.ts` | never contains payment internals |  | later: M5 |
| `test/unit/email-templates.test.ts` | links to the confirmation page and carries no text typed on the form |  | later: M5 |
| `test/unit/email-templates.test.ts` | escapes the five dangerous characters |  | later: M5 |
| `test/unit/errors.test.ts` | maps to HTTP statuses |  | later: M2 |
| `test/unit/hardening.test.ts` | targets the official image contract: port 8642 and /opt/data |  | later: M1 |
| `test/unit/hardening.test.ts` | never pins the container user (the s6 entrypoint drops to hermes 10000 itself) |  | later: M1 |
| `test/unit/hardening.test.ts` | leaves Init off because the image is PID 1 with its own s6 dispatcher |  | later: M1 |
| `test/unit/hardening.test.ts` | runs the gateway subcommand and preserves the image entrypoint |  | later: M1 |
| `test/unit/hardening.test.ts` | drops all capabilities and re-adds exactly the s6-overlay required set |  | later: M1 |
| `test/unit/hardening.test.ts` | keeps the read-only root filesystem with the s6 tmpfs set |  | later: M1 |
| `test/unit/hardening.test.ts` | applies the mandatory limits and privilege baseline |  | later: M1 |
| `test/unit/hardening.test.ts` | mounts only the tenant data volume and never the Docker socket or host paths |  | later: M1 |
| `test/unit/hardening.test.ts` | injects the loopback-reachable API server bind plus the per-instance key |  | later: M1 |
| `test/unit/hardening.test.ts` | does not overwrite an explicitly supplied key or bind |  | later: M1 |
| `test/unit/hardening.test.ts` | supports runtime selection and stays on the daemon default when unset |  | later: M1 |
| `test/unit/hardening.test.ts` | leaves Docker Dns unset (the embedded resolver) when no dns is given, even an empty list |  | later: M1 |
| `test/unit/hardening.test.ts` | sets Docker Dns to the given resolvers, a copy and not the original array |  | later: M1 |
| `test/unit/hardening.test.ts` | bind-mounts the shared resolv.conf volume over /etc/resolv.conf only under runsc with resolvers given |  | later: M1 |
| `test/unit/hardening.test.ts` | never weakens seccomp/apparmor and never uses host networking |  | later: M1 |
| `test/unit/hardening.test.ts` | refuses env that targets Docker or the control plane |  | later: M1 |
| `test/unit/hardening.test.ts` | refuses non-UUID instance ids (names derive only from UUIDs) |  | later: M1 |
| `test/unit/hardening.test.ts` | refuses invalid limits |  | later: M1 |
| `test/unit/hardening.test.ts` | rejects storageMb below 64 and non-integers |  | later: M1 |
| `test/unit/hardening.test.ts` | sets json-file log rotation of 10m x 3 |  | later: M1 |
| `test/unit/hermes-config.test.ts` | creates a minimal file when none exists |  | later: M4 |
| `test/unit/hermes-config.test.ts` | answers the auto-prune question once and never overrides a choice already in the file |  | later: M4 |
| `test/unit/hermes-config.test.ts` | writes nothing when there is no file and no model |  | later: M4 |
| `test/unit/hermes-config.test.ts` | replaces the model block of an existing file and keeps every other key and comment |  | later: M4 |
| `test/unit/hermes-config.test.ts` | removes a literal api_key so the secret is never stored in the file |  | later: M4 |
| `test/unit/hermes-config.test.ts` | is a no-op (null) when the file already says the same thing |  | later: M4 |
| `test/unit/hermes-config.test.ts` | removes only a block it manages when the provider is removed |  | later: M4 |
| `test/unit/hermes-config.test.ts` | refuses a file it cannot parse instead of overwriting it |  | later: M4 |
| `test/unit/hermes-config.test.ts` | refuses a file whose top level is not a map |  | later: M4 |
| `test/unit/hermes-config.test.ts` | joins the chunks of a small stream |  | later: M4 |
| `test/unit/hermes-config.test.ts` | stops reading and refuses once the stream passes the cap |  | later: M4 |
| `test/unit/hermes-config.test.ts` | round-trips one file with owner and mode |  | later: M4 |
| `test/unit/hermes-config.test.ts` | handles content longer than one block and empty content |  | later: M4 |
| `test/unit/hermes-config.test.ts` | rejects names that could escape the target directory |  | later: M4 |
| `test/unit/image-policy.test.ts` | rejects %j in development |  | later: M1 |
| `test/unit/image-policy.test.ts` | accepts an explicit non-latest tag in development |  | later: M1 |
| `test/unit/image-policy.test.ts` | rejects tag-only images in production |  | later: M1 |
| `test/unit/image-policy.test.ts` | accepts a digest-pinned image in production |  | later: M1 |
| `test/unit/image-policy.test.ts` | rejects a malformed digest |  | later: M1 |
| `test/unit/image-policy.test.ts` | rejects latest even when a digest is present with a latest tag |  | later: M1 |
| `test/unit/ip-ranges.test.ts` | it.each([ '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100 |  | later: M4 |
| `test/unit/ip-ranges.test.ts` | allows %s |  | later: M4 |
| `test/unit/ip-ranges.test.ts` | forbids anything that is not an IP address (fail closed) |  | later: M4 |
| `test/unit/logger.test.ts` | redacts tokens, api keys, env values and authorization headers | internal/shared/logger: TestRedactsTokensKeysEnvAndAuthorization | ported |
| `test/unit/logger.test.ts` | keeps the /24 of an IPv4 address and the /48 of an IPv6 address | internal/shared/logger: TestMaskIP | ported |
| `test/unit/logger.test.ts` | treats an IPv4-mapped IPv6 address as the IPv4 address it wraps | internal/shared/logger: TestMaskIP | ported |
| `test/unit/logger.test.ts` | returns nothing for a value that is not an IP address | internal/shared/logger: TestMaskIP | ported |
| `test/unit/logger.test.ts` | writes the path and the client network, not the query string, the exact address or the port | internal/shared/logger: TestRequestAttrDropsQueryAndPort; internal/http: TestRequestLogLine | ported |
| `test/unit/mailer.test.ts` | is a disabled no-op without configuration and never builds a transport |  | later: M5 |
| `test/unit/mailer.test.ts` | uses implicit TLS on port 465 and STARTTLS (secure false) otherwise |  | later: M5 |
| `test/unit/mailer.test.ts` | sends from MAIL_FROM with the Nibie Cloud display name |  | later: M5 |
| `test/unit/mailer.test.ts` | turns an SMTP failure into MailSendError without the server text |  | later: M5 |
| `test/unit/mask-email.test.ts` | keeps the first and last character of the local part and the whole domain |  | later: M3 |
| `test/unit/mask-email.test.ts` | stars a short local part completely |  | later: M3 |
| `test/unit/mask-email.test.ts` | never returns text that is not an address |  | later: M3 |
| `test/unit/network-config.test.ts` | is hn plus the first 12 hex characters of the uuid without dashes |  | later: M1 |
| `test/unit/network-config.test.ts` | is 14 characters and stays within the 15 character interface limit |  | later: M1 |
| `test/unit/network-config.test.ts` | is the same for upper and lower case ids |  | later: M1 |
| `test/unit/network-config.test.ts` | rejects a non-UUID |  | later: M1 |
| `test/unit/network-config.test.ts` | disables IPv6 and ICC and sets the bridge name |  | later: M1 |
| `test/unit/network-config.test.ts` | keeps the managed and instance labels |  | later: M1 |
| `test/unit/network-config.test.ts` | adds the tenant label only when a tenant id is given |  | later: M1 |
| `test/unit/network-policy.test.ts` | creates the network with the hn bridge name and IPv6 off |  | later: M1 |
| `test/unit/network-policy.test.ts` | reuses an existing network that has the bridge name |  | later: M1 |
| `test/unit/network-policy.test.ts` | refuses an existing network without the bridge name when enforce |  | later: M1 |
| `test/unit/network-policy.test.ts` | refuses an existing network with a different bridge name or no options when enforce |  | later: M1 |
| `test/unit/network-policy.test.ts` | accepts an unnamed network when off |  | later: M1 |
| `test/unit/network-policy.test.ts` | after a create conflict (409) it re-checks the winner: right name is fine |  | later: M1 |
| `test/unit/network-policy.test.ts` | after a create conflict (409) it re-checks the winner: wrong name is refused, not retried |  | later: M1 |
| `test/unit/network-policy.test.ts` | a bridge-name collision with another network (403) is reported as NetworkPolicyMissingError |  | later: M1 |
| `test/unit/network-policy.test.ts` | other create failures are not mistaken for a policy problem |  | later: M1 |
| `test/unit/network-policy.test.ts` | a bridge-name collision when off is not a policy error |  | later: M1 |
| `test/unit/network-policy.test.ts` | refuses an existing network without the bridge name when enforce |  | later: M1 |
| `test/unit/network-policy.test.ts` | refuses a network with a different bridge name when enforce |  | later: M1 |
| `test/unit/network-policy.test.ts` | refuses an absent network when enforce (cannot confirm the policy) |  | later: M1 |
| `test/unit/network-policy.test.ts` | accepts a network that has the bridge name when enforce |  | later: M1 |
| `test/unit/network-policy.test.ts` | does nothing when off, whatever the network looks like |  | later: M1 |
| `test/unit/nibierouter-client.test.ts` | createUser posts a non-admin, zero-balance user with the bearer admin key, pinned to the router host |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | accepts a user wrapped in { user: ... } |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | grantCredit sends nano-USD and the note, and returns the new balance |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | grantCredit refuses %s before any request |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | hasCreditNote finds the exact note in a bare array or a wrapped history |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | hasCreditNote reads the documented balance-history shape: items with the note in `reference`, newest 200 |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | createKey returns the id and the secret; a body without an sk- secret is unexpected |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | listKeys marks revoked keys |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | maps HTTP %i to %s |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | maps transport failures to unreachable and a non-JSON answer to unexpected |  | later: M5 |
| `test/unit/nibierouter-client.test.ts` | never puts router text, the admin key or a secret into the error |  | later: M5 |
| `test/unit/readyz.test.ts` | answers 200 ok when every check passes, and with no checks | internal/http: TestReadyzOK | ported |
| `test/unit/readyz.test.ts` | answers 503 with only the failing names, never an error message | internal/http: TestReadyzFailNamesOnly | ported |
| `test/unit/readyz.test.ts` | counts a check that never answers as failed once the timeout passes | internal/http: TestReadyzTimeout | ported |
| `test/unit/redact.test.ts` | removes the instance own secret values wherever they appear |  | later: M4 |
| `test/unit/redact.test.ts` | removes token shapes even when they are not known secrets |  | later: M4 |
| `test/unit/redact.test.ts` | keeps ordinary log lines readable |  | later: M4 |
| `test/unit/redact.test.ts` | strips terminal escape sequences and control characters |  | later: M4 |
| `test/unit/redact.test.ts` | ignores very short known values (would shred normal text) and truncates huge lines |  | later: M4 |
| `test/unit/redact.test.ts` | escapes regex characters in known values |  | later: M4 |
| `test/unit/redact.test.ts` | splits Docker stream frames into lines from stdout and stderr |  | later: M4 |
| `test/unit/redact.test.ts` | treats unframed output (TTY containers) as plain text |  | later: M4 |
| `test/unit/redact.test.ts` | returns nothing for empty input and survives a truncated frame |  | later: M4 |
| `test/unit/redis-log.test.ts` | logs a connection error once per window, with the class name only |  | not ported: the Go backend has no Redis (River keeps jobs in Postgres) |
| `test/unit/redis-log.test.ts` | logs when the connection becomes ready |  | not ported: the Go backend has no Redis (River keeps jobs in Postgres) |
| `test/unit/runtime-availability.test.ts` | never calls info for runc |  | later: M1 |
| `test/unit/runtime-availability.test.ts` | passes for runsc when the daemon lists it |  | later: M1 |
| `test/unit/runtime-availability.test.ts` | fails with a clear message for runsc when it is missing |  | later: M1 |
| `test/unit/runtime-availability.test.ts` | fails for runsc when the daemon reports no Runtimes at all |  | later: M1 |
| `test/unit/runtime-health.test.ts` | is ok on 200 when a key is supplied |  | later: M1 |
| `test/unit/runtime-health.test.ts` | is not ok on 401 when a key is supplied, with detail "auth rejected" |  | later: M1 |
| `test/unit/runtime-health.test.ts` | is still ok on 401 when no key is supplied (daemon alive) |  | later: M1 |
| `test/unit/runtime-health.test.ts` | is ok on 200 when no key is supplied |  | later: M1 |
| `test/unit/runtime-health.test.ts` | sends the Bearer header when a key is supplied |  | later: M1 |
| `test/unit/runtime-health.test.ts` | returns not ok without calling fetch when the container is not running |  | later: M1 |
| `test/unit/secrets-boundary.test.ts` | no HTTP module imports the secret store (plaintext is worker-side only) |  | later: M4 |
| `test/unit/secrets-boundary.test.ts` | the admin module never imports the secret store or the crypto helper |  | later: M4 |
| `test/unit/secrets-boundary.test.ts` | the admin routes never select the ciphertext columns of Secret |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | round-trips |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | never stores the plaintext in any field |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | produces different output for the same plaintext (random data key and iv) |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | fails when the AAD differs (a secret cannot be moved to another tenant or id) |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | fails when the key version is unknown or the key is wrong |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | opens with the previous key by version and rewraps to the new one without changing the plaintext |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | rewrap of a tampered secret fails closed |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | rejects a key that is not 32 bytes |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | error messages never contain plaintext, key or aad |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | returns the last four characters of a long value |  | later: M4 |
| `test/unit/secrets-crypto.test.ts` | hides short values completely |  | later: M4 |
| `test/unit/state-machine.test.ts` | it.each([ ['PENDING', 'PROVISIONING'], ['PROVISIONING', 'CONFIGURING'], ['CONFIG |  | later: M2 |
| `test/unit/state-machine.test.ts` | it.each([ ['DELETED', 'ACTIVE'], ['DELETED', 'PROVISIONING'], ['STOPPED', 'ACTIV |  | later: M2 |
| `test/unit/sumopod-webhook.test.ts` | rejects a wrong X-Webhook-Token |  | later: M5 |
| `test/unit/sumopod-webhook.test.ts` | rejects an empty token, a prefix of the token and the token with extra characters |  | later: M5 |
| `test/unit/sumopod-webhook.test.ts` | acknowledges payment.test without touching an order |  | later: M5 |
| `test/unit/sumopod-webhook.test.ts` | rejects an envelope with no order_id |  | later: M5 |
| `test/unit/sumopod-webhook.test.ts` | maps paid words to the Duitku paid code |  | later: M5 |
| `test/unit/sumopod-webhook.test.ts` | does not treat failures as paid |  | later: M5 |
| `test/unit/svix.test.ts` | accepts the published Svix test vector |  | later: M5 |
| `test/unit/svix.test.ts` | accepts when one of several space-separated signatures is valid |  | later: M5 |
| `test/unit/svix.test.ts` | rejects a changed body, id or timestamp |  | later: M5 |
| `test/unit/svix.test.ts` | rejects another secret |  | later: M5 |
| `test/unit/svix.test.ts` | rejects a message outside the tolerance window, in either direction |  | later: M5 |
| `test/unit/svix.test.ts` | rejects missing or malformed headers and a non-v1 signature |  | later: M5 |
| `test/unit/svix.test.ts` | rejects a secret that is not whsec_ base64 |  | later: M5 |
| `test/unit/telegram-sink.test.ts` | posts plain text to the sendMessage endpoint of api.telegram.org only |  | later: M6 |
| `test/unit/telegram-sink.test.ts` | fails with a fixed error on HTTP %i, without echoing the token |  | later: M6 |
| `test/unit/telegram-sink.test.ts` | fails with the same fixed error when the call itself fails |  | later: M6 |
| `test/unit/token-verifier.test.ts` | accepts a valid token and returns the user id and email |  | later: M3 |
| `test/unit/token-verifier.test.ts` | reads the aal claim, and treats a token without one as aal1 (Supabase adds it only with MFA) |  | later: M3 |
| `test/unit/token-verifier.test.ts` | never trusts an aal value it does not recognise: anything but aal2 reads as aal1 |  | later: M3 |
| `test/unit/token-verifier.test.ts` | it.each([ ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }], ['wrong is |  | later: M3 |
| `test/unit/token-verifier.test.ts` | rejects a malformed token (%#) |  | later: M3 |
| `test/unit/token-verifier.test.ts` | rejects an unsecured alg:none token |  | later: M3 |
| `test/unit/token-verifier.test.ts` | rejects an HS256 token signed with the public key bytes as the secret |  | later: M3 |
| `test/unit/token-verifier.test.ts` | never puts the token in the error |  | later: M3 |
| `test/unit/token-verifier.test.ts` | reports %s as AuthUnavailableError, not as a bad token |  | later: M3 |
| `test/unit/token-verifier.test.ts` | still answers Unauthorized when the key set simply has no matching key |  | later: M3 |
| `test/unit/turnstile.test.ts` | posts the secret, the token and the visitor address to siteverify, and accepts success |  | later: M3 |
| `test/unit/turnstile.test.ts` | treats a refused token as invalid |  | later: M3 |
| `test/unit/turnstile.test.ts` | refuses a missing, empty or oversized token without calling Cloudflare |  | later: M3 |
| `test/unit/turnstile.test.ts` | fails closed when Cloudflare cannot be asked or answers oddly |  | later: M3 |
| `test/unit/volume-quota.test.ts` | creates the volume with the sized options when enforce |  | later: M1 |
| `test/unit/volume-quota.test.ts` | creates it without size options when off |  | later: M1 |
| `test/unit/volume-quota.test.ts` | reports the existing quota in MB through volumeQuotaMb |  | later: M1 |
| `test/unit/volume-quota.test.ts` | throws VolumeQuotaMissingError for an existing volume without a quota when enforce |  | later: M1 |
| `test/unit/volume-quota.test.ts` | does not throw for an existing unquotaed volume when off |  | later: M1 |
| `test/unit/volume-quota.test.ts` | turns a create-time "no quota support" rejection into VolumeQuotaMissingError |  | later: M1 |
| `test/unit/volume-quota.test.ts` | refuses an existing volume without a quota when enforce |  | later: M1 |
| `test/unit/volume-quota.test.ts` | refuses an absent volume when enforce (cannot confirm a quota) |  | later: M1 |
| `test/unit/volume-quota.test.ts` | accepts a volume that has a quota when enforce |  | later: M1 |
| `test/unit/volume-quota.test.ts` | does nothing when off, whatever the volume looks like |  | later: M1 |
| `test/unit/volume-quota.test.ts` | keeps only managed volumes with an instance label and a size of 0 or more |  | later: M1 |
| `test/unit/volume-quota.test.ts` | returns an empty map when Docker reports no volumes (null) |  | later: M1 |
| `test/unit/volume-quota.test.ts` | asks Docker for volumes only, with the query in options |  | later: M1 |
| `test/unit/volume-quota.test.ts` | it.each([ [{ size: '64m' }, 64], [{ size: '64M' }, 64], [{ size: '1g' }, 1024],  |  | later: M1 |
| `test/unit/volume-quota.test.ts` | returns null for %j |  | later: M1 |
| `test/integration/admin-api-keys.test.ts` | creates a key once from an aal2 session, stores only its hash and audits without the key |  | later: M6 |
| `test/integration/admin-api-keys.test.ts` | a key reads and invites with audit marked as key use, but can never manage keys |  | later: M6 |
| `test/integration/admin-api-keys.test.ts` | refuses a wrong, revoked or expired key, and a key whose creator left ADMIN_EMAILS |  | later: M6 |
| `test/integration/admin-api-keys.test.ts` | settings show modes and counts but never a secret, URL or email list |  | later: M6 |
| `test/integration/admin-api-keys.test.ts` | needs a valid admin credential |  | later: M6 |
| `test/integration/admin-api-keys.test.ts` | initializes, lists the tools and runs reads and an invite through the admin routes with a key |  | later: M6 |
| `test/integration/admin-api.test.ts` | lists customers with their tenant, email and instance count |  | later: M6 |
| `test/integration/admin-api.test.ts` | searches customers by email (case-insensitive) and never returns a secret |  | later: M6 |
| `test/integration/admin-api.test.ts` | reads one customer with their instances, subscriptions and payments |  | later: M6 |
| `test/integration/admin-api.test.ts` | answers 404 for an unknown customer, not an empty body |  | later: M6 |
| `test/integration/admin-api.test.ts` | lists instances across tenants with the owner email, and filters by status |  | later: M6 |
| `test/integration/admin-api.test.ts` | reads one instance with its events, and 404s for an unknown id |  | later: M6 |
| `test/integration/admin-api.test.ts` | lists plans, including inactive ones, with their price and credit |  | later: M6 |
| `test/integration/admin-api.test.ts` | lists runtime nodes and their instance counts |  | later: M6 |
| `test/integration/admin-api.test.ts` | reports an overview: counts by status and the billing/router switches |  | later: M6 |
| `test/integration/admin-api.test.ts` | lists failed jobs and the audit trail |  | later: M6 |
| `test/integration/admin-api.test.ts` | never answers with a stored secret, on any read route |  | later: M6 |
| `test/integration/admin-api.test.ts` | is read-only: Fase A exposes no mutating admin route at all |  | later: M6 |
| `test/integration/admin-api.test.ts` | refuses a non-admin on every read route |  | later: M6 |
| `test/integration/admin-auth.test.ts` | serves /admin/me to an allowlisted email, with the assurance level |  | later: M6 |
| `test/integration/admin-auth.test.ts` | matches the allowlist case-insensitively |  | later: M6 |
| `test/integration/admin-auth.test.ts` | asks an allowlisted admin without a second factor for one, on /me and on data routes alike |  | later: M6 |
| `test/integration/admin-auth.test.ts` | refuses a signed-in user who is not on the allowlist, without saying whether they exist |  | later: M6 |
| `test/integration/admin-auth.test.ts` | refuses everybody when ADMIN_EMAILS is empty (fail closed) |  | later: M6 |
| `test/integration/admin-auth.test.ts` | returns the opaque 401 for missing, malformed, oversized and expired credentials |  | later: M6 |
| `test/integration/admin-auth.test.ts` | does not serve the admin API when the customer API is not configured |  | later: M6 |
| `test/integration/admin-auth.test.ts` | grants CORS only to the dashboard origin |  | later: M6 |
| `test/integration/admin-auth.test.ts` | never writes an admin token to the logs |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | refuses everyone but an allowlisted admin with a second factor |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | lists the database invites with the env list and the slot count, and records the read |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | adds an invite with the admin as author, normalizes the email and writes one audit entry with the reason |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | emails the invited address and reports it; a failed or missing mailer still saves the invite |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | rejects a bad email, a missing or short reason and unknown fields, and writes nothing |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | inviting the same address again keeps one row |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | revokes an invite, records it once, and a second revoke changes and records nothing |  | later: M6 |
| `test/integration/admin-beta-invites.test.ts` | takes effect for customers at once: an added email can deploy, a revoked one can not |  | later: M6 |
| `test/integration/admin-plan-stock.test.ts` | refuses everyone but an allowlisted admin with a second factor |  | later: M6 |
| `test/integration/admin-plan-stock.test.ts` | sets, keeps and clears the stock with one audit entry per real change |  | later: M6 |
| `test/integration/admin-plan-stock.test.ts` | refuses the free plan, an unknown plan and invalid bodies |  | later: M6 |
| `test/integration/admin-plan-stock.test.ts` | lists stock used and left; the free plan has no stock |  | later: M6 |
| `test/integration/admin-plan-stock.test.ts` | a sold-out plan shows as unavailable to customers, invited or not, and opens again when stock is added |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | stays silent on a healthy platform and sends no summary before 09:00 WIB |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | alerts when recovery is exhausted only after 10 minutes, once, and says when it recovered |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | treats a FAILED instance with a running paid subscription as critical, an unpaid one as a warning |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | alerts on a verified payment whose subscription still has no instance after 15 minutes |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | reports router provisioning from 5 attempts, critical once it has given up |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | reports exhausted queue jobs and clears them when the job is gone |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | does not raise or resolve anything when a check cannot read its data |  | later: M6 |
| `test/integration/alert-scanner.test.ts` | sends the daily summary once per day, also after a restart |  | later: M6 |
| `test/integration/api.test.ts` | serves /healthz without auth and without touching Docker |  | later: M2 |
| `test/integration/api.test.ts` | rejects missing or wrong bearer tokens with 401 |  | later: M2 |
| `test/integration/api.test.ts` | requires an Idempotency-Key header and a valid body |  | later: M2 |
| `test/integration/api.test.ts` | provisions, reports status, restarts, stops, starts and deletes |  | later: M2 |
| `test/integration/api.test.ts` | answers 409 when an idempotency key is reused with a different payload |  | later: M2 |
| `test/integration/api.test.ts` | answers 404 for an unknown tenant or plan and 503 database_unavailable when Postgres is down |  | later: M2 |
| `test/integration/api.test.ts` | answers 404 when the path tenant does not own the instance, or ids are malformed |  | later: M2 |
| `test/integration/api.test.ts` | answers 409 for one of two racing restart/stop calls |  | later: M2 |
| `test/integration/api.test.ts` | answers 503 with a sanitized body and leaves an active instance ACTIVE when Docker is down |  | later: M2 |
| `test/integration/api.test.ts` | answers unexpected errors with a generic 500 and never echoes or logs their message |  | later: M2 |
| `test/integration/api.test.ts` | never returns 500 details and never logs or echoes the admin token |  | later: M2 |
| `test/integration/audit-service.test.ts` | records an entry and reads it back newest first |  | later: M6 |
| `test/integration/audit-service.test.ts` | pages with a cursor and never repeats or skips a row |  | later: M6 |
| `test/integration/audit-service.test.ts` | filters by actor and by target |  | later: M6 |
| `test/integration/audit-service.test.ts` | rejects a cursor that is not one of its own |  | later: M6 |
| `test/integration/audit-service.test.ts` | never stores a key that looks like a secret in `detail` |  | later: M6 |
| `test/integration/beta-invites.test.ts` | stores the address trimmed and lowercase and matches it any way it is typed |  | later: M3 |
| `test/integration/beta-invites.test.ts` | adding the same address twice keeps one row |  | later: M3 |
| `test/integration/beta-invites.test.ts` | revokes without deleting, reports whether anything was revoked, and re-adding restores access |  | later: M3 |
| `test/integration/beta-invites.test.ts` | lists active invites newest first, and revoked ones only on request |  | later: M3 |
| `test/integration/beta-invites.test.ts` | lets an account on the env list deploy, as before |  | later: M3 |
| `test/integration/beta-invites.test.ts` | lets an account that only has a table invite see the free plan and deploy |  | later: M3 |
| `test/integration/beta-invites.test.ts` | refuses an unlisted account: no free plan, 403 provisioning_not_enabled |  | later: M3 |
| `test/integration/beta-invites.test.ts` | refuses an account whose invite was revoked, and accepts it again when re-invited |  | later: M3 |
| `test/integration/beta-invites.test.ts` | never lets an invited account create a priced plan through this route; only an admin may |  | later: M3 |
| `test/integration/beta-invites.test.ts` | takes effect without a restart: an invite added while the server runs applies to the next request |  | later: M3 |
| `test/integration/billing-api.test.ts` | lets only invited beta users start a purchase while every gateway is sandbox |  | later: M5 |
| `test/integration/billing-api.test.ts` | PAID_CHECKOUT_OPEN=false refuses everyone but invited accounts, even with a production gateway |  | later: M5 |
| `test/integration/billing-api.test.ts` | PAID_CHECKOUT_OPEN=false also lets an account that only has a database invite start a purchase, until it is revoked |  | later: M5 |
| `test/integration/billing-api.test.ts` | is open to everyone once a production gateway is configured |  | later: M5 |
| `test/integration/billing-api.test.ts` | require a token |  | later: M5 |
| `test/integration/billing-api.test.ts` | plans show the price once set |  | later: M5 |
| `test/integration/billing-api.test.ts` | checkout returns 201 with a payment URL, replays by key, and does not leak provider fields |  | later: M5 |
| `test/integration/billing-api.test.ts` | checkout validates the body strictly and needs an Idempotency-Key |  | later: M5 |
| `test/integration/billing-api.test.ts` | answers 409 plan_not_for_sale when the plan has no price |  | later: M5 |
| `test/integration/billing-api.test.ts` | answers 503 when Duitku is unreachable |  | later: M5 |
| `test/integration/billing-api.test.ts` | another user gets 404 on every id route |  | later: M5 |
| `test/integration/billing-api.test.ts` | the whole path: pay by callback, instance appears, renew, cancel |  | later: M5 |
| `test/integration/billing-api.test.ts` | a suspended instance cannot be started or restarted by the customer, and other tenants still see 404 |  | later: M5 |
| `test/integration/billing-api.test.ts` | deleting the instance ends the subscription |  | later: M5 |
| `test/integration/billing-api.test.ts` | needs no Authorization header and accepts a valid signed form |  | later: M5 |
| `test/integration/billing-api.test.ts` | replay is 200 and changes nothing |  | later: M5 |
| `test/integration/billing-api.test.ts` | a bad signature is 400 and activates nothing |  | later: M5 |
| `test/integration/billing-api.test.ts` | a tampered amount is 200 without activation (valid signature for the tampered amount) |  | later: M5 |
| `test/integration/billing-api.test.ts` | a changed amount with the original signature is 400 |  | later: M5 |
| `test/integration/billing-api.test.ts` | unknown order with a valid signature is 200 |  | later: M5 |
| `test/integration/billing-api.test.ts` | missing fields, array fields and an empty body are 400 |  | later: M5 |
| `test/integration/billing-api.test.ts` | never writes the form body, the signature or the API key to the log |  | later: M5 |
| `test/integration/billing-api.test.ts` | rejects a body over 16 KB |  | later: M5 |
| `test/integration/billing-api.test.ts` | is 404 when billing is off, and the customer billing routes do not exist either |  | later: M5 |
| `test/integration/billing-api.test.ts` | forwards the billing routes and the Duitku callback |  | later: M5 |
| `test/integration/billing-api.test.ts` | still never forwards the operator API, jobs or everything else |  | later: M5 |
| `test/integration/billing-service.test.ts` | creates a pending subscription and an invoice, and no instance |  | later: M5 |
| `test/integration/billing-service.test.ts` | replaying the same Idempotency-Key returns the same invoice, without a second Duitku call |  | later: M5 |
| `test/integration/billing-service.test.ts` | rejects reuse of a key with another name or plan |  | later: M5 |
| `test/integration/billing-service.test.ts` | after the invoice expired, the same key gets a fresh invoice on the same subscription |  | later: M5 |
| `test/integration/billing-service.test.ts` | refuses a plan without a price, an unknown plan, a bad name |  | later: M5 |
| `test/integration/billing-service.test.ts` | a new checkout releases the slot of an earlier unpaid one instead of waiting for it to expire |  | later: M5 |
| `test/integration/billing-service.test.ts` | still applies the per-tenant instance cap to a paid purchase |  | later: M5 |
| `test/integration/billing-service.test.ts` | an old invoice that is paid after a newer checkout started is still honored |  | later: M5 |
| `test/integration/billing-service.test.ts` | refuses a new purchase at the whole-server cap before any invoice exists, and never blocks a paying customer |  | later: M5 |
| `test/integration/billing-service.test.ts` | refuses a new purchase once the plan stock is used, counting open invoices, and never blocks the paying customer |  | later: M5 |
| `test/integration/billing-service.test.ts` | two buyers racing for the last unit: exactly one gets an invoice |  | later: M5 |
| `test/integration/billing-service.test.ts` | a Duitku outage answers 503, marks the attempt failed and a retry works |  | later: M5 |
| `test/integration/billing-service.test.ts` | first payment: payment PAID, subscription ACTIVE for 30 days, instance created and ACTIVE, one receipt |  | later: M5 |
| `test/integration/billing-service.test.ts` | hands the new instance to the router provisioner once, and a router that throws never undoes the payment |  | later: M5 |
| `test/integration/billing-service.test.ts` | the same callback twice changes nothing |  | later: M5 |
| `test/integration/billing-service.test.ts` | a different delivery for an already paid invoice (new reference) is ignored |  | later: M5 |
| `test/integration/billing-service.test.ts` | two simultaneous identical callbacks activate exactly once |  | later: M5 |
| `test/integration/billing-service.test.ts` | a wrong amount is recorded and ignored |  | later: M5 |
| `test/integration/billing-service.test.ts` | resultCode %s marks the payment failed and activates nothing |  | later: M5 |
| `test/integration/billing-service.test.ts` | a failure callback never downgrades a paid invoice |  | later: M5 |
| `test/integration/billing-service.test.ts` | a paid invoice that was already marked expired is still honored |  | later: M5 |
| `test/integration/billing-service.test.ts` | unknown order id with a valid signature is accepted (so Duitku stops retrying) and changes nothing |  | later: M5 |
| `test/integration/billing-service.test.ts` | %s is not accepted and records nothing |  | later: M5 |
| `test/integration/billing-service.test.ts` | a signature made for another order cannot activate this one |  | later: M5 |
| `test/integration/billing-service.test.ts` | a crash after commit leaves a paid subscription without an instance, which ensureInstance repairs once |  | later: M5 |
| `test/integration/billing-service.test.ts` | a mail outage does not undo the activation |  | later: M5 |
| `test/integration/billing-service.test.ts` | renewing while active extends from the current end, once, even when the button is pressed twice |  | later: M5 |
| `test/integration/billing-service.test.ts` | renewing a suspended subscription restarts the stopped instance and clears the suspension |  | later: M5 |
| `test/integration/billing-service.test.ts` | cancel schedules non-renewal and paying again clears it |  | later: M5 |
| `test/integration/billing-service.test.ts` | refuses to renew or cancel a purchase that was never paid, or an ended subscription |  | later: M5 |
| `test/integration/billing-service.test.ts` | a payment that arrives after the subscription ended is recorded loudly and does not resurrect it |  | later: M5 |
| `test/integration/billing-service.test.ts` | another tenant gets 404 for subscriptions and payments |  | later: M5 |
| `test/integration/billing-service.test.ts` | views never expose the Duitku reference or order id |  | later: M5 |
| `test/integration/billing-service.test.ts` | the per-tenant cap does not block a paid subscription from being fulfilled |  | later: M5 |
| `test/integration/billing-tick.test.ts` | sends the 7, 3 and 1 day reminders once each, however often it runs |  | later: M5 |
| `test/integration/billing-tick.test.ts` | after downtime sends only the current reminder, not a backlog |  | later: M5 |
| `test/integration/billing-tick.test.ts` | a renewal resets the reminders for the new period |  | later: M5 |
| `test/integration/billing-tick.test.ts` | expiry: ACTIVE becomes GRACE, the instance keeps running, one email |  | later: M5 |
| `test/integration/billing-tick.test.ts` | grace over: SUSPENDED, the instance is stopped and its volume kept, with a warning the day before |  | later: M5 |
| `test/integration/billing-tick.test.ts` | the reconciler does not restart a suspended instance |  | later: M5 |
| `test/integration/billing-tick.test.ts` | retention over: the instance is deleted, the subscription ended, one final notice |  | later: M5 |
| `test/integration/billing-tick.test.ts` | a cancelled subscription gets no renewal reminders but follows the same path after the period |  | later: M5 |
| `test/integration/billing-tick.test.ts` | a payment that lands between reads wins over the tick (compare-and-set) |  | later: M5 |
| `test/integration/billing-tick.test.ts` | a busy instance is skipped and stopped on a later tick |  | later: M5 |
| `test/integration/billing-tick.test.ts` | two ticks at once change a subscription and send an email once |  | later: M5 |
| `test/integration/billing-tick.test.ts` | mail not configured: transitions still happen, nothing is recorded as sent, and the current notice goes out once mail works |  | later: M5 |
| `test/integration/billing-tick.test.ts` | a mail failure releases the claim and the next tick retries |  | later: M5 |
| `test/integration/billing-tick.test.ts` | expires unpaid invoices and closes abandoned purchases after 7 days |  | later: M5 |
| `test/integration/billing-tick.test.ts` | repairs a paid subscription whose instance was never created (crash after commit) |  | later: M5 |
| `test/integration/billing-tick.test.ts` | repairs a reinstated subscription whose instance was never restarted |  | later: M5 |
| `test/integration/billing-tick.test.ts` | ends the subscription quietly when the instance was deleted elsewhere |  | later: M5 |
| `test/integration/billing-tick.test.ts` | run() is throttled and never throws |  | later: M5 |
| `test/integration/billing-tick.test.ts` | retries router provisioning on every tick and survives a router that throws |  | later: M5 |
| `test/integration/config-apply.test.ts` | provision passes the loaded environment and records the applied revision |  | later: M4 |
| `test/integration/config-apply.test.ts` | a restart after a config change recreates the container with the new environment and model block |  | later: M4 |
| `test/integration/config-apply.test.ts` | a provisioning retry after a failure recreates the container when the configuration changed in between |  | later: M4 |
| `test/integration/config-apply.test.ts` | a restart with nothing to apply is a plain restart |  | later: M4 |
| `test/integration/config-apply.test.ts` | start of a stopped instance also picks up the new configuration |  | later: M4 |
| `test/integration/config-apply.test.ts` | removing the provider recreates with modelConfig null so the platform block is removed |  | later: M4 |
| `test/integration/config-apply.test.ts` | a revoked token never comes back: replacing the token and restarting uses only the new one |  | later: M4 |
| `test/integration/config-apply.test.ts` | a failed recreate (unreadable config file) refuses the restart, restores the state and keeps the gap |  | later: M4 |
| `test/integration/config-apply.test.ts` | the reconciler recreates (not just starts) a stopped container that has a pending config change |  | later: M4 |
| `test/integration/config-apply.test.ts` | the reconciler re-creating a vanished container with an applied config uses the stored configuration |  | later: M4 |
| `test/integration/config-apply.test.ts` | a restart after configuring Telegram and a provider reaches the new container and keeps the data |  | later: M4 |
| `test/integration/customer-api.test.ts` | lists only active plans, with limits and a null price |  | later: M3 |
| `test/integration/customer-api.test.ts` | lists every active plan to a stranger, marking the ones they cannot take as unavailable |  | later: M3 |
| `test/integration/customer-api.test.ts` | refuses a new instance at the whole-server cap, but never a replay and never after one is deleted |  | later: M3 |
| `test/integration/customer-api.test.ts` | gives the free plan to the first strangers until the slots are used, then hides it and answers beta_full |  | later: M3 |
| `test/integration/customer-api.test.ts` | never lets a stranger create a priced plan through this route, and is off with zero slots |  | later: M3 |
| `test/integration/customer-api.test.ts` | PAID_CHECKOUT_OPEN=false hides the priced plans from strangers only |  | later: M3 |
| `test/integration/customer-api.test.ts` | publishes the slot counter without authentication |  | later: M3 |
| `test/integration/customer-api.test.ts` | shows the unpriced beta preview plan only to invited accounts |  | later: M3 |
| `test/integration/customer-api.test.ts` | provisions, lists, reads status and events, restarts, stops, starts and deletes |  | later: M3 |
| `test/integration/customer-api.test.ts` | refuses users outside the beta allowlist with 403 provisioning_not_enabled |  | later: M3 |
| `test/integration/customer-api.test.ts` | fails closed: an empty allowlist lets nobody provision |  | later: M3 |
| `test/integration/customer-api.test.ts` | matches the allowlist case-insensitively |  | later: M3 |
| `test/integration/customer-api.test.ts` | answers 409 over the per-tenant cap, and frees the slot after a delete |  | later: M3 |
| `test/integration/customer-api.test.ts` | lets an idempotent replay through the cap and rejects key reuse with another body |  | later: M3 |
| `test/integration/customer-api.test.ts` | holds the cap under five concurrent requests with different keys |  | later: M3 |
| `test/integration/customer-api.test.ts` | honours a higher MAX_INSTANCES_PER_TENANT |  | later: M3 |
| `test/integration/customer-api.test.ts` | answers 429 on the sixth provisioning request within ten minutes |  | later: M3 |
| `test/integration/customer-api.test.ts` | validates the body, the idempotency key and the plan id |  | later: M3 |
| `test/integration/customer-api.test.ts` | refuses an inactive plan with 404 and creates nothing |  | later: M3 |
| `test/integration/customer-api.test.ts` | never lets one user see or act on another user\ |  | later: M3 |
| `test/integration/customer-api.test.ts` | says on /me whether the caller is an admin, and only the caller |  | later: M3 |
| `test/integration/customer-api.test.ts` | ignores a tenant id smuggled in the query string |  | later: M3 |
| `test/integration/customer-auth.test.ts` | returns the opaque 401 for missing, malformed, oversized and expired credentials |  | later: M3 |
| `test/integration/customer-auth.test.ts` | serves /api/v1/me to a valid user and creates their tenant on first use |  | later: M3 |
| `test/integration/customer-auth.test.ts` | keeps the two surfaces apart: admin token on a customer route and user token on an operator route are 401 |  | later: M3 |
| `test/integration/customer-auth.test.ts` | hides the operator API from proxied requests (%s present), even with the admin token |  | later: M3 |
| `test/integration/customer-auth.test.ts` | logs the client address from X-Forwarded-For only when the request came through the loopback proxy |  | later: M3 |
| `test/integration/customer-auth.test.ts` | answers 503 auth_unavailable and logs when the key set cannot be fetched |  | later: M3 |
| `test/integration/customer-auth.test.ts` | does not serve customer routes when the customer API is not configured |  | later: M3 |
| `test/integration/customer-auth.test.ts` | grants CORS only to the dashboard origin, including preflight |  | later: M3 |
| `test/integration/customer-auth.test.ts` | never writes a token to the logs |  | later: M3 |
| `test/integration/disk-monitor.test.ts` | records disk.warning once for repeated polls at 91% |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | records disk.full then nothing on a stable full level |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | records disk.ok when usage drops below 85% |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | a drop from full to warning records no event but updates diskLevel |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | does not flap at exactly 90% and 99% |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | watches ACTIVE, DEGRADED and STOPPED instances only |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | skips an instance missing from the usage map instead of treating it as 0 bytes |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | a RuntimeUnavailableError from volumeUsage writes no events and leaves diskLevel unchanged |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | never changes status or restarts a container |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | stores diskUsedBytes |  | later: M2 |
| `test/integration/disk-monitor.test.ts` | event messages are fixed text with a percentage only |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | passes the plan's storageMb and the quota mode on every ensure call |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | passes off through when quotas are not enforced |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | provisioning with a missing quota ends FAILED with reason volume_quota_missing |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | recovery with a missing quota never starts the container and ends DEGRADED |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | a quota different from the plan records one disk.quota_mismatch event and keeps the instance ACTIVE |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | a matching quota records no event |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | no quota (off) records no mismatch event |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | a user start with a missing quota is refused and never starts the container |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | a user start still works without a quota when quotas are off |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | a user restart with a missing quota is refused and leaves the instance as it was |  | later: M2 |
| `test/integration/disk-wiring.test.ts` | a reconciler restart with a missing quota never restarts the container |  | later: M2 |
| `test/integration/egress-canary.test.ts` | a missing image is a canary failure, not a policy failure, and leaves nothing behind |  | later: M1 |
| `test/integration/identity-service.test.ts` | creates the user, a personal tenant and an OWNER membership on first login |  | later: M3 |
| `test/integration/identity-service.test.ts` | returns the same principal on later logins and creates nothing |  | later: M3 |
| `test/integration/identity-service.test.ts` | survives ten concurrent first requests: one user, one tenant, one membership |  | later: M3 |
| `test/integration/identity-service.test.ts` | refreshes the stored email when the token carries a new one |  | later: M3 |
| `test/integration/identity-service.test.ts` | gives different users different tenants |  | later: M3 |
| `test/integration/identity-service.test.ts` | never puts the email in the tenant name |  | later: M3 |
| `test/integration/instance-commands.test.ts` | runs the whole operation in the request and returns jobId null |  | later: M2 |
| `test/integration/instance-commands.test.ts` | provision creates the PENDING row, enqueues ids only and does not touch the runtime |  | later: M2 |
| `test/integration/instance-commands.test.ts` | replaying a provision key returns the same instance and does not create a second row |  | later: M2 |
| `test/integration/instance-commands.test.ts` | provision still answers PENDING with jobId null when Redis is down (the sweeper delivers it) |  | later: M2 |
| `test/integration/instance-commands.test.ts` | stop on an ACTIVE instance enqueues and leaves the state and runtime untouched |  | later: M2 |
| `test/integration/instance-commands.test.ts` | stop, start, restart and delete answer 503 queue_unavailable and change nothing when Redis is down |  | later: M2 |
| `test/integration/instance-commands.test.ts` | rejects an impossible transition with 409 before enqueueing |  | later: M2 |
| `test/integration/instance-commands.test.ts` | treats stop on a STOPPED instance as already done: no job |  | later: M2 |
| `test/integration/instance-commands.test.ts` | answers 404 for another tenant\ |  | later: M2 |
| `test/integration/instance-commands.test.ts` | adds jobId to the 202 bodies of the customer and operator APIs |  | later: M2 |
| `test/integration/instance-service.test.ts` | rejects an unpinned image at construction |  | later: M2 |
| `test/integration/instance-service.test.ts` | provisions an instance to ACTIVE with a persisted container |  | later: M2 |
| `test/integration/instance-service.test.ts` | returns the same instance for a repeated idempotency key |  | later: M2 |
| `test/integration/instance-service.test.ts` | creates exactly one instance, container and volume for 5 parallel calls with one key |  | later: M2 |
| `test/integration/instance-service.test.ts` | marks FAILED on a partial provisioning failure and a retry succeeds without duplicates |  | later: M2 |
| `test/integration/instance-service.test.ts` | stop, start and restart move through STOPPED and ACTIVE |  | later: M2 |
| `test/integration/instance-service.test.ts` | lets exactly one of two concurrent restart/stop calls win; the other gets ConflictError |  | later: M2 |
| `test/integration/instance-service.test.ts` | rejects restart and start with ConflictError while a stop is still in flight |  | later: M2 |
| `test/integration/instance-service.test.ts` | treats repeated stop and delete as no-ops |  | later: M2 |
| `test/integration/instance-service.test.ts` | delete removes container, network and volume and sets deletedAt |  | later: M2 |
| `test/integration/instance-service.test.ts` | answers NotFoundError for every method when the tenant does not own the instance |  | later: M2 |
| `test/integration/instance-service.test.ts` | leaves state unchanged and rethrows when Docker is unavailable during start |  | later: M2 |
| `test/integration/instance-service.test.ts` | does not delete or fail an active instance when Docker is unavailable during delete/restart |  | later: M2 |
| `test/integration/instance-service.test.ts` | marks provisioning FAILED (runtime_unavailable) when Docker is down, and surfaces 503 |  | later: M2 |
| `test/integration/instance-service.test.ts` | leaves the instance DEGRADED (not STOPPED) when Docker blinks during the post-start health wait |  | later: M2 |
| `test/integration/instance-service.test.ts` | stops the container when provisioning fails on a health timeout |  | later: M2 |
| `test/integration/instance-service.test.ts` | rejects invalid name %j |  | later: M2 |
| `test/integration/instance-service.test.ts` | stores hostile names but never uses them in Docker names or labels |  | later: M2 |
| `test/integration/instance-service.test.ts` | rejects reuse of a key with a different name (409) and returns the original for the same payload |  | later: M2 |
| `test/integration/instance-service.test.ts` | rejects reuse of a key with a different plan (409) without touching the instance |  | later: M2 |
| `test/integration/instance-service.test.ts` | does not re-drive a FAILED instance when the retry has a different payload |  | later: M2 |
| `test/integration/instance-service.test.ts` | lets exactly one payload win when concurrent calls share a key but not a payload |  | later: M2 |
| `test/integration/instance-service.test.ts` | answers NotFoundError for %s |  | later: M2 |
| `test/integration/instance-service.test.ts` | answers NotFoundError (not a 500) when listing a malformed tenant id |  | later: M2 |
| `test/integration/instance-service.test.ts` | surfaces a database outage as a database error, never as "not found" |  | later: M2 |
| `test/integration/integration-routes.test.ts` | requires a signed-in user on every route |  | later: M4 |
| `test/integration/integration-routes.test.ts` | configures Telegram end to end and never returns the token |  | later: M4 |
| `test/integration/integration-routes.test.ts` | configures a provider end to end and never returns the key |  | later: M4 |
| `test/integration/integration-routes.test.ts` | another tenant's instance is 404 on every route |  | later: M4 |
| `test/integration/integration-routes.test.ts` | rejects unknown fields, bad shapes and bad ids with a generic 400 that echoes nothing |  | later: M4 |
| `test/integration/integration-routes.test.ts` | answers 503 secrets_unavailable when no key-encryption key is configured |  | later: M4 |
| `test/integration/integration-routes.test.ts` | rate limits the test and verify endpoints per user |  | later: M4 |
| `test/integration/integration-routes.test.ts` | a provider outage on test is a 200 with a FAILED status, not a server error |  | later: M4 |
| `test/integration/integration-routes.test.ts` | returns the scrubbed tail for the owner, and 404 for another tenant |  | later: M4 |
| `test/integration/integration-routes.test.ts` | rejects a bad tail with 400 |  | later: M4 |
| `test/integration/integration-routes.test.ts` | attaches NibieRouter with the admin token only, and the customer cannot |  | later: M4 |
| `test/integration/integration-routes.test.ts` | reports secret health and rewraps without exposing keys or values |  | later: M4 |
| `test/integration/isolation.test.ts` | enforces the hardening baseline on the live container |  | later: M1 |
| `test/integration/isolation.test.ts` | mounts exactly one tenant volume and never the Docker socket |  | later: M1 |
| `test/integration/isolation.test.ts` | drops the gateway to hermes (10000) with a read-only root filesystem and writable data |  | later: M1 |
| `test/integration/isolation.test.ts` | leaves the gateway process with no effective capabilities after the privilege drop |  | later: M1 |
| `test/integration/isolation.test.ts` | cannot see another tenant's data |  | later: M1 |
| `test/integration/isolation.test.ts` | cannot reach another tenant container over the network |  | later: M1 |
| `test/integration/isolation.test.ts` | enforces the memory limit: an over-allocating process is killed, the container survives |  | later: M1 |
| `test/integration/isolation.test.ts` | caps the number of processes at the PID limit |  | later: M1 |
| `test/integration/job-queue.test.ts` | never contains a colon and is stable per instance and op |  | later: M2 |
| `test/integration/job-queue.test.ts` | returns the same job for a double click and keeps one waiting job |  | later: M2 |
| `test/integration/job-queue.test.ts` | gives different jobs to different dedupe keys |  | later: M2 |
| `test/integration/job-queue.test.ts` | stores exactly the ids and nothing else |  | later: M2 |
| `test/integration/job-queue.test.ts` | lists a permanently failed job with its class name only, retries it, and lets it be enqueued again |  | later: M2 |
| `test/integration/job-queue.test.ts` | removes a failed job when the same operation is enqueued again |  | later: M2 |
| `test/integration/job-queue.test.ts` | rejects a retry for an unknown job with NotFoundError |  | later: M2 |
| `test/integration/job-queue.test.ts` | does not add an error listener per call (no MaxListenersExceededWarning) |  | later: M2 |
| `test/integration/job-queue.test.ts` | does not drop a request whose twin job is still active: it gets its own job |  | later: M2 |
| `test/integration/job-queue.test.ts` | fails fast with queue_unavailable instead of hanging |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | lets one of two concurrent callers run and skips the other |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | releases the lock when the work throws |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | frees a lock whose holder vanished once its ttl expires |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | does not delete a lock that expired and was taken by someone else |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | sweeps stranded PENDING instances before it reconciles (so the reaper cannot fail them first) |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | keeps reconciling in-process while Redis is unreachable |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | runs the reconciler on a schedule and never overlaps across two schedulers |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | keeps ticking when the sweep throws |  | later: M2 |
| `test/integration/job-scheduler.test.ts` | resumes ticking after Redis loses its data (the schedule itself lives in Redis) |  | later: M2 |
| `test/integration/job-shutdown.test.ts` | closes the instance worker within its deadline |  | later: M2 |
| `test/integration/job-shutdown.test.ts` | stops the scheduler within its deadline |  | later: M2 |
| `test/integration/job-shutdown.test.ts` | closes the producer queue without hanging |  | later: M2 |
| `test/integration/job-sweeper.test.ts` | enqueues a stale PENDING instance once, however often it sweeps |  | later: M2 |
| `test/integration/job-sweeper.test.ts` | skips a PENDING instance younger than the threshold |  | later: M2 |
| `test/integration/job-sweeper.test.ts` | skips instances in any other state |  | later: M2 |
| `test/integration/job-sweeper.test.ts` | honours the limit, oldest first |  | later: M2 |
| `test/integration/job-worker.test.ts` | treats state, lookup and validation errors as permanent and everything else as retryable |  | later: M2 |
| `test/integration/job-worker.test.ts` | takes a PENDING instance to ACTIVE with a provision job |  | later: M2 |
| `test/integration/job-worker.test.ts` | stops and starts an instance with jobs |  | later: M2 |
| `test/integration/job-worker.test.ts` | treats a second stop for an already stopped instance as a no-op (one stopped event) |  | later: M2 |
| `test/integration/job-worker.test.ts` | does not retry a restart for an instance in a transitional state (permanent, one attempt) |  | later: M2 |
| `test/integration/job-worker.test.ts` | retries a transient runtime failure and then succeeds |  | later: M2 |
| `test/integration/job-worker.test.ts` | gives up after four attempts and records only the error class, never its message |  | later: M2 |
| `test/integration/job-worker.test.ts` | fails an unknown operation permanently |  | later: M2 |
| `test/integration/job-worker.test.ts` | completes a delete job for an instance that is already deleted |  | later: M2 |
| `test/integration/job-worker.test.ts` | does not run a restart twice when its job stalls: it fails as JobStalled instead of being redelivered |  | later: M2 |
| `test/integration/key-wiring.test.ts` | passes a derived API key and the configured runtime to ensure, never in env |  | later: M2 |
| `test/integration/key-wiring.test.ts` | passes runsc through when configured |  | later: M2 |
| `test/integration/key-wiring.test.ts` | probes readiness with the derived key |  | later: M2 |
| `test/integration/key-wiring.test.ts` | fails provisioning with health_check_timeout when the gateway rejects the key |  | later: M2 |
| `test/integration/key-wiring.test.ts` | recreates a vanished container with the same key and probes with it |  | later: M2 |
| `test/integration/key-wiring.test.ts` | marks a rejected key as degraded (auth_rejected) at once, and never restarts for it |  | later: M2 |
| `test/integration/key-wiring.test.ts` | never exposes the key or the master key in the view, events or logs |  | later: M2 |
| `test/integration/lease.test.ts` | never reaps a long-running provisioning (heartbeat keeps the lease alive) and clears the lease when done |  | later: M2 |
| `test/integration/lease.test.ts` | never reaps a slow stop or a slow delete |  | later: M2 |
| `test/integration/lease.test.ts` | never reaps an in-flight reconciler recovery |  | later: M2 |
| `test/integration/lease.test.ts` | reaps an operation whose lease expired (owner process died), even if the row was updated recently |  | later: M2 |
| `test/integration/lease.test.ts` | keeps an old-looking row alone while its lease is still valid |  | later: M2 |
| `test/integration/lease.test.ts` | reaps once a heartbeat stops (simulated crash) but not while it is beating |  | later: M2 |
| `test/integration/lease.test.ts` | finishes an abandoned DELETING instance whose lease expired |  | later: M2 |
| `test/integration/lease.test.ts` | fences the takeover: a lease renewed after the reaper looked cannot be overwritten |  | later: M2 |
| `test/integration/lease.test.ts` | stops renewing after maxOperationMs so a hung operation is eventually reaped, and the zombie cannot overwrite the result |  | later: M2 |
| `test/integration/network-policy.test.ts` | passes the egress policy on every ensure call |  | later: M1 |
| `test/integration/network-policy.test.ts` | passes off through when the policy is not enforced |  | later: M1 |
| `test/integration/network-policy.test.ts` | provisioning ends FAILED with reason network_policy_missing |  | later: M1 |
| `test/integration/network-policy.test.ts` | recovery never starts the container and ends DEGRADED, then exhausted after the bounded attempts |  | later: M1 |
| `test/integration/network-policy.test.ts` | a user start with a network that lacks the policy name is refused and never starts the container |  | later: M1 |
| `test/integration/network-policy.test.ts` | a user start still works when the policy is off |  | later: M1 |
| `test/integration/network-policy.test.ts` | a user restart with a network that lacks the policy name is refused and changes nothing |  | later: M1 |
| `test/integration/network-policy.test.ts` | a reconciler restart with a network that lacks the policy name never restarts the container |  | later: M1 |
| `test/integration/operator-jobs.test.ts` | requires the admin token |  | later: M2 |
| `test/integration/operator-jobs.test.ts` | answers 503 queue_unavailable in inline mode |  | later: M2 |
| `test/integration/operator-jobs.test.ts` | lists an exhausted job without message text, and a retry brings the instance up once the runtime is fixed |  | later: M2 |
| `test/integration/operator-jobs.test.ts` | answers 404 when retrying a job that is not in the failed set |  | later: M2 |
| `test/integration/persistence.test.ts` | keeps /opt/data across container removal and recreation, and wipes it on volume delete |  | later: M2 |
| `test/integration/provider-service.test.ts` | put stores BYOK config with an encrypted key, UNTESTED status, a hint and a bumped revision |  | later: M4 |
| `test/integration/provider-service.test.ts` | it.each([ ['http scheme', 'http://llm.example.com/v1'], ['userinfo', 'https://u: |  | later: M4 |
| `test/integration/provider-service.test.ts` | rejects bad model names and bad keys |  | later: M4 |
| `test/integration/provider-service.test.ts` | test calls GET {baseUrl}/models with the key and records OK without storing the upstream body |  | later: M4 |
| `test/integration/provider-service.test.ts` | test maps upstream status %i to %s |  | later: M4 |
| `test/integration/provider-service.test.ts` | test maps transport problems to coarse codes and never touches the instance status |  | later: M4 |
| `test/integration/provider-service.test.ts` | test of a blocked destination throws outbound_blocked and records blocked |  | later: M4 |
| `test/integration/provider-service.test.ts` | replacing the key revokes the old secret; there is still one config |  | later: M4 |
| `test/integration/provider-service.test.ts` | list returns [] before configuration and one redacted entry after |  | later: M4 |
| `test/integration/provider-service.test.ts` | remove revokes the secret, deletes the config and bumps the revision; a wrong id is not found |  | later: M4 |
| `test/integration/provider-service.test.ts` | another tenant's instance is not found for every operation |  | later: M4 |
| `test/integration/provider-service.test.ts` | attachNibieRouter uses the fixed router URL, hides the key hint and replaces a BYOK config |  | later: M4 |
| `test/integration/provider-service.test.ts` | the key never appears in logs, events, errors or stored rows |  | later: M4 |
| `test/integration/provider-service.test.ts` | two saves at once leave exactly one live secret and one config |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | deleting an instance removes its configuration rows and secret rows, with a value-free event |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | a failed runtime removal keeps the credentials of the instance that still exists |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | the stale-operation reaper that finishes a deletion purges as well |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | purging twice is harmless |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | a revoked secret keeps no hint |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | returns the tail with the instance own secrets, API key and token shapes scrubbed |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | caps the number of lines and passes a bounded tail to the runtime |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | another tenant's instance is not found |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | an instance whose container is gone has no log lines |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | returns stdout and stderr lines, oldest first, limited to the tail |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | an unknown instance has no lines |  | later: M4 |
| `test/integration/purge-and-logs.test.ts` | clamps an absurd tail request instead of reading everything |  | later: M4 |
| `test/integration/reap-pending.test.ts` | are failed as stalled by default (inline mode has no other recovery) |  | later: M2 |
| `test/integration/reap-pending.test.ts` | are left alone when the queue sweeper owns them (reapPending: false) |  | later: M2 |
| `test/integration/recovery.test.ts` | does nothing to a healthy instance |  | later: M2 |
| `test/integration/recovery.test.ts` | recovers a killed container with data intact |  | later: M2 |
| `test/integration/recovery.test.ts` | recovers when the container is gone but the volume remains |  | later: M2 |
| `test/integration/recovery.test.ts` | bounds a crash loop: backoff, then exhausted with one event and no further starts |  | later: M2 |
| `test/integration/recovery.test.ts` | a manual restart after exhaustion resets the counters |  | later: M2 |
| `test/integration/recovery.test.ts` | reports an out-of-memory exit in the event without leaking anything else |  | later: M2 |
| `test/integration/recovery.test.ts` | marks an unhealthy-but-running instance degraded and only restarts after the threshold |  | later: M2 |
| `test/integration/recovery.test.ts` | returns a degraded instance to ACTIVE when it is healthy again |  | later: M2 |
| `test/integration/recovery.test.ts` | never restarts a STOPPED instance |  | later: M2 |
| `test/integration/recovery.test.ts` | skips and changes nothing when Docker is unavailable |  | later: M2 |
| `test/integration/recovery.test.ts` | reconcileAll visits every watched instance and survives one failing |  | later: M2 |
| `test/integration/recovery.test.ts` | bounds a crash loop even when every restart passes one health check before crashing again |  | later: M2 |
| `test/integration/recovery.test.ts` | resets recovery counters only after the container has stayed up for the stability window |  | later: M2 |
| `test/integration/recovery.test.ts` | claims the instance during recovery so a concurrent delete or stop gets ConflictError |  | later: M2 |
| `test/integration/recovery.test.ts` | moves a stale STARTING instance to DEGRADED so normal recovery takes over |  | later: M2 |
| `test/integration/recovery.test.ts` | finishes a stale DELETING instance |  | later: M2 |
| `test/integration/recovery.test.ts` | finishes a stale STOPPING instance |  | later: M2 |
| `test/integration/recovery.test.ts` | fails a stale PROVISIONING instance so the same idempotency key can retry it |  | later: M2 |
| `test/integration/recovery.test.ts` | leaves recent transitional states alone |  | later: M2 |
| `test/integration/recovery.test.ts` | logs only the error class when reconciling fails, never the message |  | later: M2 |
| `test/integration/router-provisioner.test.ts` | creates the user, attaches a per-instance key and grants the credit once |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | restarts the instance once after attaching the key, and a failed restart does not undo the provisioning |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | is idempotent: running again changes nothing at the router |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | a plan without credit gets a key and no grant |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | one router user per tenant, one key per instance |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | two runs at once create one router user |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | an instance with its own provider keeps it, and a credit-less plan makes no router call at all |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | an instance with its own provider still receives the included credit, without a new key |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | a router outage leaves the row PENDING with a short code, and the tick finishes it later |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | a failed key creation does not repeat the user, and the retry attaches the key |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | credit is granted exactly once when the answer of the grant was lost |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | when the history cannot be checked after an ambiguous grant, it does not post again |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | an unrevoked key of the same name that we hold no secret for blocks the run with orphan_key |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | skips a deleted instance |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | runPending creates the row for an instance that was linked but never recorded, and stops at MAX_ATTEMPTS |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | gives an ACTIVE free-plan instance without a provider a router key with the default model, and no credit |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | runNewFree attaches the key to a new free instance at once, tries each one only once, and leaves retries to runPending |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | never replaces a free instance\ |  | later: M5 |
| `test/integration/router-provisioner.test.ts` | never stores the router secret in the provisioning row or leaks it in lastError |  | later: M5 |
| `test/integration/runtime-config.test.ts` | ensure seeds a managed model block into the volume of a new container, owned by the hermes user |  | later: M4 |
| `test/integration/runtime-config.test.ts` | ensure without modelConfig writes no config file |  | later: M4 |
| `test/integration/runtime-config.test.ts` | ensure on an existing container leaves its configuration alone (idempotent) |  | later: M4 |
| `test/integration/runtime-config.test.ts` | recreate replaces the container with new environment and keeps the volume contents |  | later: M4 |
| `test/integration/runtime-config.test.ts` | recreate with modelConfig null removes a block the platform wrote and nothing else |  | later: M4 |
| `test/integration/runtime-config.test.ts` | recreate with modelConfig undefined does not touch the file |  | later: M4 |
| `test/integration/runtime-config.test.ts` | an unreadable config.yaml fails the recreate and leaves no half-configured container behind |  | later: M4 |
| `test/integration/runtime-config.test.ts` | a config.yaml far larger than the cap is refused without being read into memory |  | later: M4 |
| `test/integration/runtime-manager.test.ts` | ensure creates volume, network and an unstarted container |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | refuses an existing unquotaed volume in enforce mode and never creates a container |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | ensure is idempotent: one container, one volume, one network |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | start makes it running with a loopback host port and passing health check |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | stop then start works and stop is idempotent |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | restart produces a newer startedAt |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | remove on an absent instance is a no-op and inspect reports absent |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | checkHealth reports not ok (without throwing) when stopped |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | remove keeps the volume unless deleteVolume is true |  | later: M1 |
| `test/integration/runtime-manager.test.ts` | maps an unreachable Docker daemon to RuntimeUnavailableError |  | later: M1 |
| `test/integration/safe-fetch.test.ts` | connects to the validated address, keeps Host and SNI, and resolves exactly once |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | blocks the literal address %s without any network call |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | blocks a hostname that resolves to a forbidden address, even if another answer is public |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | does not re-resolve at connection time (rebinding): the second answer is never used |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | refuses http, userinfo, and non-URLs |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | does not follow redirects, and never contacts the redirect target |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | aborts when the body exceeds maxBytes |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | aborts at the timeout when the body never ends |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | enforces allowHosts |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | errors never echo the URL, the address or the headers |  | later: M4 |
| `test/integration/safe-fetch.test.ts` | an unreachable host reports a coarse reason only |  | later: M4 |
| `test/integration/schema.test.ts` | rejects duplicate (tenantId, idempotencyKey) with P2002 |  | later: M2 |
| `test/integration/schema.test.ts` | allows the same idempotencyKey for different tenants |  | later: M2 |
| `test/integration/schema.test.ts` | rejects an unknown tenantId (foreign key) |  | later: M2 |
| `test/integration/schema.test.ts` | refuses to delete an instance row (events must survive) |  | later: M2 |
| `test/integration/schema.test.ts` | defaults status to PENDING with zeroed recovery counters |  | later: M2 |
| `test/integration/schema.test.ts` | has disk usage columns: diskUsedBytes nullable, diskLevel defaulting to ok |  | later: M2 |
| `test/integration/schema.test.ts` | rejects a second tenant membership for the same user (one user = one tenant) |  | later: M2 |
| `test/integration/schema.test.ts` | defaults the role to OWNER |  | later: M2 |
| `test/integration/schema.test.ts` | refuses to delete a user or a tenant that has a membership |  | later: M2 |
| `test/integration/schema.test.ts` | resetDb leaves no users or memberships |  | later: M2 |
| `test/integration/schema.test.ts` | stores a display name and defaults to active |  | later: M2 |
| `test/integration/secret-store.test.ts` | put returns an id and a hint, and no column of the row holds the plaintext |  | later: M4 |
| `test/integration/secret-store.test.ts` | get round-trips for the owning tenant only |  | later: M4 |
| `test/integration/secret-store.test.ts` | a row moved to another tenant cannot be decrypted (AAD binds the tenant) |  | later: M4 |
| `test/integration/secret-store.test.ts` | get of a revoked secret is not found |  | later: M4 |
| `test/integration/secret-store.test.ts` | revoke keeps no usable ciphertext |  | later: M4 |
| `test/integration/secret-store.test.ts` | rewrapAll moves rows to the new key version and keeps ids and plaintext |  | later: M4 |
| `test/integration/secret-store.test.ts` | a store without the right key fails closed with a generic error |  | later: M4 |
| `test/integration/secret-store.test.ts` | countsByVersion reports how many secrets use each key version (no keys, no values) |  | later: M4 |
| `test/integration/secret-store.test.ts` | deleteMany removes the rows entirely |  | later: M4 |
| `test/integration/sumopod-webhook.test.ts` | accepts a correctly signed payment and marks it PAID |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | no longer accepts the token alone |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | rejects a body changed after signing, e.g. a failure turned into a payment |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | rejects a signed message replayed outside the five-minute window |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | answers 400 to a body that is not JSON |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | rejects a wrong or missing X-Webhook-Token |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | acknowledges payment.test with 200 and writes nothing |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | reads order_id from the data envelope, not the top level |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | normalizes a word status to the Duitku paid code instead of writing FAILED |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | marks a failure status FAILED and leaves the subscription unpaid |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | is idempotent: a redelivered event is a no-op |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | accepts a flat body (older/manual callers) |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | rejects an amount mismatch without paying |  | later: M5 |
| `test/integration/sumopod-webhook.test.ts` | accepts an unknown order and records the event |  | later: M5 |
| `test/integration/telegram-service.test.ts` | put validates the token with getMe, stores it encrypted and bumps the config revision |  | later: M4 |
| `test/integration/telegram-service.test.ts` | rejects a token Telegram refuses and stores nothing |  | later: M4 |
| `test/integration/telegram-service.test.ts` | rejects malformed tokens before anything is sent to Telegram (no path injection) |  | later: M4 |
| `test/integration/telegram-service.test.ts` | requires a non-empty list of numeric allowed user ids (no open bot) |  | later: M4 |
| `test/integration/telegram-service.test.ts` | refuses a bot that another instance already uses (one bot, one tenant) |  | later: M4 |
| `test/integration/telegram-service.test.ts` | replacing the token revokes the old secret and keeps one connection |  | later: M4 |
| `test/integration/telegram-service.test.ts` | get returns null before configuration and a redacted view after |  | later: M4 |
| `test/integration/telegram-service.test.ts` | remove revokes the secret, deletes the connection and bumps the revision |  | later: M4 |
| `test/integration/telegram-service.test.ts` | verify sends one fixed test message to the first allowed user and records success |  | later: M4 |
| `test/integration/telegram-service.test.ts` | verify reports needs_start when the user has not started the bot, without failing the call |  | later: M4 |
| `test/integration/telegram-service.test.ts` | a Telegram outage on verify throws a coarse error and never touches the instance status |  | later: M4 |
| `test/integration/telegram-service.test.ts` | another tenant's instance is not found for every operation |  | later: M4 |
| `test/integration/telegram-service.test.ts` | the token never appears in logs, events, errors or stored rows |  | later: M4 |
| `test/integration/telegram-service.test.ts` | a Telegram 5xx on getMe is an outage, not a rejected token: put stores nothing and verify changes nothing |  | later: M4 |
| `test/integration/telegram-service.test.ts` | two saves at once leave exactly one live secret and one config |  | later: M4 |
| `test/integration/waitlist.test.ts` | stores a normalized entry and answers the same for a duplicate, without changing the first one |  | later: M3 |
| `test/integration/waitlist.test.ts` | does not reveal an entry that was already invited or registered |  | later: M3 |
| `test/integration/waitlist.test.ts` | stores nothing for a bot that fills the honeypot, and answers like a person |  | later: M3 |
| `test/integration/waitlist.test.ts` | it.each([ ['an unknown key', person(1, { admin: true })], ['a bad email', person |  | later: M3 |
| `test/integration/waitlist.test.ts` | accepts a use case of exactly 500 characters |  | later: M3 |
| `test/integration/waitlist.test.ts` | limits one visitor to 5 entries per 10 minutes, per address and not per proxy |  | later: M3 |
| `test/integration/waitlist.test.ts` | answers 503 waitlist_full beyond the cap instead of growing without bound |  | later: M3 |
| `test/integration/waitlist.test.ts` | needs no sign-in and the Caddy allowlist forwards it |  | later: M3 |
| `test/integration/waitlist.test.ts` | answers 503 waitlist_unavailable and stores nothing when email cannot be sent |  | later: M3 |
| `test/integration/waitlist.test.ts` | refuses a join without a solved captcha before anything is stored or sent |  | later: M3 |
| `test/integration/waitlist.test.ts` | accepts a solved captcha and checks it against the visitor address |  | later: M3 |
| `test/integration/waitlist.test.ts` | fails closed with 503 when the captcha service cannot be reached |  | later: M3 |
| `test/integration/waitlist.test.ts` | a failed confirmation email answers 503 and the person may ask again at once |  | later: M3 |
| `test/integration/waitlist.test.ts` | caps unconfirmed entries separately, so a flood of unconfirmed addresses does not fill the queue |  | later: M3 |
| `test/integration/waitlist.test.ts` | emails a link to the landing page with the token in the fragment; confirming makes the entry WAITING |  | later: M3 |
| `test/integration/waitlist.test.ts` | answers 400 confirm_link_invalid for %s |  | later: M3 |
| `test/integration/waitlist.test.ts` | refuses an expired link, and the entry stays unconfirmed |  | later: M3 |
| `test/integration/waitlist.test.ts` | sends a fresh link when an unconfirmed address joins again after the resend interval; the old link stops working |  | later: M3 |
| `test/integration/waitlist.test.ts` | stops sending links to one address after MAX_CONFIRM_SENDS, with the same answer as before |  | later: M3 |
| `test/integration/waitlist.test.ts` | refuses every new link once the platform-wide hourly cap is reached, and only sends from the last hour count |  | later: M3 |
| `test/integration/waitlist.test.ts` | an unconfirmed entry holds nothing: it is not counted, not invited, and deleted once its link expires |  | later: M3 |
| `test/integration/waitlist.test.ts` | once confirmed, the entry is counted and invited like any other |  | later: M3 |
| `test/integration/waitlist.test.ts` | invites nobody while the slots are used, and the oldest first when one opens |  | later: M3 |
| `test/integration/waitlist.test.ts` | is idempotent: running again, or from two places at once, never invites more than the free slots |  | later: M3 |
| `test/integration/waitlist.test.ts` | counts slots held by open invitations, so a slot is never offered twice |  | later: M3 |
| `test/integration/waitlist.test.ts` | moves on to the next in line when the 48 hour window passes, and does not invite the lapsed person again |  | later: M3 |
| `test/integration/waitlist.test.ts` | marks a person REGISTERED once they hold a free instance, and the slot is counted once |  | later: M3 |
| `test/integration/waitlist.test.ts` | puts a failed send back in line with its place, and skips an address that keeps failing |  | later: M3 |
| `test/integration/waitlist.test.ts` | invites nobody without mail or without slots |  | later: M3 |
| `test/integration/waitlist.test.ts` | writes an Indonesian email with the registration link, the deadline, and escapes what the visitor typed |  | later: M3 |
| `test/integration/waitlist.test.ts` | run() is throttled and never throws |  | later: M3 |
| `test/integration/waitlist.test.ts` | holds the freed slot for the invited person: a stranger meets beta_full, the invitee is let in and becomes REGISTERED |  | later: M3 |
| `test/integration/waitlist.test.ts` | without mail the queue cannot invite, so a freed slot is not held back for the people waiting |  | later: M3 |
| `test/integration/waitlist.test.ts` | after the window an invitation holds nothing: the slot is open to anyone again |  | later: M3 |
| `test/integration/waitlist.test.ts` | lists the queue oldest first with counts, read only, for admins only |  | later: M3 |
