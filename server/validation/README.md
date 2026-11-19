# validation/ — live harnesses

Programs that check the Go backend against real infrastructure. They are not part of `go test`: run them by hand where the
infrastructure is, and read every line (a SKIP is never a pass).

| Harness | What it proves | Run |
| --- | --- | --- |
| `runtimelive` | The runtime manager against a real Docker daemon and the official Hermes image: ensure, authenticated readiness, stop/start recovery, the hardening on the live container, cleanup. With `HERMES_CANARY_IMAGE` also runsc DNS. | `go run ./validation/runtimelive` with the Docker socket and loopback access to published ports |

Port of `test/validation/runtime-manager-live.ts`. The egress checks (`test/validation/egress-checks.ts`) follow in M7.

Last run (2026-11-19, Docker Desktop, runc, the pinned official image): 21 PASS, 0 FAIL, 2 SKIP (runsc DNS: no
`HERMES_CANARY_IMAGE`; egress: policy off). runsc, the XFS quota and the host egress rules are checked on the VPS at M8.
