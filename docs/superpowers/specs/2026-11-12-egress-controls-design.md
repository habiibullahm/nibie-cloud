# Network egress controls for tenant containers

Date: 2026-11-12
Status: approved by the owner (2026-11-12) and implemented on branch `feat/egress-controls`; host
verification (plan Task 8) is open, so nothing here is proven on a Docker host yet.
Related: PRD 7.3 (network policy and SSRF), PRD 7.1 ("Do not use host networking"),
`docs/architecture.md` known gap 2. Companion spec: `2026-11-12-disk-quota-design.md`.

## 1. Problem

Each instance has its own bridge network with inter-container communication disabled, so tenants
cannot reach each other's containers. Nothing else restricts outbound traffic. Hermes runs shell
commands and fetches URLs on a customer's behalf, so a customer, or a malicious prompt, can make a
tenant container connect to the host (through the bridge gateway or the host's own addresses), to
cloud metadata at `169.254.169.254`, to private networks, or to other tenants' private ranges.
That is the SSRF and lateral-movement risk in PRD 7.3. There is also no limit on spam or scanning
from a tenant.

## 2. Goals and non-goals

Goals
- Tenant containers cannot connect to the host, metadata, private, link-local or other reserved
  ranges, or to other tenants, enforced at the network level (not by URL validation alone).
- The public internet stays reachable, so tenants keep real Hermes freedom (PRD 2.2).
- Cheap abuse limits: outbound SMTP (TCP 25) is rejected and new connections are rate-capped per
  tenant.
- The control plane fails closed in production if the policy is not in force.

Non-goals (stay open)
- A domain allowlist or egress proxy (decided against for now).
- Egress traffic metering or bandwidth caps (PRD 4 mentions egress cost).
- IPv6 support for tenants (disabled instead).
- URL validation for custom provider base URLs and Telegram/webhook targets. That belongs to the
  BYOK and provider-config work (PRD 8.2), which is not built yet. This layer backs it up and holds
  even if that validation is wrong.
- Per-plan egress policy, egress logging, multi-node.
- Any dashboard or frontend work. No git commits and no repository move are part of this spec.

## 3. Decisions (made with the project owner on 2026-11-12)

| Topic | Decision |
| --- | --- |
| Scope | Two separate specs; this is the second. |
| Openness | Public internet open; internal ranges blocked; plus abuse limits (TCP 25 reject, connection rate cap). |
| NibieRouter location | Not decided. Design assumes a public URL and supports an optional, empty-by-default list of single `ip:port` exceptions. |
| Mechanism | Approach 1 below. |

## 4. Approaches considered

1. **One static host firewall ruleset matched on a tenant bridge-name prefix (chosen).** Each tenant
   network gets a deterministic bridge name; one ruleset matches the prefix. No per-tenant rules, no
   subnet bookkeeping, no root in the control plane.
2. **Control plane edits firewall rules per tenant** through a privileged helper. Finer control, much
   more machinery, new attack surface.
3. **Domain allowlist via an egress proxy.** Strongest, but breaks open browsing and custom URLs.
   Rejected for now by the project owner.

## 5. Design

### 5.1 Tenant network identity (`src/modules/runtime`)

- `ensureNetwork()` creates the network with the option `com.docker.network.bridge.name` set to
  `hn` plus the first 12 hex characters of the instance UUID without dashes (14 characters, under the
  15-character interface-name limit), and with IPv6 disabled (`EnableIPv6: false`).
- The name derives only from the instance UUID, like all Docker names today. A collision makes
  network creation fail with a conflict, which maps to a fixed failure code, never a retry loop.
- An existing network without that bridge name, when the policy is `enforce`: the instance goes to
  `FAILED` with the fixed reason `network_policy_missing`. Docker cannot change a network's bridge
  name in place, so the fix is to delete and reprovision. There are no production tenants yet.
- **Verified (cloud sandbox, Docker 29.9.2):** Docker honors the option and the interface is named
  exactly as asked; a bridge-name collision is HTTP 403 `networks have same bridge name` (a duplicate
  network name is 409). **Not verified:** that the rules see that interface for container traffic, on
  runc or runsc (no container could be started there). Details: `docs/egress-host-notes.md`.

### 5.2 Host ruleset (`ops/egress/`, new)

An idempotent apply script plus a systemd unit that runs it after `docker.service` starts. It uses
`iptables` (matching the existing note that published ports bypass UFW and policy lives in
`DOCKER-USER` and `INPUT`) and owns a single chain, `HERMES-EGRESS`, jumped to from:
- `DOCKER-USER`, for traffic forwarded out of tenant bridges (`-i hn+`);
- `INPUT`, for traffic from tenant bridges to the host itself (`-i hn+`).

Rule order inside `HERMES-EGRESS`:
1. Accept return traffic for established connections.
2. Accept DNS (UDP and TCP 53) only to the configured resolvers (default list in the config file).
3. Accept the configured exceptions, each a single `ip:port` (empty by default; this is where a private
   NibieRouter address would go).
4. Reject TCP 25 to anywhere (`REJECT`, so applications fail fast).
5. Rate-cap new outbound connections per source tenant address (`hashlimit`), dropping above the cap.
6. Reject destinations in: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`,
   `169.254.0.0/16` (includes metadata), `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`,
   `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`, and (in `INPUT`) any address local to the host.
7. Accept everything else (the public internet).

Notes
- Filtering is on the destination IP at connect time, so a DNS answer that points at a blocked
  address (DNS rebinding) is blocked here regardless of the hostname.
- Tenant-to-tenant traffic is already limited by per-network isolation, and other tenants' addresses
  fall inside the blocked private ranges as well.
- Configuration (resolvers, exceptions, rate cap) lives in a small file read by the script, never in
  the repo's secrets. No credentials appear in rules or docs.
- **Starting rate cap is a placeholder.** The spec does not claim a value is correct; the plan measures
  a normal Hermes workload on the host and sets the cap above it.
- **Implemented differently from the list above:** the chain ends with `RETURN`, not `ACCEPT`, so
  Docker's own chains and the host firewall still see public traffic (an `ACCEPT` in `DOCKER-USER`
  would skip Docker's isolation chains). Established, DNS and exception rules still `ACCEPT`. The
  host-local reject sits in the shared chain and can only match traffic arriving through `INPUT`.
- **Verified (sandbox kernel, real `iptables`):** the ruleset loads, `apply` is idempotent (one jump
  per base chain), `remove` and `status` behave. **Unverified:** that `DOCKER-USER` contents survive a
  Docker restart and a host reboot with the systemd unit ordering above; and that DNS from a tenant
  works end to end with the default resolver list on the real host.

### 5.3 Control-plane configuration and canary (`src/config/env.ts`, startup)

- `HERMES_EGRESS_POLICY`: `enforce | off`. Default `enforce`. `off` is rejected when
  `NODE_ENV=production`. Error messages name the key only.
- With `enforce`, startup runs an **egress canary**: a short-lived container on a temporary network
  using the same bridge-name prefix and hardening, from an image pinned by digest
  (`HERMES_CANARY_IMAGE`, required in enforce mode), that tries to open TCP connections to:
  the bridge gateway of its own network, `169.254.169.254:80`, and a private address configured in the
  canary settings. Any successful connection makes the control plane exit with a fixed error and no
  target details in logs beyond which check failed. The canary container and network are removed in all
  cases.
- A closed port answers "connection refused", which looks the same as a blocked one, so the control
  plane opens its own listener on the bridge gateway (and on the configured private host address) and
  the canary connects to that listener. A successful connection means the rule is missing. The
  metadata address cannot have a listener, so that probe only counts if it connects.
- The canary proves the rules exist and match; it does not prove the public internet is reachable. That
  positive check lives in the live harness (5.5).
- The canary can only prove what it probes. It is a tripwire, not a full audit.

### 5.4 Error handling

| Situation | Behavior |
| --- | --- |
| Canary reaches a blocked target | Process exits; error names the failed check only. |
| Canary cannot run (Docker down, image missing) | Process exits in enforce mode; clear message. |
| Existing tenant network lacks the bridge name | Instance `FAILED` with `network_policy_missing`. |
| Bridge-name collision | Network create fails with a fixed code; instance `FAILED`. |
| Tenant makes thousands of connections | Rate cap drops the excess; no instance state change. |
| Tenant sends SMTP on port 25 | Connection rejected immediately. |

No database schema change. No new `InstanceEvent` types in this spec.

### 5.5 Tests

- Unit: network create options contain the expected bridge name and `EnableIPv6: false`; the bridge
  name is derived only from the UUID and stays within 15 characters; config rejects
  `HERMES_EGRESS_POLICY=off` in production and unknown values; canary decision logic with fake
  connection results.
- Integration (fake `RuntimeManager`): a network without the bridge name leads to `FAILED` with
  `network_policy_missing` in enforce mode.
- Live harness (`test/validation/runtime-manager-live.ts`, needs a Docker host with the rules applied),
  on both runc and runsc: a tenant cannot reach the gateway, the host's own address, the metadata
  address, a private address, or another tenant's container; TCP 25 is rejected; a public address is
  reachable; DNS resolves; a burst of connections is capped. Running under runsc matters because its
  network path has not yet been shown to hit these rules.
- Verification: none of this can run in the authoring environment. The implementation plan ends with
  a verification task on a Docker host. No pass is claimed before then.

### 5.6 Docs

- `docs/architecture.md`: add network policy rows to the hardening table and narrow known gap 2 to
  what remains (allowlist proxy, metering, URL validation, IPv6).
- `docs/setup.md` and `.env.example`: apply the ruleset, systemd unit, `HERMES_EGRESS_POLICY`,
  `HERMES_CANARY_IMAGE`, how to add an exception.
- A short runbook note for operators: how to check the rules are loaded and what to do if the canary
  fails.
- Update `docs/CURRENT_STATE.md` and `docs/SESSION_HANDOFF.md` per the AGENTS.md continuity protocol.

## 6. Sequencing and file overlap

The hardening-wiring work has landed. This design touches `src/config/env.ts`,
`src/modules/runtime/hardening.ts` (or wherever network creation now lives),
`docker-runtime-manager.ts`, and startup in `src/main.ts`, plus new files under `ops/egress/`. It
overlaps with the disk quota spec on `env.ts` and the runtime manager, so the two implementation
plans must be sequenced (either order) rather than run in parallel. The file list above must be
re-checked against the tree at plan time.

## 7. Risks and open points

- **Rule persistence and traffic behaviour are unverified** (5.1, 5.2): plan Tasks 2 (steps 3 to 6) and 8.
- **gVisor (`runsc`) network path** is untested against these rules; the live harness covers both
  runtimes before this is called done.
- **The rate cap value is unknown** until measured; too low breaks legitimate agents, too high does
  little.
- **Public targets are still reachable.** A customer can scan or attack public hosts within the rate
  cap. The abuse policy (PRD 21 item 11) is still undecided.
- **The canary is a tripwire**, not a proof that every range is blocked.
- **NibieRouter on a private address** requires an operator to add the exception; until decided, the
  default is no exception.
- **Rule ordering with Docker's own chains** can change between Docker versions; the harness is the
  guard.

## 8. Acceptance criteria

1. Every tenant network is created with the `hn` bridge name and IPv6 disabled; an existing network
   without it is never reused in enforce mode.
2. Config rejects `HERMES_EGRESS_POLICY=off` when `NODE_ENV=production` and rejects unknown values.
3. The canary exits the process if it can reach the gateway, the metadata address, or the configured
   private address, and cleans up after itself.
4. The live harness on a Docker host shows, for runc and runsc: blocked host, metadata, private and
   cross-tenant targets, rejected TCP 25, working DNS and public access, and a capped burst, with the
   output recorded; or the work is explicitly reported as unverified.
5. `docs/architecture.md`, `docs/setup.md`, `.env.example` and the operator note match the code.
