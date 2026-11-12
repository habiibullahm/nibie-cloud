# Milestone 2.2: runtime security evidence

**Status: reconstructed, partly re-verified. Not complete.**

This document did not exist before 2026-11-12. The original Workstream 1-5 (WS1-WS5) logs were never
committed and are not in the repository, so most of what follows is rebuilt from commit messages,
code comments, the architecture docs and the continuity docs. Every result carries one of these tags:

| Tag | Meaning |
| --- | --- |
| **reported, not re-run** | Taken from the sources below. Nobody has reproduced it since the continuity docs were written. |
| **re-run 2026-11-12 (sandbox, runc)** | Reproduced on the host described under [Verification run](#verification-run). |

Nothing here is a production-readiness claim. Disk quota, egress controls, gVisor escape testing and
secrets management are still open (see [architecture.md](architecture.md#known-gaps-and-deferred-security-work)).

Sources: commits `7b17cda`, `67b50f3` and `760f361`; the comments in
`src/modules/runtime/hardening.ts`; [ADR 0002](adr/0002-hardened-container-baseline.md);
`docs/CURRENT_STATE.md`, `docs/SESSION_HANDOFF.md` and `docs/HANDOFF_TO_CLAUDE.md`;
`test/validation/runtime-manager-live.ts`.

## Target image

`nousresearch/hermes-agent@sha256:276d44685c65c0cb2a25f190b63c65c8906f9dc76486fb1c05ae71b5826bda08`
(Hermes v0.23.1). Contract: port 8642, data in `/opt/data`, s6-overlay init that starts as root and
drops to `hermes` (10000:10000), authenticated API under `API_SERVER_KEY`.

## Findings by workstream

### Canary matrix: capabilities and read-only rootfs (workstream number not recoverable)

The hardening code records a canary matrix run on the `nibie-cloud` host.

- `CapDrop: ['ALL']` with nothing re-added makes cont-init die and the container exit-loop with
  `s6-applyuidgid: fatal: unable to set supplementary group list: Operation not permitted` and
  `chown: changing ownership of '/run/hermes-service': Operation not permitted`. **reported, not re-run**
- Re-adding exactly `SETUID SETGID CHOWN DAC_OVERRIDE FOWNER KILL AUDIT_WRITE SETFCAP` lets the gateway
  reach ACTIVE with authenticated HTTP 200; removing any of SETUID, SETGID, CHOWN, DAC_OVERRIDE or FOWNER
  breaks boot. **reported, not re-run** (the positive case, the eight caps booting the real image, was
  **re-run 2026-11-12 (sandbox, runc)**; the removal cases were not).
- A read-only rootfs without tmpfs at `/run` and `/var/run` fails with
  `s6-rmrf: fatal: unable to remove /run/s6: Read-only file system`. With `/run`, `/tmp` (`noexec`) and
  `/var/run` as tmpfs the image boots under `ReadonlyRootfs: true`. **reported, not re-run** (the passing
  configuration was **re-run 2026-11-12 (sandbox, runc)**).
- `API_SERVER_HOST=0.0.0.0` must be injected, otherwise the gateway binds inside the container where
  Docker's loopback port publish cannot reach it (commit `67b50f3`). **reported, not re-run**

### WS1, WS2, WS3

What these workstreams tested is **not recoverable** from the repository or the continuity docs. They
are not described here rather than guessed. If the original session records exist, they should be
added to this section.

### WS4 and WS4b: gVisor performance benchmarks

- The continuity docs record gVisor egress-performance and database-benchmark evidence as partial: one
  WS4 benchmark had a Python 3 harness bug, and a corrected WS4b run was done. **reported, not re-run**
- **The consolidated benchmark numbers are not recoverable** and are not stated here.
- `runsc` is reported compatible with the image and selectable (`HERMES_RUNTIME=runsc`). It stays
  non-default: `runc` is the default. **reported, not re-run**

### WS5: live RuntimeManager acceptance harness

`test/validation/runtime-manager-live.ts` (commit `760f361`) runs the real `DockerRuntimeManager`
against a real daemon and the pinned official image, with no stubs. Reported result: 25 checks pass on
runc and 25 on runsc. **reported, not re-run** for runsc.

Re-run 2026-11-12 on runc: the 21 checks before the runsc step pass. The run then stopped at the first
runsc `ensure()` (Docker status 400) because gVisor is not installed on the sandbox. The two runsc checks
and the two teardown checks that follow them did not run. See [Verification run](#verification-run).

Two of the 25 checks cannot fail, so the real count is lower than 25:

- `checkHealth() reports not-ok for a stopped instance after stop()` passes the literal `true`. The
  following check does cover a stopped instance.
- `unauthenticated request never returns session data` returns `false` whether the request resolves or
  rejects, so it always passes. No harness check fails if the gateway serves requests without a key: the `checkHealth()` check
  without a key passes on 200 or 401. The 2026-11-12 runc log shows `HTTP 401` in that check's detail,
  so that run did see the gateway enforce auth.

## What the control plane does with this (2026-11-12)

The baseline above is applied by `buildContainerConfig()` on every `ensure()`. As of this change the
provisioning and recovery paths also pass a derived per-instance `API_SERVER_KEY` and the configured
runtime, and readiness requires an authenticated 200. See
[the design](superpowers/specs/2026-11-12-hardening-wiring-design.md).

## Assumptions that are not verified

- The Bearer-protected `hermes-stub:0.2.0` returns 401 for everything when `API_SERVER_KEY` is unset.
  What the official image does with no key was not checked.
- Memory and PID limits were exercised on cgroup v1 only (the dev sandbox and the verification host).
  Re-verify on the production kernel and cgroup v2.

## Verification run

Results of the re-run described above. Each result is tagged; anything missing is listed under
"Not verified".

| Field | Value |
| --- | --- |
| Date | 2026-11-12 |
| Host | cloud sandbox, Linux 6.18.44 |
| Docker | Server 29.9.2, cgroup v1, overlayfs; runtimes: runc only |
| Image | the pinned digest above, pulled from Docker Hub |
| Postgres | 16 (local) |

| Check | Result |
| --- | --- |
| Unit tests (`pnpm vitest run test/unit`) | 89 of 89 passed |
| Integration suite with a real Docker daemon and Postgres (`pnpm vitest run test/integration`) | 101 of 101 passed. It runs against the stub, not the official image. |
| Live harness, runc, official image (`pnpm tsx test/validation/runtime-manager-live.ts`) | 21 of 21 executed checks passed. Log: `verification/live-harness-runc-2026-11-12.log` in the project files. |
| End to end through `InstanceService` and `Reconciler` on the official image, runc | Provisioning reached ACTIVE using the strict readiness check. `GET /api/sessions` returned 200 with the derived key and 401 without it. After removing the container, the Reconciler recreated it and the same derived key was still accepted. This was a one-off script, not a committed test. |

Not verified: runsc/gVisor (not installed here, so 4 harness checks did not run); a cgroup v2 or
production host; the capability-removal failure cases on the official image; WS1-WS4 contents;
behaviour under a real model backend.

To complete this document, re-run the harness on a host with gVisor and record the date, host,
kernel, cgroup version, image digest and output in a second row set here.
