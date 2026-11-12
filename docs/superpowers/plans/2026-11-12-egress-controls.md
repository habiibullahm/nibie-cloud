# Egress Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop tenant containers from connecting to the host, cloud metadata, private ranges and other tenants, keep the public internet open, reject outbound SMTP and rate-cap new connections, and make the control plane exit in production if the policy is not in force.

**Architecture:** Each tenant bridge gets a deterministic name `hn<12 hex>`. One static iptables ruleset in `ops/egress/` matches that prefix in `DOCKER-USER` (forwarded traffic) and `INPUT` (traffic to the host). The control plane creates networks with that name and IPv6 off, refuses to reuse a network without it, and at startup runs a canary container that tries to reach listeners the control plane opens on the bridge gateway and on the host's private address.

**Tech Stack:** Node >=22, TypeScript, Zod 4, dockerode 5, Vitest 3.2, pnpm 10.28, bash, iptables.

**Spec:** `docs/superpowers/specs/2026-11-12-egress-controls-design.md`

## Global Constraints

- No git commit, push, stash or reset without Nash's explicit instruction (AGENTS.md). Every "Commit" step runs **only** after Nash says to commit. The repository is public: no keys, tokens, host names, real internal IPs or personal data in any file.
- Config: `HERMES_EGRESS_POLICY` is `enforce | off`, default `enforce`; `off` is rejected when `NODE_ENV=production`. `HERMES_CANARY_IMAGE` is required when `enforce` and must be pinned by `@sha256` digest. `HERMES_CANARY_PRIVATE_IP` is optional (an IPv4 address local to the host). Error messages name the key, never the value.
- Bridge name: `hn` + the first 12 hex characters of the instance UUID without dashes (14 characters). IPv6 disabled on tenant networks (`EnableIPv6: false`). Names derive from the instance UUID only.
- Rule order inside chain `HERMES-EGRESS` (spec 5.2): 1) accept established; 2) accept DNS (UDP and TCP 53) to the configured resolvers only; 3) accept configured single `ip:port` exceptions (empty by default); 4) `REJECT` TCP 25; 5) per-source `hashlimit` cap on new connections, drop above the cap; 6) `REJECT` destinations `0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4`, and in `INPUT` any address local to the host; 7) accept the rest. The chain is jumped to from `DOCKER-USER` and `INPUT` for `-i hn+`.
- The rate-cap value is a **placeholder** until measured (Task 8). Do not describe it as correct.
- No allowlist proxy, no metering, no IPv6 for tenants, no URL validation for provider URLs, no database change.
- Tests that need Docker, root or a Docker host cannot run in the authoring sandbox. Nothing may be reported as passing before Task 8 is run on a Docker host with the rules applied. `pnpm test:unit` and `pnpm build` run anywhere.
- Sequencing: this plan and the disk quota plan both edit `src/config/env.ts`, `src/modules/runtime/types.ts`, `src/modules/runtime/docker-runtime-manager.ts`, `src/modules/instances/instance-service.ts`, `src/modules/instances/reconciler.ts`, `src/main.ts` and `test/helpers/fake-runtime.ts`. Run them one after the other, never in parallel, and re-read those files before starting.

## Review Focus

- A network created before this change (no `hn` bridge name) is never reused while `enforce` is on, and the failure is a fixed code, not a retry loop (Task 3).
- The canary must be able to fail: a closed port on the gateway answers "connection refused", which looks the same as a blocked one, so the control plane opens its own listener and the canary connects to that port (Task 5).
- A canary container or network left behind after any failure (Docker down, image missing, probe error) must be removed (Task 5).
- `HERMES_CANARY_IMAGE` given as a tag instead of a digest is rejected in `enforce` (Task 1).
- DNS must keep working for tenants while all private ranges are blocked, including a host whose own resolver is on a private address (Task 4 dry-run test, Task 8 live check).

---

### Task 1: Config

**Files:**
- Modify: `src/config/env.ts`, `src/modules/runtime/types.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `Config.egressPolicy: 'enforce' | 'off'`, `Config.canaryImage: string | undefined`, `Config.canaryPrivateIp: string | undefined`; `type EgressPolicyMode = 'enforce' | 'off'` and `RuntimeSpec.egressPolicy: EgressPolicyMode` (required) in `types.ts`.

- [ ] **Step 1: Write failing tests.** `defaults HERMES_EGRESS_POLICY to enforce`; `rejects off when NODE_ENV=production` (message names `HERMES_EGRESS_POLICY`, not the value); `accepts off outside production without a canary image`; `requires HERMES_CANARY_IMAGE when enforce`; `rejects a tag-only HERMES_CANARY_IMAGE` (e.g. `alpine:3.20`) `and accepts name@sha256:<64 hex>`; `rejects a non-IPv4 HERMES_CANARY_PRIVATE_IP`.
- [ ] **Step 2:** Run `pnpm vitest run test/unit/config.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** with Zod refinements; add the three `Config` fields. Existing tests that build a config for `enforce` must now set `HERMES_CANARY_IMAGE` (a digest literal), or set `HERMES_EGRESS_POLICY=off`; update `base` in the test accordingly.
- [ ] **Step 4:** Run `pnpm build && pnpm test:unit`. Expected: PASS. (Existing call sites that construct `RuntimeSpec` fail to compile until Task 3; add `egressPolicy: 'off'` to the test literals in `test/unit/hardening.test.ts`, `test/integration/runtime-manager.test.ts`, `isolation.test.ts`, `persistence.test.ts` and `test/validation/runtime-manager-live.ts` now.)
- [ ] **Step 5: Commit** (only on Nash's go-ahead): `feat(config): egress policy settings`.

### Task 2: Host verification spike (no repo code)

Run on the Docker host that will run tenants. It decides the exact network option handling in Task 3 and the persistence handling in Task 4.

**Files:**
- Create: `docs/egress-host-notes.md` (results only, no host names, no real IPs)

**Interfaces:**
- Produces: confirmation or correction of `com.docker.network.bridge.name` semantics, the status code Docker returns on a bridge-name collision, and whether `DOCKER-USER` survives a Docker restart.

- [ ] **Step 1:** `docker network create -d bridge -o com.docker.network.bridge.name=hnaaaaaaaaaaaa -o com.docker.network.bridge.enable_icc=false --ipv6=false probe-net`, then `ip link show hnaaaaaaaaaaaa`. Expected: the interface exists with that exact name.
- [ ] **Step 2:** Create a second network with the same bridge name. Record the HTTP status and message Docker returns.
- [ ] **Step 3:** Run a container on `probe-net` and, from the host, check `iptables -S DOCKER-USER` and `iptables -S INPUT`. Add a test `-i hn+ -j LOG` rule to `DOCKER-USER`, make the container connect out, and confirm the rule's counter increments (`iptables -L DOCKER-USER -n -v`).
- [ ] **Step 4:** Restart Docker (`systemctl restart docker`) and re-run `iptables -S DOCKER-USER`. Record whether the test rule survived. Then reboot-test only if the host allows it. Remove the test rule.
- [ ] **Step 5:** From a container on `probe-net`, resolve a public name and record which resolver the container uses (`cat /etc/resolv.conf`, and the host's upstream resolver address). Record whether that resolver is a private or loopback address.
- [ ] **Step 6:** Repeat Steps 1 and 3 with `--runtime=runsc` containers. Record whether the counter increments under gVisor.
- [ ] **Step 7:** Remove `probe-net` and probe containers; write the results into `docs/egress-host-notes.md` and update the spec's section 5.1, 5.2 and risk list with what was verified and what was not.

### Task 3: Network identity and policy check in the runtime

**Files:**
- Modify: `src/modules/runtime/hardening.ts`, `src/modules/runtime/docker-runtime-manager.ts`, `src/shared/errors.ts`, `src/modules/instances/instance-service.ts`, `src/modules/instances/reconciler.ts`, `src/main.ts`, `test/helpers/fake-runtime.ts`
- Test: `test/unit/network-config.test.ts` (new), `test/integration/network-policy.test.ts` (new; Docker plus Postgres with `FakeRuntime` for the wiring half), `test/unit/hardening.test.ts`

**Interfaces:**
- Consumes: `RuntimeSpec.egressPolicy`; Task 2's recorded collision behavior.
- Produces: `bridgeName(instanceId: string): string` and `buildNetworkConfig(instanceId: string, tenantId?: string): Docker.NetworkCreateOptions` in `hardening.ts` (Options contain `com.docker.network.bridge.name` and `com.docker.network.bridge.enable_icc: 'false'`; `EnableIPv6: false`; the existing labels); `class NetworkPolicyMissingError extends AppError` (status 409, code `network_policy_missing`) in `shared/errors.ts`; `InstanceServiceDeps.egressPolicy` and `ReconcilerDeps.egressPolicy` (`EgressPolicyMode`, required); `FakeRuntime.networkPolicyMissing = false` (when true `ensure()` throws `NetworkPolicyMissingError`).

- [ ] **Step 1: Write failing unit tests** in `network-config.test.ts`: `bridgeName is hn plus the first 12 hex characters of the uuid without dashes`; `bridgeName is 14 characters and stays within the 15 character interface limit`; `bridgeName is the same for upper and lower case ids`; `bridgeName rejects a non-UUID`; `network config disables IPv6 and ICC and sets the bridge name`; `network config keeps the managed and instance labels`.
- [ ] **Step 2:** Run `pnpm vitest run test/unit/network-config.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `bridgeName` and `buildNetworkConfig` in `hardening.ts` and use `buildNetworkConfig` in `DockerRuntimeManager.ensureNetwork`.
- [ ] **Step 4: Write failing integration tests** in `network-policy.test.ts`: `ensure() creates the network with the hn bridge name and IPv6 off` (inspect via dockerode); `ensure() rejects an existing network without the bridge name when enforce` (create a plain `networkName(id)` network first; expect `NetworkPolicyMissingError`); `ensure() reuses an existing network that has the bridge name`; `ensure() accepts an unnamed network when off`; `a collision on create is reported as NetworkPolicyMissingError, not retried` (re-inspect after a create conflict and compare the bridge name); with `FakeRuntime`: `provisioning ends FAILED with reason network_policy_missing` and `recovery never starts the container and ends DEGRADED after the bounded attempts`.
- [ ] **Step 5:** Run `pnpm vitest run test/integration/network-policy.test.ts`. Expected: FAIL.
- [ ] **Step 6: Implement.** In `ensureNetwork`, when the network exists (or after a create conflict) read its `Options['com.docker.network.bridge.name']`; with `spec.egressPolicy === 'enforce'` and a value different from `bridgeName(id)` throw `NetworkPolicyMissingError`. Let `translate()` pass `AppError` subclasses through (it already does after the disk plan; if that plan has not landed, add the same pass-through here). In `provisionSteps` map the error to reason `network_policy_missing`; the reconciler needs no new code (same bounded-retry path as `volume_quota_missing`). Both `ensure()` call sites pass `egressPolicy: this.egressPolicy`; `main.ts` passes `config.egressPolicy`.
- [ ] **Step 7:** Run `pnpm build`, `pnpm test:unit`, and the integration file. Expected: PASS.
- [ ] **Step 8: Commit** (only on Nash's go-ahead): `feat(runtime): deterministic tenant bridge names and network policy check`.

### Task 4: Host ruleset

**Files:**
- Create: `ops/egress/hermes-egress.sh`, `ops/egress/egress.conf.example`, `ops/egress/hermes-egress.service`
- Test: `test/unit/egress-rules.test.ts`

**Interfaces:**
- Produces: `hermes-egress.sh` with subcommands `apply`, `remove`, `status` and a `--dry-run` flag that prints every `iptables` command it would run (one per line, in order) and touches nothing, so tests need no root. Config file keys: `RESOLVERS` (space-separated IPv4), `EXCEPTIONS` (space-separated `ip:port`, empty by default), `NEW_CONN_RATE` (a placeholder, see Global Constraints). `apply` is idempotent: running it twice yields one jump rule per base chain and one `HERMES-EGRESS` chain.

- [ ] **Step 1: Write failing tests** in `egress-rules.test.ts`, spawning `bash ops/egress/hermes-egress.sh apply --dry-run --config <temp file>`: `creates chain HERMES-EGRESS and jumps to it from DOCKER-USER and INPUT for -i hn+`; `accepts established traffic first`; `accepts DNS only to each configured resolver`; `emits no exception rules when EXCEPTIONS is empty and one ACCEPT per ip:port otherwise, before the reject rules`; `rejects TCP 25 before the rate cap and before the range rejects`; `rate-caps new connections with hashlimit`; `rejects every blocked range from the spec, including 169.254.0.0/16`; `rejects addresses local to the host only for INPUT`; `ends with an ACCEPT for everything else`; `contains no rule that matches a hostname`; `rejects a malformed resolver or exception` (non-zero exit, nothing printed); `remove --dry-run deletes the jumps and the chain`. Skip the suite with a clear message when `bash` is unavailable.
- [ ] **Step 2:** Run `pnpm vitest run test/unit/egress-rules.test.ts`. Expected: FAIL (script missing).
- [ ] **Step 3: Implement** the script (`set -euo pipefail`, `#!/usr/bin/env bash`, LF endings; add `ops/egress/*` to `.gitattributes` as `eol=lf`), the example config with documentation comments and no real addresses beyond documentation ranges, and the systemd unit (`After=docker.service`, `Requires=docker.service`, `Type=oneshot`, `RemainAfterExit=yes`, `ExecStart=… apply`, `ExecStop=… remove`, `WantedBy=multi-user.target`). Use `REJECT` (not `DROP`) for TCP 25 and the range rules so applications fail fast; the rate cap uses `DROP`.
- [ ] **Step 4:** Run the test file. Expected: PASS. Run `shellcheck ops/egress/hermes-egress.sh` if available; fix findings.
- [ ] **Step 5: Commit** (only on Nash's go-ahead): `feat(ops): host egress ruleset for tenant bridges`.

### Task 5: Egress canary

**Files:**
- Create: `src/modules/runtime/egress-canary.ts`
- Modify: `src/main.ts`, `src/shared/errors.ts`
- Test: `test/unit/egress-canary.test.ts`, `test/integration/egress-canary.test.ts` (needs Docker, and rules for the positive case; see Task 8)

**Interfaces:**
- Consumes: `buildNetworkConfig`, `bridgeName`, `Config.canaryImage`, `Config.canaryPrivateIp`.
- Produces: `class EgressPolicyError extends Error` (message is a fixed string naming only the failed check: `gateway`, `private` or `metadata`); `type CanaryProbe = { check: 'gateway' | 'private' | 'metadata'; host: string; port: number }`; `evaluateCanary(results: { check: CanaryProbe['check']; connected: boolean }[]): void` (throws `EgressPolicyError` for the first connected result); `runEgressCanary(deps: { docker: DockerLike; image: string; privateIp?: string; listen?: ListenFn; logger: Logger }): Promise<void>` where `DockerLike` is the minimal dockerode surface it uses and `ListenFn(host: string): Promise<{ port: number; close(): Promise<void> }>` defaults to `net.createServer` bound to an ephemeral port on `host`.

- [ ] **Step 1: Write failing unit tests** with a fake docker and fake `listen`: `no probe connects: resolves`; `the gateway probe connects: rejects with EgressPolicyError naming gateway only`; `the private probe is only added when canaryPrivateIp is set`; `the metadata probe targets 169.254.169.254:80 and cannot have a listener`; `opens a listener on the network gateway and on the private IP and probes those exact ports`; `closes the listeners, removes the container and removes the network when everything passes`; `does the same cleanup when a probe connects`; `does the same cleanup when the container cannot be created or the image is missing, and rejects with a different error than EgressPolicyError`; `uses a network built by buildNetworkConfig with a random uuid so the hn prefix matches the rules`; `the canary container runs with CapDrop ALL, a read-only rootfs, no volumes and small memory and pids limits`; `error messages and logs never contain the probe addresses`.
- [ ] **Step 2:** Run `pnpm vitest run test/unit/egress-canary.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Create the canary network from `buildNetworkConfig`, read its gateway from `inspect().IPAM.Config[0].Gateway`, open the listeners, run the canary image with a command that tries each `host:port` using `nc -z -w 3` and prints one `check=connected|blocked` line per probe, read the logs, parse, run `evaluateCanary`, and clean up in a `finally`. The listener on the gateway is what makes a missing rule visible: without it a refused connection would look identical to a blocked one.
- [ ] **Step 4:** Run the unit file and `pnpm build`. Expected: PASS.
- [ ] **Step 5:** In `main.ts`, after the existing startup checks and only when `config.egressPolicy === 'enforce'`, call `runEgressCanary({ docker, image: config.canaryImage!, privateIp: config.canaryPrivateIp, logger })`. On `EgressPolicyError` log the fixed message and `process.exit(1)`.
- [ ] **Step 6: Commit** (only on Nash's go-ahead): `feat(runtime): startup egress canary`.

### Task 6: Docs and operator note

**Files:**
- Modify: `docs/architecture.md`, `docs/setup.md`, `.env.example`, `docs/CURRENT_STATE.md`, `docs/README.md`
- Create: `docs/runbook-egress.md`

- [ ] **Step 1:** `architecture.md`: add network policy rows to the hardening table, describe bridge names, the ruleset and the canary, and rewrite known gap 2 to what remains (allowlist proxy, metering, URL validation for provider and webhook URLs, IPv6, the undecided abuse policy).
- [ ] **Step 2:** `setup.md`: install the ruleset (`ops/egress/`), configure resolvers and exceptions, enable the systemd unit, `HERMES_EGRESS_POLICY`, `HERMES_CANARY_IMAGE`, `HERMES_CANARY_PRIVATE_IP`. `.env.example`: the three keys with comments; `off` is not allowed in production.
- [ ] **Step 3:** `runbook-egress.md`: how to check the rules are loaded (`ops/egress/hermes-egress.sh status`, `iptables -S HERMES-EGRESS`), how to add a single `ip:port` exception for NibieRouter, and what to do when the canary fails (check rules, then Docker restart ordering from the Task 2 notes).
- [ ] **Step 4:** `CURRENT_STATE.md` and `docs/README.md`: record the new files, what was run and what was not.
- [ ] **Step 5:** Check that no real address, host name or key appears in the changed files: `git grep -n -E "([0-9]{1,3}\.){3}[0-9]{1,3}" -- ops docs/setup.md docs/runbook-egress.md .env.example` lists only the spec's blocked ranges and documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`).

### Task 7: Live harness checks

**Files:**
- Modify: `test/validation/runtime-manager-live.ts`

- [ ] **Step 1:** Add checks in the existing `check()` style, run against containers on networks from `buildNetworkConfig`, each for runc and runsc: `tenant cannot reach the bridge gateway` (listener on the gateway, as in the canary); `tenant cannot reach the host's private IP`; `tenant cannot reach 169.254.169.254`; `tenant cannot reach another tenant's container IP`; `TCP 25 to a public address is rejected immediately` (connect fails in under 2 seconds); `a public address is reachable`; `DNS resolves with the configured resolvers`; `a burst of new connections above the cap is dropped`; `an exception from egress.conf makes exactly that ip:port reachable and nothing else on that host`.
- [ ] **Step 2:** `pnpm build`. Expected: no type errors (the harness is not run here).
- [ ] **Step 3: Commit** (only on Nash's go-ahead): `test(validation): egress checks in the live harness`.

### Task 8: Verification on a Docker host

- [ ] **Step 1:** Copy `ops/egress/egress.conf.example` to the host's config path, set `RESOLVERS`, apply the rules (`hermes-egress.sh apply`), and enable the systemd unit. Run `hermes-egress.sh status`. Expected: the chain and both jumps are present.
- [ ] **Step 2:** Run `pnpm install && pnpm build && pnpm test`. Record the totals.
- [ ] **Step 3:** Run `pnpm tsx test/validation/runtime-manager-live.ts` for runc and for runsc. Expected: every check PASS, including the egress checks.
- [ ] **Step 4:** Measure the connection rate of a normal Hermes workload (provider calls, a package install, a web fetch) and set `NEW_CONN_RATE` above it with headroom. Record the measured peak and the chosen value in `docs/egress-host-notes.md`; until this is done the cap stays a placeholder.
- [ ] **Step 5:** Stop the rules (`hermes-egress.sh remove`) and start the control plane with `HERMES_EGRESS_POLICY=enforce`. Expected: it exits with the fixed canary message naming `gateway`. Re-apply the rules and confirm it starts.
- [ ] **Step 6:** Restart Docker and reboot (if allowed) and confirm the rules are still in force and the canary still passes.
- [ ] **Step 7:** Record the full output in `docs/milestone-2-runtime-security.md` under a new "Egress verification" heading. If any step could not run, say so there and in `CURRENT_STATE.md`; do not claim a pass.
