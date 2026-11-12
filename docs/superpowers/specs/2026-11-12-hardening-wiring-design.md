# Wire the hardening baseline into provisioning, and reconstruct the Milestone 2.2 evidence

Date: 2026-11-12
Status: draft for review (not approved, nothing implemented, nothing committed)
Branch context: `feat/official-image-compatibility`

## 1. Problem

The hardened container baseline (capability drop plus the eight s6 capabilities, read-only rootfs,
tmpfs mounts, no-new-privileges) is already applied by `DockerRuntimeManager.ensure()` through
`buildContainerConfig()`. It was validated only by the live harness
(`test/validation/runtime-manager-live.ts`, reported 25/25 on runc and runsc). The production
provisioning path does not use the rest of the official-image contract:

1. **No API key.** `InstanceService.provisionSteps` and `Reconciler` call `runtime.ensure()` without
   `apiServerKey`. Real containers would start without `API_SERVER_KEY`. The key is not generated,
   derived or stored anywhere.
2. **Weak readiness.** `waitHealthy()` calls `checkHealth()` without a key, and a 401 counts as
   healthy. Provisioning cannot tell "gateway alive" from "gateway alive and the key works".
3. **No runtime selection.** `RuntimeSpec.runtime` is never set outside the harness, so gVisor
   (`runsc`) cannot be selected in production.
4. **Stale tests and fixture.** Commit `7b17cda` moved the runtime to port 8642, `/opt/data`, s6 with
   uid 10000 and an authenticated `/api/sessions` health check. `test/integration/isolation.test.ts`,
   `instance-service.test.ts` and `persistence.test.ts`, plus `test/fixtures/hermes-stub`, still assume
   uid 10001, `/data`, port 8080 and `/healthz`. The Milestone 1 claim of 131 passing tests predates
   that commit and has not been re-verified.
5. **Stale docs.** The "Image contract" section and hardening table in `docs/architecture.md`
   describe the stub. `.env.example` pins `hermes-stub:0.1.0`.
   `docs/milestone-2-runtime-security.md` is referenced by the continuity docs but never existed.

## 2. Goals and non-goals

Goals
- The real provisioning and recovery paths create containers with a per-instance API key and a
  configured runtime, and verify readiness with an authenticated request.
- The test fixture and integration tests describe the official-image contract.
- The docs match the code, and the Milestone 2.2 evidence is recorded with honest provenance.

Non-goals (unchanged open gaps): disk quota, egress/SSRF controls, a secrets manager, key rotation,
gVisor escape testing, per-plan runtime selection, multi-node, queueing, any dashboard or frontend work.
No git commits and no repository move are part of this spec.

## 3. Decisions (made with the project owner on 2026-11-12)

| Topic | Decision |
| --- | --- |
| API key | Derived, not stored: `HMAC-SHA256(HERMES_MASTER_KEY, label ‖ instanceId)`, hex. No DB column, no migration. |
| Runtime | One global `HERMES_RUNTIME` env (`runc` default, or `runsc`). |
| Evidence doc | Reconstruct now from repo evidence, every result tagged "reported, not re-run", with an empty "Verification run" section to fill later. |
| Scope | Approach A: wire, rework the stub to the official contract, update tests and docs. |

## 4. Design

### 4.1 Config (`src/config/env.ts`)
- `HERMES_MASTER_KEY`: required, at least 32 characters. Never logged or echoed. Error messages name the key only.
- `HERMES_RUNTIME`: `runc | runsc`, default `runc`.
- `Config` gains `masterKey` and `runtime`.
- Startup with `runsc` checks `docker.info()` for the runtime and fails fast if it is missing.

### 4.2 Key derivation (`src/modules/runtime/api-key.ts`, new)
- `deriveApiKey(masterKey: string, instanceId: string): string` returns hex HMAC-SHA256 over
  `hermes-cloud/api-server-key/v1:` plus the lower-cased instance UUID. Pure, validates the UUID.
- The label carries a version so a future scheme can coexist.
- Limitation: the key is baked into the container env at creation. Rotating `HERMES_MASTER_KEY` makes
  existing containers reject the derived key until they are recreated. Documented, not solved here.

### 4.3 Wiring
- `InstanceServiceDeps` and `Reconciler` deps gain `masterKey` and `runtime` (`SupportedRuntime`).
- Every `ensure()` passes `apiServerKey: deriveApiKey(...)` and `runtime`.
- Every health probe (`waitHealthy`, reconciler probe) passes the key.
- The key never goes into the database, events, logs or API responses.
- `src/main.ts` builds both from `Config`.

### 4.4 Readiness (`DockerRuntimeManager.checkHealth`)
- Key supplied: ok only on HTTP 200. 401 returns `ok:false` with detail "auth rejected".
- No key: unchanged (200 or 401 means alive). The live harness is unaffected.
- The reconciler therefore marks an instance degraded when the key stops matching, instead of reporting it healthy.

### 4.5 Stub fixture (`test/fixtures/hermes-stub`)
A stand-in that fails the way the real image fails:
- Listens on `API_SERVER_HOST:API_SERVER_PORT` (default 8642). `GET /api/sessions` returns 200 with a
  matching `Authorization: Bearer <API_SERVER_KEY>`, otherwise 401.
- Data lives in `/opt/data`. The entrypoint starts as root, chowns `/opt/data` and drops to uid 10000
  with `su-exec`, so it needs SETUID, SETGID and CHOWN like the s6 init does. It must boot under
  `CapDrop ALL` plus the eight caps, with a read-only rootfs and the three tmpfs mounts.
- Not pinned to a user in the image config, matching the official image.

### 4.6 Tests
- Unit: `deriveApiKey` (determinism, per-instance uniqueness, key length, UUID validation);
  config (`HERMES_MASTER_KEY` missing or short, `HERMES_RUNTIME` values); `checkHealth` branches;
  `hardening.test.ts` stays as the config-shape check.
- Integration (need Docker and Postgres): update `isolation`, `persistence` and `instance-service`
  tests to uid 10000, `/opt/data`, port 8642 and authenticated health; add checks that the container
  env contains a derived key that differs per instance, that the reconciler recreates a missing
  container with the same key, and that a wrong key fails readiness.
- Verification: none of this can run in the authoring environment. The implementation plan ends with a
  verification task run on a Docker and Postgres host. No pass is claimed before then.

### 4.7 Docs
- `docs/architecture.md`: rewrite "Image contract" (8642, `/opt/data`, s6 uid 10000 plus eight caps,
  read-only rootfs plus tmpfs, key and runtime handling) and the hardening table. Narrow known gap 4:
  the real image was validated in the harness, but not on production hosts or with a real model backend.
- `.env.example` and `docs/setup.md`: new variables, pinned official image digest
  (`nousresearch/hermes-agent@sha256:276d4468…bda08`, v0.23.1) as the example.
- New `docs/milestone-2-runtime-security.md`: sections for WS1–WS5, built from commits `7b17cda`,
  `67b50f3` and `760f361`, code comments in `hardening.ts`, ADR 0002 and the handoff docs. Each result
  is tagged "reported, not re-run". The buggy WS4 benchmark and the corrected WS4b are both described.
  Where what WS1–WS3 tested cannot be recovered, the doc says so. An empty "Verification run" section
  holds the output of a harness re-run. The doc is not marked complete until it is filled.
- Update `docs/CURRENT_STATE.md` and `docs/SESSION_HANDOFF.md` per the AGENTS.md continuity protocol.
- No credential, key or personal data in any file. Paths in docs are relative; the repo location is not hardcoded.

## 5. Risks and open points

- **Unverified baseline.** Test counts and the 25/25 harness result are prior claims. Mitigation: the
  evidence doc labels them as such, and the plan ends with a verification run on a Docker node.
- **Master key rotation** invalidates every running instance's key. Accepted for now; documented.
- **Stub fidelity.** The stub approximates, not replaces, the official image. The live harness against
  the pinned image stays the source of truth for contract changes.
- **Image digest drift.** Production still requires an `@sha256` digest via `assertPinnedImage`.

## 6. Acceptance criteria

1. `ensure()` is only called with a derived `apiServerKey` and the configured `runtime`; no code path omits them.
2. Provisioning reaches ACTIVE only after an authenticated 200 from the instance.
3. Config rejects a missing or short `HERMES_MASTER_KEY` and an unknown `HERMES_RUNTIME`.
4. The stub boots only with the s6 capability set and a read-only rootfs plus tmpfs.
5. Integration tests assert the official contract and no longer reference uid 10001, `/data` or 8080.
6. `docs/architecture.md`, `.env.example`, `docs/setup.md` and `docs/milestone-2-runtime-security.md`
   match the code and mark unverified results as such.
7. The verification task has been run on a Docker and Postgres host and its output recorded, or the
   work is explicitly reported as unverified.
