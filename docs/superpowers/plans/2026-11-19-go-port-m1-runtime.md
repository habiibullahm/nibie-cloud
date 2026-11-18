# Go port M1 (Docker runtime) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (default) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `src/modules/runtime` to Go: the only code that talks to Docker. It creates, starts, inspects and removes tenant containers with the exact hardening the Node backend uses, and runs the startup checks (OCI runtime, disk quota, egress canary, DNS for runsc).

**Architecture:** A `runtime.Manager` interface (same operations as the Node `RuntimeManager`) implemented on the official Docker Engine Go SDK. Every Docker request body the Node code builds is recorded as a golden fixture by a TypeScript generator that runs the Node functions. Go must produce the same request (rule in Task 2). Pure parts are unit-tested against those goldens. The Docker-facing parts run against a real daemon with the `test/fixtures/hermes-stub` image, and once against the official Hermes image (live harness).

**Tech Stack:** Go 1.27.4, Docker Engine Go SDK (`github.com/docker/docker/client`), `goccy/go-yaml`, the M0 packages (`internal/config`, `internal/shared/logger`, `internal/http`).

**Spec:** [docs/superpowers/specs/2026-11-19-backend-go-port-design.md](../specs/2026-11-19-backend-go-port-design.md), M1 row of section 6, Layer 2 of section 4. M0 plan: [2026-11-19-go-port-m0-foundation.md](2026-11-19-go-port-m0-foundation.md).

## Global Constraints

- Branch `claude/go-port-m1` in worktree `../nibie-cloud-go-m1`, stacked on `claude/go-port-m0` (PR #71). If #71 merges first, merge `origin/main` in; never rebase or force-push.
- Commit per task: allowed locally. Push and PR only on the owner's words. No `Co-Authored-By` trailer.
- **Production is never touched.** No change under `src`, `prisma`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json` or `deploy` (the paths `ops/host/hermes-auto-deploy.sh` watches). `src/` is only read.
- Docker resource names derive from instance UUIDs only: `hermes-<id>`, `hermes-data-<id>`, `hermes-net-<id>`, bridge `hn<first 12 hex of the id>`. Ids are lowercased. Customer text never reaches a Docker name.
- Never forward Docker error text: it can hold env values and host paths. Errors carry a status code or a fixed reason only.
- The Docker socket is never mounted into a tenant container.
- Hardening values are copied from `src/modules/runtime/hardening.ts`, not re-derived: the eight capabilities, the three tmpfs mounts, read-only root fs, `no-new-privileges`, `Init: false`, `RestartPolicy: no`, the log limits, port `8642` on `127.0.0.1` with a random host port, and `Cmd ["gateway","run"]`.
- Docker SDK: use `github.com/docker/docker/client`. If that module path is deprecated in favour of `github.com/moby/moby/client` when the task runs, use the new path (same API) and record it as a ruling.
- Docker integration tests: `//go:build integration` plus `-p 1`, a reachable daemon (`DOCKER_HOST` or `/var/run/docker.sock`), and loopback that reaches published ports. On this workstation, run them in the pinned Go image with `--network host -v /var/run/docker.sock:/var/run/docker.sock`. Docker Desktop's VM then provides both the daemon's loopback and Postgres on `127.0.0.1:5433`.
- Every resource a test creates carries the label `hermes.cloud/managed=true` and a fresh UUID, and is removed in `t.Cleanup`, also on failure.
- TEST-MAP: each TS test case ported in this milestone gets its Go test name and `ported`/`golden`. Moved rows get the new milestone.

## Review Focus

1. **A Docker daemon that is down or answers slowly mid-operation.** Every `Manager` method must return the typed runtime-unavailable error (HTTP 503 `runtime_unavailable`), never hang past its context, and never leak daemon text. Pinned in Task 5.
2. **Two concurrent `Ensure` calls for one instance** (a user start racing the reconciler). One container, one network and one volume result, and neither call fails. Node handles 409 on create for both container and network. Pinned in Task 5.
3. **A tenant `config.yaml` that is huge, not YAML, not a map, or holds the customer's own comments and keys.** A huge or invalid file is refused (409 `config_unreadable`) and left untouched. Comments and other keys survive. A literal `api_key` is removed. Applying twice writes nothing the second time. Pinned in Task 4.
4. **An existing volume without a quota, or a network without the `hn` bridge name, while enforcement is on.** Refused (`volume_quota_missing` / `network_policy_missing`) before any container is created or started. Pinned in Tasks 3 and 5.
5. **The egress canary or the DNS seed failing halfway** (image missing, container never exits, listener fails). Everything it created (network, container, listeners) is removed, and the error names a reason class only. Pinned in Task 6.

---

### Task 1: Typed application errors

**Files:**
- Create: `server/internal/shared/apperr/apperr.go`, `server/internal/shared/apperr/apperr_test.go`

**Interfaces:**
- Produces:
  - `type Error struct{ Status int; Code, Message string }` with `Error() string` returning `Message`.
  - `func (e *Error) Is(target error) bool`: true when `target` is an `*Error` with the same `Code`, so `errors.Is(err, apperr.VolumeQuotaMissing)` works.
  - Sentinels and constructors with Node's exact status, code and default message (`src/shared/errors.ts`):
    - `Validation(msg string) *Error` (400 `validation_error`)
    - `RuntimeUnavailable` (503 `runtime_unavailable`, "Runtime is temporarily unavailable")
    - `VolumeQuotaMissing` (409 `volume_quota_missing`, "Tenant volume has no disk quota")
    - `NetworkPolicyMissing` (409 `network_policy_missing`, "Tenant network does not match the egress policy") with `NetworkPolicyMissingMsg(msg) *Error`
    - `ConfigUnreadable` (409 `config_unreadable`, "The instance configuration file could not be read")
  - Later milestones add the rest of `errors.ts` here.

- [ ] **Step 1: Failing test.** `TestErrorsMatchNode` (table): status, code and message of each sentinel equal the values above. `errors.Is(fmt.Errorf("wrap: %w", apperr.VolumeQuotaMissing), apperr.VolumeQuotaMissing)` is true. `errors.Is(apperr.Validation("x"), apperr.RuntimeUnavailable)` is false.
- [ ] **Step 2:** `go test ./internal/shared/apperr/` → FAIL (no package).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat(server): typed application errors for the runtime`.

### Task 2: Runtime golden generator

**Files:**
- Create: `server/testdata/golden/gen/runtime.ts`, `server/testdata/golden/runtime.golden.json`
- Modify: `server/testdata/golden/README.md` (table row and command)

**Interfaces:**
- Produces: `runtime.golden.json`, an object with these arrays. Each entry has a `name`, the input and the Node output; an input that Node refuses has `error: <message>`.
  - `apiKey`: `{masterKey, instanceId, key}`. Ids in lower and upper case, a non-UUID.
  - `names`: `{id, container, volume, network, bridge}`.
  - `network`: `{instanceId, tenantId?, options}`, where `options` is `buildNetworkConfig`'s result as JSON.
  - `container`: `{spec, name, body}`, where `body` is `buildContainerConfig(spec)` without `name`. Variants:
    1. minimal runc;
    2. `apiServerKey` set;
    3. env that already sets `API_SERVER_HOST`/`PORT`/`KEY`;
    4. runsc with dns (resolv.conf mount);
    5. dns without runsc (Dns only);
    6. errors: `cpuMillis` 49, `memoryMb` 31, `pids` 7, `storageMb` 63, a non-integer limit, env key `docker_host` (case-insensitive), bad instance id, bad tenant id.
  - `imagePolicy`: `{image, production, error?}`. Cases: whitespace, empty, `latest`, empty tag, no tag, a tag with a registry port (`reg:5000/x`), a malformed digest, a digest without production, production without a digest, an uppercase `LATEST`.
  - `volumeQuota`: `{options, mb}` for `readVolumeQuotaMb`: `1024m`, `1g`, `1G`, `512k`, `1048576`, `10mb`, ` 2g `, `0m`, `abc`, missing. Plus `sizedVolumeOpts(1024)`.
  - `demux`: `{inputBase64, lines}`: framed stdout+stderr, a truncated last frame, TTY plain text, `\r\n` lines, empty input.
  - `tar`: `{name, content, uid, gid, mode, mtime, base64}`, made with `Date.now` stubbed to `mtime*1000`. Includes empty content, content longer than 512 bytes, and refused names `../x`, `.`, `a/b`.
  - `readFirstFile`: `{base64, content|null}`.
  - `model`: `{existing|null, model|null, output|null, error?}`. Covers every case of `test/unit/hermes-config.test.ts`, plus:
    1. a file with comments and unrelated keys;
    2. `sessions` that is a list;
    3. `sessions.auto_prune: false`;
    4. a customer `model` block with another `key_env`, with `model: null`;
    5. a top-level list;
    6. invalid YAML.
  - `scripts`: `{canary, dnsSeed}`: the exact `CANARY_SCRIPT` and `DNS_RESOLV_SEED_SCRIPT` strings.
- Command: `pnpm tsx server/testdata/golden/gen/runtime.ts [--check]` from the repository root, the same conventions as `gen/config.ts`.

- [ ] **Step 1:** Write the generator, importing only from `src/modules/runtime/*`. Every id is a fresh fixed UUID literal. Every value is fake.
- [ ] **Step 2:** Run it, then `--check`. Expected: written, then exit 0.
- [ ] **Step 3: Commit** `test(server): Node-generated runtime golden cases`.

**Engine JSON equality rule** (used by Tasks 3 and 6). Write it once, as `assertEngineEqual(t, node map[string]any, goValue any)` in `server/internal/runtime/engine_test.go`. It marshals `goValue` to JSON, then requires:
1. every key and value in `node` to exist with an equal value in the Go JSON;
2. every key in Go JSON that is absent from `node` to hold a zero value (`0`, `false`, `""`, `null`, `[]`, `{}`);
3. `Env` to compare as a set (Go builds it from a map).

This is how "same request as Node" is judged.

### Task 3: Pure runtime helpers

**Files:**
- Create in `server/internal/runtime/`: `id.go`, `apikey.go`, `hardening.go`, `imagepolicy.go`, `volumequota.go`, `demux.go`, `tar.go`, `types.go`, plus `*_test.go` for each and `engine_test.go`.

**Interfaces:**
- Consumes: `apperr` (Task 1), `runtime.golden.json` (Task 2).
- Produces:
  - `type ID string`; `func ParseID(s string) (ID, error)`: UUID (case-insensitive), lowercased, `apperr.Validation("Invalid instance id")` otherwise. Methods `ContainerName()`, `VolumeName()`, `NetworkName()`, `BridgeName()`.
  - Constants `ContainerPort = 8642`, `DataMount = "/opt/data"`, `LabelManaged`, `LabelInstance`, `LabelTenant`, `BridgeNameOption`, `S6RequiredCaps` (the eight, same order), `S6Tmpfs`, `DNSResolvVolume = "hermes-dns-resolv-conf"`, `DNSResolvSubpath = "resolv.conf"`.
  - `func DeriveAPIKey(masterKey, instanceID string) (string, error)`: HMAC-SHA256 hex of `"hermes-cloud/api-server-key/v1:" + lowercase id`, keyed by `masterKey`.
  - `types.go`:
    - `ResourceLimits{CPUMillis, MemoryMB, Pids, StorageMB int}`
    - `Spec{InstanceID, TenantID, Image string; Limits ResourceLimits; DiskQuota, EgressPolicy, Runtime string; Env map[string]string; DNS []string; APIServerKey string; Model *ModelChange}`
    - `ModelChange{Remove bool; Config ModelConfig}` (nil means leave the file alone; `Remove` is Node's `null`)
    - `ModelConfig{Default, BaseURL, KeyEnv string}`
    - `State` with the six Node states
    - `Inspection{State State; ExitCode *int; OOMKilled bool; StartedAt *time.Time; HostPort int; VolumePresent bool}`
    - `Health{OK bool; LatencyMs int64; Detail string}`, `const AuthRejectedDetail = "auth rejected"`
    - `EnsureResult{HostPort, VolumeQuotaMB int}` (0 means none)
    - `Manager` interface with Node's methods, each taking `ctx`: `Ensure`, `Recreate`, `AssertVolumeQuota`, `AssertNetworkPolicy`, `Logs(ctx, id, tail int) ([]string, error)`, `Start`, `Stop(ctx, id, timeoutSec int)`, `Restart`, `Inspect`, `CheckHealth(ctx, id, key string) Health`, `VolumeUsage(ctx) (map[string]int64, error)`, `Remove(ctx, id, deleteVolume bool)`.
  - `func BuildContainerConfig(s Spec) (CreateRequest, error)`, with `CreateRequest{Name string; Config *container.Config; Host *container.HostConfig}`. Env is sorted by key.
  - `func BuildNetworkConfig(instanceID, tenantID string) (name string, opts network.CreateOptions, err error)`. `tenantID` may be "".
  - `func AssertPinnedImage(image string, production bool) error`, with the message `"Hermes image is not pinned: <why>"` as in Node.
  - `func SizedVolumeOpts(mb int) map[string]string`, `func ReadVolumeQuotaMB(opts map[string]string) int`, `func IsQuotaUnsupported(err error) bool` (400 with "no quota support").
  - `func DemuxLogs(b []byte) []string`.
  - `func BuildTar(name, content string, uid, gid, mode int, mtime time.Time) ([]byte, error)`, `func ReadFirstFile(b []byte) (string, bool)`, `func CollectCapped(r io.Reader, max int) ([]byte, error)` (`apperr.ConfigUnreadable` past `max`), `const MaxConfigBytes = 256 << 10`.

- [ ] **Step 1: Failing tests.**
  - One test per golden array (`TestAPIKeyGolden`, `TestNamesGolden`, `TestNetworkConfigGolden`, `TestContainerConfigGolden`, `TestImagePolicyGolden`, `TestVolumeQuotaGolden`, `TestDemuxGolden`, `TestTarGolden`, `TestReadFirstFileGolden`) comparing with `assertEngineEqual` or plain equality. For every refused input, the error message equals Node's.
  - Plus the Node unit tests not covered by a golden, ported by name from `hardening`, `network-config`, `network-policy` (unit), `api-key`, `image-policy` and `volume-quota`.
  - Plus `TestCollectCappedStopsAtMax`, using a reader that fails the test if read past `max+1` bytes.
- [ ] **Step 2:** `go test ./internal/runtime/` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS. Then mutate one capability name in `S6RequiredCaps` and confirm `TestContainerConfigGolden` fails. Restore it.
- [ ] **Step 5: Commit** `feat(server): runtime names, hardening, API key and helpers with Node goldens`.

### Task 4: Model block in config.yaml

**Files:**
- Create: `server/internal/runtime/hermesconfig.go`, `server/internal/runtime/hermesconfig_test.go`

**Interfaces:**
- Produces:
  - `const ProviderKeyEnv = "HERMES_PROVIDER_API_KEY"`.
  - `func ApplyModelBlock(existing *string, change ModelChange) (out string, write bool, err error)`, with Node's rules:
    - no file and `Remove` → no write;
    - a parse error or a non-map top level → `apperr.ConfigUnreadable`;
    - with a model: delete `api_key`, then set `default`, `provider: custom`, `base_url`, `key_env`;
    - `Remove` deletes `model` only if its `key_env` is `ProviderKeyEnv`;
    - add `sessions.auto_prune: true` only when `sessions` is absent, or is a map without `auto_prune`.
- **Decision (spec section 4 deviation, owner-visible):** Go's YAML writer will not be byte-identical to Node's `yaml` package. Hermes reads the file as YAML, so parity is judged semantically: Go's output parsed equals Node's output parsed, every comment line of the input is still present, and `write` is false when the parsed result equals the parsed input. Record this as a ruling.

- [ ] **Step 1: Failing tests.**
  - `TestModelBlockGolden`: for each `model` golden case, the error code matches, and a `nil` Node output means `write == false`. Otherwise the parsed Go output equals the parsed Node output, and the input's comments are kept.
  - Then the 9 config cases of `test/unit/hermes-config.test.ts` ported by name.
  - `TestApplyTwiceWritesOnce`: apply, then apply to the output → `write == false`.
- [ ] **Step 2:** `go test ./internal/runtime/ -run 'Model|Apply'` → FAIL.
- [ ] **Step 3:** Implement with `goccy/go-yaml`'s AST (comment-preserving). Use `parser.ParseComments`, edit the mapping nodes, then print with the file's `String()`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat(server): managed model block in the tenant config.yaml`.

### Task 5: Docker runtime manager

**Files:**
- Create: `server/internal/runtime/docker.go` (the `Manager` implementation), `server/internal/runtime/docker_integration_test.go`, `server/internal/runtime/isolation_integration_test.go`, `server/internal/runtime/health_test.go`, `server/internal/testutil/stubimage/stubimage.go`

**Interfaces:**
- Consumes: Tasks 1, 3, 4.
- Produces:
  - `func NewDocker(cli *client.Client, log *slog.Logger) *Docker` (implements `Manager`), with `HealthTimeout = 2 * time.Second`.
  - `func translate(err error) error`: SDK connection failure (`client.IsErrConnectionFailed`, context deadline) → `apperr.RuntimeUnavailable`. An `*apperr.Error` passes through. Anything else → `fmt.Errorf("Docker operation failed (status %d)", code)`, which never wraps the SDK error.
  - `stubimage.Ensure(t testing.TB, cli *client.Client) string`: builds `hermes-stub:0.2.0` from `../test/fixtures/hermes-stub` (relative to the module root) through the SDK's `ImageBuild` when the image is missing. Shell files go into the build context with mode 0755.
- Behaviour mirrors `docker-runtime-manager.ts` line by line:
  - `Ensure` validates first, then network, volume, then a container if absent. It pulls the image when missing. A 409 on create counts as "another call created it". The model is applied only to a container created by this call, and that container is removed if the apply fails.
  - `Recreate` removes the container (a 404 is fine), then runs `Ensure`.
  - `Start` ignores 304. `Stop` ignores 304 and 404.
  - `Logs` clamps `tail` to 1..500 and keeps at most the last 256 KiB.
  - `Inspect` uses Node's state mapping and keeps `HostPort` only while running.
  - `CheckHealth` sends `GET http://127.0.0.1:<port>/api/sessions` with `Authorization: Bearer <key>` when a key is given. With a key only 200 is ok, and 401 means `AuthRejectedDetail`. Without a key, 200 or 401 is ok. On a timeout the detail is "timeout", otherwise "connection failed".
  - `VolumeUsage` uses `system df` limited to volumes and keeps only managed volumes with a size ≥ 0.
  - `Remove` removes the container, then the network, then the volume when asked; each ignores a 404.
  - The network race is handled: a 409 means inspect the winner and check its bridge name. A 403 "same bridge name" with enforcement on means `NetworkPolicyMissing` with "Tenant bridge name is already in use".

- [ ] **Step 1: Failing unit test.** `health_test.go` ports the 6 tests of `test/unit/runtime-health.test.ts`, against an `httptest.Server` and a fake inspection.
- [ ] **Step 2: Failing integration tests.**
  - `docker_integration_test.go` ports the 10 tests of `test/integration/runtime-manager.test.ts` by name. "Unreachable daemon" uses a client on a socket path that does not exist.
  - Plus `TestConcurrentEnsure` (Review Focus 2): 5 goroutines `Ensure` one spec → no error, then exactly 1 container, 1 network and 1 volume carry that instance label.
  - Plus `TestEnsureRemovesContainerWhenModelApplyFails`: an existing `config.yaml` that is not YAML → `ConfigUnreadable` and no container left.
  - Plus `TestDaemonStallReturnsUnavailable` (Review Focus 1): a context with a 50 ms deadline on a listener that accepts and never answers → `apperr.RuntimeUnavailable` within 1 s.
  - `isolation_integration_test.go` ports the 8 tests of `test/integration/isolation.test.ts` by name.
- [ ] **Step 3:** `go test ./internal/runtime/` and `go test -tags integration -p 1 ./internal/runtime/` → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Same commands → PASS. Then `docker ps -a --filter label=hermes.cloud/managed=true` lists nothing these tests created.
- [ ] **Step 6: Commit** `feat(server): Docker runtime manager with the Node hardening`.

### Task 6: Startup checks

**Files:**
- Create: `server/internal/runtime/startup.go`, `server/internal/runtime/canary.go`, `server/internal/runtime/dnsresolv.go`, `server/internal/runtime/startup_test.go`, `server/internal/runtime/canary_test.go`, `server/internal/runtime/dnsresolv_test.go`, `server/internal/runtime/canary_integration_test.go`

**Interfaces:**
- Produces:
  - `func AssertRuntimeAvailable(ctx context.Context, info interface{ Info(context.Context) (system.Info, error) }, runtime string) error`: runc always ok; otherwise the runtime must be listed in `Info().Runtimes`. Error text `Docker runtime "<name>" is not available on this host`.
  - `func AssertDiskQuotaSupported(ctx context.Context, d VolumeAPI, mode string) error`: creates and removes a 64 MB probe volume `hermes-quota-probe-<uuid>`. Its fixed error text is the one in `disk-quota-check.ts`.
  - `func EnsureDNSResolvConf(ctx context.Context, d DockerAPI, image string, resolvers []string, runtime string, log *slog.Logger) error`, with `*DNSResolvConfError{Reason string}`.
  - `func RunEgressCanary(ctx context.Context, d DockerAPI, image, privateIP, runtime string, listen ListenFunc, log *slog.Logger) error`, with `*EgressPolicyError{Check string}` (message `Egress policy is not in force (check: <check>)`) and `*EgressCanaryError{Reason string}` (message `Egress canary could not run`).
  - `type ListenFunc func(host string) (port int, closeFn func() error, err error)`, and the default `ListenOn`.
  - `DockerAPI` and `VolumeAPI` are the narrow interfaces over the SDK client these functions need, so the unit tests can pass fakes. Scripts are taken verbatim from the golden `scripts`.
  - Canary container: `PidsLimit` 256 under runsc, else 32. `Tty: true`. Memory 32 MiB. Probes are passed as argv triples. Everything it created is removed in all cases, and cleanup logs a reason only.

- [ ] **Step 1: Failing unit tests,** with fake `DockerAPI`/`VolumeAPI`: the 22 tests of `egress-canary.test.ts` (unit), the 14 of `dns-resolv-conf.test.ts`, the 4 of `runtime-availability.test.ts` and the 5 of `disk-quota-check.test.ts`, ported by name. Plus `TestCanaryCleansUpOnEveryFailure` (Review Focus 5): for each failure point (image inspect, network create, gateway inspect, listen, container start, wait timeout, bad output), the fake records that every created resource was removed and every listener closed.
- [ ] **Step 2: Failing integration test.** The one test of `test/integration/egress-canary.test.ts` (a missing image is a canary failure and leaves nothing behind).
- [ ] **Step 3:** `go test ./internal/runtime/` plus the integration command → FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Same commands → PASS.
- [ ] **Step 6: Commit** `feat(server): runtime, disk quota, DNS and egress startup checks`.

### Task 7: Wire the runtime into serve

**Files:**
- Modify: `server/cmd/hermes-cloud/serve.go`, `server/cmd/hermes-cloud/serve_integration_test.go`

**Interfaces:**
- Consumes: Tasks 5 and 6, plus `config.Config` (`DockerSocketPath`, `Runtime`, `DiskQuota`, `EgressPolicy`, `CanaryImage`, `CanaryPrivateIP`, `DNSResolvers`).
- Behaviour, in `src/main.ts` order:
  1. create the Docker client on `unix://<DockerSocketPath>`;
  2. `AssertRuntimeAvailable`;
  3. `AssertDiskQuotaSupported`;
  4. with egress `enforce`: `RunEgressCanary`, where an `EgressPolicyError` or `EgressCanaryError` logs its message and exits 1;
  5. with runsc and resolvers: `EnsureDNSResolvConf`, where an error logs and exits 1;
  6. build the `Manager` (unused until M2, kept to prove the wiring);
  7. add the readiness check `docker` (ping) after `database`.

- [ ] **Step 1: Failing test.** Extend `TestServeLifecycle`: with the Docker socket available, `/readyz` answers 200. With `DOCKER_SOCKET_PATH=/nonexistent.sock`, `serve` exits 1 at startup (the runc check needs no daemon, but the disk-quota check with `HERMES_DISK_QUOTA=enforce` does). The test sets `enforce` and expects exit 1 with no Docker text in the output.
- [ ] **Step 2:** `go test -tags integration -p 1 ./cmd/hermes-cloud/` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Commit** `feat(server): serve runs the runtime startup checks and a docker readiness check`.

### Task 8: Live harness against the official image

**Files:**
- Create: `server/validation/runtimelive/main.go`, `server/validation/README.md`

**Interfaces:**
- A port of `test/validation/runtime-manager-live.ts`: same `IMAGE` default (`HERMES_IMAGE` overrides), same checks, the same PASS/FAIL/SKIP lines, exit 1 on any FAIL, every resource removed in a deferred cleanup. The egress part (`egress-checks.ts`) prints SKIP with the reason "ported in M7".
- Run: `docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v <repo>:/src -w /src/server <pinned golang image> go run ./validation/runtimelive`.

- [ ] **Step 1:** Write it.
- [ ] **Step 2:** Run it here (Docker Desktop, runc). Expected: every check PASS or a listed SKIP, exit 0. Record the output summary for the PR.
- [ ] **Step 3: Commit** `test(server): live runtime harness against the official Hermes image`.

### Task 9: TEST-MAP, docs and the M1 gate

**Files:**
- Modify: `server/TEST-MAP.md` (via the generator's mapping), `server/README.md`, `docs/CURRENT_STATE.md`, and the TEST-MAP generator mapping (kept in the plan's scratch script or moved to `server/testdata/golden/gen/test-map.py`; choose the latter so it is in the repo).

**Interfaces:**
- TEST-MAP row moves (rulings):
  - `hermes-config` M4 → M1, ported: the manager needs it.
  - `network-policy` (integration) M1 → M2: it drives `InstanceService` and the reconciler.
  - `egress-rules` M1 → M7: it tests the host shell scripts in `ops/egress/`, not Go.
- Every other M1 row becomes `ported` or `golden` with its Go test name.

- [ ] **Step 1:** Commit the TEST-MAP generator as `server/testdata/golden/gen/test-map.py` (Python 3, stdlib only) with an `--check` flag. Encode the moves above. Regenerate.
- [ ] **Step 2:** Update `server/README.md` (layout rows for `internal/runtime`, `internal/shared/apperr`, how to run Docker integration tests) and add a `docs/CURRENT_STATE.md` entry: what M1 adds, what was verified, and what was not (runsc, the XFS quota and the egress rules on the real host).
- [ ] **Step 3: M1 gate.** Run each and expect PASS or "no drift":
  - `go vet ./... && go tool staticcheck ./... && go test -race ./...`
  - `go test -tags integration -p 1 ./...` (with the Docker socket and `--network host`)
  - `pnpm tsx server/testdata/golden/gen/config.ts --check && pnpm tsx server/testdata/golden/gen/runtime.ts --check`
  - `python server/testdata/golden/gen/test-map.py --check`
  - sqlc `diff`
  - `git diff --name-only origin/main...HEAD -- src prisma package.json pnpm-lock.yaml tsconfig.json deploy` prints nothing.
- [ ] **Step 4: Commit** `docs(server): M1 test map, README and status`. Then stop and ask the owner about push and PR.

---

## Not in M1

- The callers of the runtime (`InstanceService`, the reconciler, the disk monitor, the log service): M2/M4.
- `runtime-env.ts` (provider key env and model config loader): M4.
- Verifying runsc, the XFS kernel quota and the host egress ruleset: only on the VPS, at M8 (the live harness there runs with `HERMES_RUNTIME=runsc`, `HERMES_DISK_QUOTA=enforce` and `HERMES_EGRESS_POLICY=enforce`).
