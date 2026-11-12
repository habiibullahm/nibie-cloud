# Hardening Wiring and Milestone 2.2 Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real provisioning and recovery paths create containers with a derived per-instance API key and a configured runtime, verify readiness with an authenticated request, and bring the test fixture, tests and docs in line with the official Hermes image contract.

**Architecture:** A pure `deriveApiKey()` (HMAC of a master secret and the instance id) feeds `InstanceService` and `Reconciler`, which pass `apiServerKey` and the container runtime to `RuntimeManager.ensure()` and the key to every health probe. `checkHealth()` becomes strict when a key is supplied. The stub image is reworked to the official contract so integration tests exercise the same capability and rootfs constraints as the real image.

**Tech Stack:** Node >=22, TypeScript, Fastify 5, Zod 4, Prisma 6.19 + PostgreSQL 16, dockerode 5, Vitest 3.2, pnpm 10.28.

**Spec:** `docs/superpowers/specs/2026-11-12-hardening-wiring-design.md`

## Global Constraints

- No git commit, stash, reset, clean or repo move without Nash's explicit instruction. Every "Commit" step below runs **only** after Nash says to commit; until then leave changes in the working tree.
- Preserve existing uncommitted work: `design-preview.html`, `DESIGN.md`, `docs/HANDOFF_TO_CLAUDE.md`, and the edits in `docs/CURRENT_STATE.md` and `docs/SESSION_HANDOFF.md`.
- `HERMES_MASTER_KEY`: required, at least 32 characters, never logged, stored or echoed. `HERMES_RUNTIME`: `runc | runsc`, default `runc`.
- API key = hex `HMAC-SHA256(HERMES_MASTER_KEY, "hermes-cloud/api-server-key/v1:" + lower-cased instance UUID)`. No DB column, no migration.
- Official contract values: port `8642`, data mount `/opt/data`, container user not pinned (s6 drops to uid `10000`), `CapDrop ['ALL']` plus `SETUID SETGID CHOWN DAC_OVERRIDE FOWNER KILL AUDIT_WRITE SETFCAP`, read-only rootfs with tmpfs `/run`, `/tmp`, `/var/run`.
- Pinned official image: `nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08` (v0.23.1).
- Readiness: with a key, only HTTP 200 is ok and 401 is "auth rejected"; without a key, 200 or 401 stays "alive".
- No credentials, API keys or personal data in repo files. Docs use relative paths and never hardcode the repo location.
- No dashboard or frontend work. Out of scope: disk quota, egress/SSRF, secrets manager, key rotation, gVisor escape tests, per-plan runtime.
- Tests that need Docker or Postgres cannot run in the authoring environment. Nothing may be reported as passing until Task 10 is run on a Docker and Postgres host.

## Review Focus

- A master key of 31 characters is rejected and 32 is accepted; the error names `HERMES_MASTER_KEY` and never the value (Task 1).
- The same instance id in upper and lower case derives the same key, and two instances never share one (Task 2).
- A health probe with the wrong key reports not ok instead of alive (Task 3).
- A container recreated by the reconciler after a crash gets the same key as before, and neither the key nor the master secret appears in an instance view, event or log line (Task 4).
- `HERMES_RUNTIME=runsc` on a daemon without `runsc` fails startup with a clear message, and `runc` never needs the check (Task 5).

---

### Task 1: Config accepts the master key and runtime

**Files:**
- Modify: `src/config/env.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Produces: `Config.masterKey: string`, `Config.runtime: SupportedRuntime` (type from `src/modules/runtime/types.ts`).

- [ ] **Step 1: Write failing tests** in `test/unit/config.test.ts`. Add `HERMES_MASTER_KEY: 'k'.repeat(32)` to `base` and to the missing-key `it.each` list. New tests: `rejects a 31 character HERMES_MASTER_KEY and accepts 32`; `does not echo HERMES_MASTER_KEY in errors` (error contains the key name, not the value); `defaults HERMES_RUNTIME to runc and accepts runsc`; `rejects an unknown HERMES_RUNTIME` (`'kata'` throws, message contains `HERMES_RUNTIME`).
- [ ] **Step 2: Run** `pnpm vitest run test/unit/config.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** in `src/config/env.ts`: schema keys `HERMES_MASTER_KEY: z.string().min(32)` and `HERMES_RUNTIME: z.enum(['runc','runsc']).default('runc')`; extend `Config` and the returned object with `masterKey` and `runtime`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** (only on Nash's go-ahead): `feat(config): require HERMES_MASTER_KEY, add HERMES_RUNTIME`.

### Task 2: Per-instance key derivation

**Files:**
- Create: `src/modules/runtime/api-key.ts`
- Test: `test/unit/api-key.test.ts`

**Interfaces:**
- Produces: `deriveApiKey(masterKey: string, instanceId: string): string` (64 hex characters; throws `ValidationError('Invalid instance id')` for a non-UUID, using the existing UUID rule from `hardening.ts`).

- [ ] **Step 1: Write failing tests** in `test/unit/api-key.test.ts`: `is deterministic for the same master key and instance`; `differs per instance`; `differs per master key`; `is 64 lowercase hex characters`; `treats upper and lower case ids as the same instance`; `rejects a non-UUID instance id`; `matches a known vector` (compute `createHmac('sha256', master).update('hermes-cloud/api-server-key/v1:' + id).digest('hex')` in the test itself as the expected value).
- [ ] **Step 2: Run** `pnpm vitest run test/unit/api-key.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `deriveApiKey` with `node:crypto` `createHmac`. Export the label as `API_KEY_LABEL = 'hermes-cloud/api-server-key/v1:'`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** (only on go-ahead): `feat(runtime): derive per-instance API server keys`.

### Task 3: Strict readiness when a key is supplied

**Files:**
- Modify: `src/modules/runtime/docker-runtime-manager.ts` (`checkHealth`)
- Test: `test/unit/runtime-health.test.ts` (new)

**Interfaces:**
- Consumes: existing `DockerRuntimeManager` constructor option `docker` and `RuntimeManager.checkHealth(instanceId, apiServerKey?)`.

- [ ] **Step 1: Write failing tests** in `test/unit/runtime-health.test.ts` using a fake docker object whose `getContainer(...).inspect()` returns a running container with `NetworkSettings.Ports['8642/tcp'][0].HostPort = '49152'` and whose `getVolume(...).inspect()` resolves, plus `vi.stubGlobal('fetch', ...)`. Cases: `key supplied and 200 is ok`; `key supplied and 401 is not ok with detail "auth rejected"`; `no key and 401 is still ok`; `no key and 200 is ok`; `sends the Bearer header when a key is supplied`; `not running returns ok false without calling fetch`.
- [ ] **Step 2: Run** `pnpm vitest run test/unit/runtime-health.test.ts`. Expected: the 401-with-key case FAILS.
- [ ] **Step 3: Implement** the branch in `checkHealth`: if `apiServerKey` is set, `ok = status === 200` and `detail = status === 401 ? 'auth rejected' : \`HTTP ${status}\``; otherwise keep `200 || 401`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** (only on go-ahead): `fix(runtime): require authenticated 200 when a key is supplied`.

### Task 4: Wire key and runtime into InstanceService and Reconciler

**Files:**
- Modify: `src/modules/instances/instance-service.ts`, `src/modules/instances/reconciler.ts`, `test/helpers/service-env.ts`
- Test: `test/integration/instance-service.test.ts`, `test/integration/recovery.test.ts`

**Interfaces:**
- Consumes: `deriveApiKey` (Task 2), `SupportedRuntime`.
- Produces: `InstanceServiceDeps.masterKey: string`, `InstanceServiceDeps.containerRuntime?: SupportedRuntime`; `ReconcilerDeps.masterKey: string`, `ReconcilerDeps.containerRuntime?: SupportedRuntime`. (`runtime` stays the `RuntimeManager`; the container runtime is deliberately named `containerRuntime` to avoid the clash.)

- [ ] **Step 1: Fix the test helper.** In `test/helpers/service-env.ts`, `wrapRuntime.checkHealth` must forward the key: `(i, k) => inner.checkHealth(i, k)`. Add `export const TEST_MASTER_KEY = 'test-master-key-'.padEnd(32, 'x')`.
- [ ] **Step 2: Write failing integration tests.** Every `new InstanceService(...)` and `new Reconciler(...)` in `test/integration/*.test.ts` (api, instance-service, lease, recovery) gets `masterKey: TEST_MASTER_KEY`. In `instance-service.test.ts` add: `passes a derived API key and the configured runtime to ensure` (spy via `wrapRuntime`, expect `spec.apiServerKey === deriveApiKey(TEST_MASTER_KEY, id)` and `spec.runtime === 'runc'`); `probes readiness with the derived key`; `fails provisioning with health_check_timeout when the key does not match` (service built with a different master key than the one the container was created with is not needed: wrap `checkHealth` to return `{ok:false, detail:'auth rejected'}` and expect status `FAILED`, reason `health_check_timeout`); `never exposes the key in the view, events or logs` (JSON of `get` and `events` and captured log lines contain neither the derived key nor `TEST_MASTER_KEY`). In `recovery.test.ts` add: `recreates a missing container with the same key` (capture `ensure` spec before and after removing the container; both `apiServerKey` equal).
- [ ] **Step 3: Run** `pnpm vitest run test/integration/instance-service.test.ts test/integration/recovery.test.ts`. Expected (on a Docker and Postgres host): new tests FAIL.
- [ ] **Step 4: Implement.** Add the two deps and store them. In `provisionSteps` and `recoverSteps` pass `apiServerKey: deriveApiKey(masterKey, inst.id)` and `runtime: containerRuntime` to `ensure()`. In `InstanceService.waitHealthy`, `Reconciler.onRunning` and `Reconciler.waitHealthy`, pass the derived key to `checkHealth`. A private helper `apiKey(instanceId)` in each class keeps the call sites short. The key is never put in `env`, events, log fields or errors.
- [ ] **Step 5: Run** `pnpm tsc --noEmit` (expected: clean) and the Step 3 command (expected: PASS on a Docker and Postgres host).
- [ ] **Step 6: Commit** (only on go-ahead): `feat(instances): pass derived API key and runtime to the runtime manager`.

### Task 5: Startup wiring and runtime availability check

**Files:**
- Create: `src/modules/runtime/runtime-availability.ts`
- Modify: `src/main.ts`
- Test: `test/unit/runtime-availability.test.ts`

**Interfaces:**
- Produces: `assertRuntimeAvailable(docker: { info(): Promise<{ Runtimes?: Record<string, unknown> }> }, runtime: SupportedRuntime): Promise<void>`. Resolves immediately for `'runc'` without calling `info()`. For `'runsc'` it throws `Error('Docker runtime "runsc" is not available on this host')` when `Runtimes` lacks it.

- [ ] **Step 1: Write failing tests**: `runc never calls info`; `runsc passes when listed`; `runsc fails with the exact message when missing`; `runsc fails when Runtimes is undefined`.
- [ ] **Step 2: Run** `pnpm vitest run test/unit/runtime-availability.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the function, then in `src/main.ts` create the `Docker` client once, `await assertRuntimeAvailable(docker, config.runtime)` before building services, and pass `masterKey: config.masterKey` and `containerRuntime: config.runtime` to both `InstanceService` and `Reconciler`.
- [ ] **Step 4: Run** the unit test (expected: PASS) and `pnpm tsc --noEmit` (expected: clean).
- [ ] **Step 5: Commit** (only on go-ahead): `feat(startup): wire master key and runtime, fail fast on missing runsc`.

### Task 6: Stub image follows the official contract

**Files:**
- Modify: `test/fixtures/hermes-stub/Dockerfile`, `entrypoint.sh`, `handler.sh`, `test/helpers/stub-image.ts`

**Interfaces:**
- Produces: image `hermes-stub:0.2.0` (the tag changes so a cached `0.1.0` is never reused). `STUB_IMAGE` in `stub-image.ts` is `'hermes-stub:0.2.0'`.

- [ ] **Step 1: Define the behavior** (this is the stub's test: Task 7's integration tests and Task 10 exercise it). Port from `API_SERVER_PORT` (default `8642`) bound per `API_SERVER_HOST` (default `0.0.0.0`). `GET /api/sessions` returns 200 when `Authorization: Bearer $API_SERVER_KEY` matches and 401 otherwise; with `API_SERVER_KEY` unset it returns 401 for everything (fail closed; this is an assumption about the real image, flagged in the evidence doc). `GET /state` and `POST /crash` keep working, authenticated the same way. Boot counter moves to `/opt/data/boots`.
- [ ] **Step 2: Update `Dockerfile`**: base image digest unchanged; create group and user `hermes` with uid/gid `10000` and home `/opt/data`; `mkdir /opt/data` owned by the image's root so the entrypoint must chown it; `apk add --no-cache su-exec` (if the package is unavailable, use another tool that needs SETUID and SETGID, and record the choice in the evidence doc); **no `USER` line**; `EXPOSE 8642`; `CMD ["gateway","run"]` ignored by the entrypoint so the harness command matches the real image.
- [ ] **Step 3: Update `entrypoint.sh`**: start as root, `chown 10000:10000 /opt/data`, then `exec su-exec 10000:10000` into the server script, so the stub fails with the same symptoms as the real image if `SETUID`, `SETGID` or `CHOWN` are missing. Update `handler.sh` for the new path, the header read (consume headers until the blank line, extract `Authorization`) and the Bearer check.
- [ ] **Step 4: Build and smoke test** on a Docker host: `docker build -t hermes-stub:0.2.0 test/fixtures/hermes-stub`, then run it with the exact hardened settings (`--read-only`, `--cap-drop ALL` plus the eight `--cap-add`, the three `--tmpfs`, `-e API_SERVER_KEY=k`). Expected: `curl -H 'Authorization: Bearer k' :PORT/api/sessions` returns 200, without the header 401. Run again with `--cap-drop ALL` and no `--cap-add`: expected the container exits non-zero.
- [ ] **Step 5: Commit** (only on go-ahead): `test(fixtures): rework stub to the official image contract`.

### Task 7: Update integration tests to the official contract

**Files:**
- Modify: `test/integration/isolation.test.ts`, `persistence.test.ts`, `instance-service.test.ts`, `recovery.test.ts`, `runtime-manager.test.ts`, `api.test.ts`

**Interfaces:**
- Consumes: stub `hermes-stub:0.2.0` (Task 6), `TEST_MASTER_KEY` (Task 4).

- [ ] **Step 1: Apply these replacements wherever they appear** (find them with `grep -rn "healthz\|8080\|10001\|'/data\|/data/" test/integration`): uid `10001` becomes `10000` for the running process (`id -u`); `Config.User` is no longer asserted equal to `10001:10001`, assert it is empty or unset instead; mount destination and in-container paths `/data` become `/opt/data`; peer URLs `:8080/healthz` become `:8642/api/sessions` with the Bearer header; host-side readiness fetches of `${accessUrl}/healthz` become `${accessUrl}/api/sessions` with `Authorization: Bearer ${deriveApiKey(TEST_MASTER_KEY, id)}`. Direct `manager.ensure(...)` calls pass an `apiServerKey`.
- [ ] **Step 2: Add two assertions** to `isolation.test.ts`: on the created container, `HostConfig.CapAdd` equals `S6_REQUIRED_CAPS` (import from `hardening.ts`) and `HostConfig.ReadonlyRootfs === true`.
- [ ] **Step 3: Run** `pnpm test:integration` on a Docker and Postgres host. Expected: all PASS. Any failure caused by the stub rather than the code is fixed in Task 6, not by loosening the test.
- [ ] **Step 4: Commit** (only on go-ahead): `test(integration): assert the official image contract`.

### Task 8: Architecture, setup and env docs

**Files:**
- Modify: `docs/architecture.md`, `docs/setup.md`, `.env.example`

- [ ] **Step 1: `docs/architecture.md`.** Replace "Image contract" with the official contract values from Global Constraints plus: API key derivation, key baked at creation (rotation requires recreate), `HERMES_RUNTIME`, strict readiness. Update the "Runtime hardening" table rows (user, read-only rootfs, capabilities, data mount) and their "Verified by" column to the real files/harness. Narrow known gap 4 to: validated in the live harness against the pinned image, not on production hosts, kernel or with a real model backend.
- [ ] **Step 2: `.env.example`.** Add `HERMES_MASTER_KEY=` with a comment `# >= 32 chars. Generate with: openssl rand -hex 32` and `HERMES_RUNTIME=runc`. Change `HERMES_IMAGE` to `hermes-stub:0.2.0` for local development with a comment pointing at the pinned official digest for real runs.
- [ ] **Step 3: `docs/setup.md`.** Add both variables to the env table, update the stub tag, and replace the "Not yet validated" paragraph with a pointer to `docs/milestone-2-runtime-security.md`.
- [ ] **Step 4: Verify.** `grep -n "8080\|10001\|/data\b" docs/architecture.md docs/setup.md` returns nothing stale; every file path and variable named in the docs exists in the repo.
- [ ] **Step 5: Commit** (only on go-ahead): `docs: describe the official image contract, key and runtime wiring`.

### Task 9: Milestone 2.2 evidence doc and continuity docs

**Files:**
- Create: `docs/milestone-2-runtime-security.md`
- Modify: `docs/CURRENT_STATE.md`, `docs/SESSION_HANDOFF.md`

- [ ] **Step 1: Gather sources.** Read `git show 7b17cda 67b50f3 760f361`, the comments in `src/modules/runtime/hardening.ts`, `docs/adr/0002-hardened-container-baseline.md`, `docs/HANDOFF_TO_CLAUDE.md` and `docs/CURRENT_STATE.md`.
- [ ] **Step 2: Write the doc** with: purpose and provenance banner ("reconstructed 2026-11-12; every result is reported, not re-run"); one section per WS1–WS5 stating what was tested, the reported result and its source commit or file; the s6 capability finding (drop-all exit-loop symptoms, the eight caps, the tmpfs set); the WS4 benchmark bug and the corrected WS4b figures if recoverable; the 25-check live harness list; an "Unrecoverable" list for anything not found in the sources (do not invent); and an empty **Verification run** section with fields for date, host, kernel and cgroup version, image digest, command, and pasted output. The doc states it is incomplete until that section is filled.
- [ ] **Step 3: Update continuity docs** per `AGENTS.md`: record this work, the new variables, the stub tag change, and the open verification run.
- [ ] **Step 4: Verify.** Every commit hash, file path and number in the doc appears in the sources; `grep -n "TBD\|TODO"` returns nothing.
- [ ] **Step 5: Commit** (only on go-ahead): `docs: reconstruct Milestone 2.2 runtime security evidence`.

### Task 10: Verification on a Docker and Postgres host

**Files:**
- Modify: `docs/milestone-2-runtime-security.md` (Verification run section)

- [ ] **Step 1: Install and static checks** on the host: `pnpm install --frozen-lockfile`, `pnpm tsc --noEmit`, `pnpm vitest run test/unit`. Expected: clean typecheck, all unit tests PASS.
- [ ] **Step 2: Integration:** `pnpm test:integration`. Expected: all PASS; record counts.
- [ ] **Step 3: Live harness** against the pinned official image on runc and runsc: `pnpm tsx test/validation/runtime-manager-live.ts` (with `HERMES_IMAGE` unset, and with a runsc-enabled daemon for the second run). Expected: `RESULT: ALL CHECKS PASSED`, 25 checks per runtime.
- [ ] **Step 4: Record** the output, date, host details and image digest in the Verification run section, and update the "reported, not re-run" tags to "verified <date>" only for results this run actually reproduced. Report any failure as it is; do not edit tests to make it pass.
- [ ] **Step 5: Commit** (only on go-ahead): `docs: record Milestone 2.2 verification run`.
