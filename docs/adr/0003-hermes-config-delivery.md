# ADR 0003: How provider and Telegram configuration reach a Hermes container

Status: accepted for milestone C (2026-11-13). Evidence below was gathered in a cloud sandbox against the
pinned image `nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08`
(Hermes Agent v0.23.1), under the same capability set as `runtime/hardening.ts`, with dummy credentials.

## Decision

- **Telegram**: environment variables set when the container is created: `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_ALLOWED_USERS` (comma-separated numeric ids). Polling is the default transport; no
  `TELEGRAM_WEBHOOK_URL` is ever set, so no inbound port is needed.
- **Provider** (BYOK and NibieRouter): **Variant 2**. The control plane seeds a small managed
  `/opt/data/config.yaml` containing only a `model:` block (`default`, `provider: custom`, `base_url`,
  `key_env: HERMES_PROVIDER_API_KEY`) into the volume while the container is created and not started. The key
  itself travels only as the environment variable `HERMES_PROVIDER_API_KEY`; it is never written to a file.
  No shell exec into tenant containers is used.

## Evidence

1. With only Telegram variables set, the gateway starts, the Telegram adapter logs connection attempts and retries
   (8 attempts with backoff), and the authenticated API server answers `200` on `/api/sessions` the whole time.
   An unreachable or invalid Telegram setup therefore does not take the API (and the health check) down.
2. The Telegram adapter also tries hard-coded Telegram IPs (`149.154.x.x`) and a DNS-over-HTTPS lookup before the
   normal hostname. The tenant egress allowlist (milestone, `ops/egress/`) must permit `api.telegram.org` and
   those ranges, or the adapter will retry and never connect. Not verified against the real host ruleset.
3. A `config.yaml` written into an empty volume before first boot is kept: the image's migration reports
   `Config version: 0 -> 53` and leaves the `model:` block intact. At runtime the gateway used the seeded
   `base_url`, sent `Authorization: Bearer <value of HERMES_PROVIDER_API_KEY>` to it (observed with a mock
   OpenAI-compatible server on the tenant network), and neither the key nor its canary appears in `/opt/data`
   or in the container logs.
4. Without a TTY and without the `gateway run` command the image starts its interactive CLI and exits; the
   runtime manager always passes `Cmd: ['gateway', 'run']`, which is why it must stay.
5. `OPENAI_BASE_URL` only applies to the `openai-api` provider and `LLM_MODEL` is removed upstream, so an
   environment-only path for a custom endpoint and model does not exist (Variant 1 rejected).

## Consequences

- A changed token, provider key or model needs a container **recreation** (environment is fixed at creation);
  the data volume is kept. The `model:` block is rewritten by the same seed step, so it applies to a stopped
  container only. Customers who edit `config.yaml` themselves later (file manager milestone) will have their
  `model:` block managed by the platform; the rest of the file is theirs. Writing only the `model:` block into
  an existing file is a merge, specified in milestone C Task 8.
- Environment values are visible to anyone who can `docker inspect` on the host, the same trust boundary as
  the Docker socket.

## Not verified

A real model reply through a real provider, a real Telegram bot, the egress ruleset on a real host.
