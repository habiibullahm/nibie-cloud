# Instance self-management: web shell, file manager, config editor, logs

Status: design, approved approach, nothing built. Date: 2026-11-19. Build target: the current Node backend (`src/`, Fastify,
TypeScript) and the dashboard (`apps/web`). The owner set the Go port aside for this work ("ignore go. focus on current codebase").

Deploy note: merging anything under `src/`, `prisma/` or `package.json` to `main` redeploys production automatically
(`ops/host/hermes-auto-deploy.sh`). Each part below therefore ships behind its own switch (§4.9), off by default, so a merge
changes nothing for customers until the owner turns it on.

## 1. Intent

The owner wants the platform to run on autopilot: a customer fixes and changes their own Hermes instance, and nobody has to SSH
into the host to help. Owner's words: "user can easily manage by panel or shell. flexible way."

Success: "please check my agent" requests stop reaching the owner. Every problem a customer can cause, they can also undo from the
dashboard.

### Goals

- A customer can inspect, edit, repair and restart their own instance from the dashboard, through forms (panel) or a real shell.
- A customer who breaks their configuration can get back to a working instance without help.
- The owner can see afterwards who did what (audit), without the platform recording what was typed.

### Non-goals (this spec)

- Backups and restore of the whole volume (PRD §12, §15.7). A separate spec.
- Custom domains, SSH from outside, SFTP.
- Live log streaming. The existing polling follow stays.
- Changing the model or provider from the config editor. The Provider settings form stays the only way.

### Anti-goals (a failure even if it works)

- Any host access, Docker parameter, container id or host path accepted from the browser (PRD §7.5, §15.6).
- A customer action that leaves the instance broken with no self-service way back.
- Storing shell input or output anywhere.
- The JWT appearing in a URL.

## 2. What exists today (verified 2026-11-19 on `main` at `4982028`)

| Area | State |
| --- | --- |
| Console page `apps/web/src/app/(app)/instances/[id]/console/page.tsx` | Mock. Fixed answers for 5 commands, `PreviewNote` always shown. |
| Files page `.../files/page.tsx` | Mock tree from `apps/web/src/lib/api/mock.ts` (`/skills`, `/memory`, `/logs`, `config.yaml`, `SOUL.md`). |
| Configuration page `.../configuration/page.tsx` | Provider and Telegram forms are real. Nothing edits `SOUL.md` or raw `config.yaml`. |
| Logs | Real. `GET /instances/:id/logs?tail=` (`src/http/integration-routes.ts:46`), at most 500 lines, scrubbed by `redactLines`. The dashboard asks for 200 and re-polls every 5 s to follow. |
| Backend file or exec routes | None. The only volume access is `applyModel` (`src/modules/runtime/docker-runtime-manager.ts:272-285`): `getArchive` of `config.yaml`, then `putArchive` of a tar owned by uid/gid 10000. |
| Platform-owned config | `applyModelBlock` (`src/modules/runtime/hermes-config.ts:26-52`) owns `model.default`, `model.provider: custom`, `model.base_url` and `model.key_env: HERMES_PROVIDER_API_KEY`, and deletes `model.api_key`. It also sets `sessions.auto_prune: true` once. Unparseable YAML gives `409 config_unreadable`. The block is written only when the container is created or recreated. |
| Container | `ReadonlyRootfs`, `CapDrop: ALL` plus 8 s6 caps, `no-new-privileges`, s6 as PID 1 drops to uid 10000, volume at `/opt/data`, `User` not pinned (`src/modules/runtime/hardening.ts`). |
| Recovery | The reconciler retries 3 times, then sets `DEGRADED` with reason `recovery_exhausted`, "operator attention required" (`src/modules/instances/reconciler.ts:335-341`). |
| Audit | `InstanceEvent` (`type`, `message`, no actor). `AuditLog` is admin-only. No record of customer actions. |
| Rate limit | Customer API 120 requests a minute per user (`src/http/customer-routes.ts:45-50`), with tighter per-route limits. |

## 3. Approaches considered

The question was how much power the shell gets, because of one fact: any process running as uid 10000 can read
`/proc/<agent pid>/environ`. The agent's keys cannot be hidden from such a shell.

1. **Full shell as uid 10000, keys visible (chosen by the owner).** A real interactive shell inside the customer's own container.
   It fits "flexible" best: nothing the customer needs falls outside the tool. Cost: the customer can read their provider key,
   their NibieRouter key and `API_SERVER_KEY`.
2. **Allowlisted commands only.** Buttons or a short list such as `hermes doctor` or install a skill. Keys stay hidden, but any need
   outside the list comes back to the owner. That defeats the purpose.
3. **Full shell, with the NibieRouter key moved out of the container.** The agent calls a control-plane proxy instead of holding the
   key. Keys stay safe and the shell stays free, but it adds a new always-on component. Kept as a later upgrade if key misuse shows
   up.

### Accepted risk

With option 1 a customer can copy their NibieRouter key and spend that tenant's credit outside the agent. The spend is bounded by
the tenant's own router balance. The provider key is the customer's own. `API_SERVER_KEY` only opens their own gateway. All
container limits still apply: gVisor (`runsc`), the egress ruleset, CPU, memory and pids limits, and the disk quota. The customer
docs must say plainly that the shell can see the instance's keys.

## 4. Design

All four features share these rules:

- **Tenant check first.** Every route resolves the instance through the caller's tenant, exactly as the existing customer routes
  do, and answers 404 for an instance that is not theirs.
- **Inside the container only, as uid 10000.** Every file and shell operation runs through Docker `exec` in the container
  `hermes-<id>` as `User: "10000:10000"`. Nothing reads or writes the volume's host path. The kernel's permission checks then
  enforce the boundary for every path, symlinks included, with no check-then-write race.
- **Never as root, except for two fixed files.** Docker's archive API (`getArchive`/`putArchive`) runs as root in the daemon and
  follows symlinks inside the container. A customer could swap a checked folder for a symlink to `/run` (where s6, PID 1, keeps
  root service scripts) between a check and the write. So the archive API is used only for `/opt/data/config.yaml` and
  `/opt/data/SOUL.md`, which sit directly in the volume mount. Before every archive write, the server reads the current entry and
  refuses (`409 not_a_regular_file`) unless it is a regular file or absent. The archive API is still needed there, because it is
  the only way to repair a container that has exited (§4.2).
- **Only `src/modules/runtime` talks to Docker.** It gets new methods on the `RuntimeManager` interface
  (`src/modules/runtime/types.ts`, §4.6). Routes pass an instance id and validated values, never Docker-shaped input.
- **Suspended subscription: read only (owner decision).** While the instance's subscription is `SUSPENDED` (the 30-day
  retention), config and file reads, history and downloads still work. Every write, upload, delete, rename, mkdir and restore
  answers `403 subscription_suspended`, and the shell is blocked. The customer can always take their data out, and paying again
  restores full access. The dashboard shows the editors read-only with a renew prompt.
- **Routes live in the customer plugin.** A new `src/http/self-manage-routes.ts`, registered inside the customer plugin the way
  `registerCustomerIntegrationRoutes` is (`src/http/integration-routes.ts:26`). The Supabase token hook, `no-store` and the
  per-user rate limit then apply automatically. Bodies are parsed with strict zod schemas, as in the existing routes. The one
  exception is the WebSocket upgrade (§4.4).

### 4.1 Config editor (panel)

Endpoints, customer API:

```text
GET  /instances/:id/config/:file              file = soul | config
PUT  /instances/:id/config/:file              body: text, max 256 KB
GET  /instances/:id/config/:file/history      last 10 snapshots: timestamp, size
POST /instances/:id/config/:file/restore      body: { "snapshot": "<timestamp>" | "last_good" | "default" }
```

`soul` maps to `/opt/data/SOUL.md` and `config` to `/opt/data/config.yaml`. No other path is accepted on these routes.

Rules:

- Allowed in `ACTIVE`, `DEGRADED` and `STOPPED`. Any transitional status answers `409`. Reads and writes use
  `getArchive`/`putArchive`, which work on a stopped container too, so a crash-looping instance can still be repaired.
- **Save `config.yaml`:**
  - Parse first. Invalid YAML or a root that is not a map answers `422 config_invalid` with the parser's line and column. Nothing is
    written.
  - **Every write of `config.yaml`** (save, every restore, reset) goes through `applyModelBlock(text, currentModel)`. Here
    `currentModel` is the `ModelConfig` the next container recreate would write. It comes from the same code path as
    `RuntimeConfigLoader` (`src/modules/integrations/runtime-env.ts`), without decrypting the key (model, base URL and `key_env` are not secret). It is `null` when the instance
    has no platform provider.
    - A save therefore always ends with the current platform `model:` block, whatever the customer sent, and a restored snapshot
      never brings back a stale model.
    - When the block differs from what was sent, the response says `modelBlockKept: true`, and the UI explains that the model is
      set on the Provider tab.
    - *(my call)*
  - `sessions.auto_prune` follows `applySessionDefaults` as today.
- **Save `SOUL.md`:** any UTF-8 text up to 256 KB.
- **Snapshot before every write.** The current file is copied to `/opt/data/.nibie/history/<file>/<UTC timestamp>` first. The
  newest 10 per file are kept; older ones are deleted in the same operation.
- **Applying a save.** The UI offers "Save" and "Save and restart". The restart goes through the existing `InstanceCommands`
  restart job, so leases and fencing are unchanged.
- **Last known good.**
  - After every start or restart that ends healthy, both files are copied to `/opt/data/.nibie/good/` when they differ from the
    copy there.
  - The call sits where health is known: `InstanceService.startFlow` (`src/modules/instances/instance-service.ts:372`), its
    helper `startOrRecreate` (`runtime-apply.ts:43`) and the reconciler's `recoverSteps` (`reconciler.ts:290`). It does not go in
    `RuntimeManager`.
  - A failed copy is logged and never fails the start.
  - New column `Instance.lastGoodAt` (nullable timestamp), set after a successful copy.
  - **Backfill:** instances running at rollout have no copy yet. On a healthy check of an `ACTIVE` instance whose `lastGoodAt` is
    null, the reconciler takes the copy once. The column keeps this from touching the volume every tick. *(my call)*
- **Restore.**
  - `last_good` writes the `.nibie/good` copies back. When none exists, it answers `409 no_last_good`, and the UI hides the button.
    *(my call)*
  - `<timestamp>` writes that snapshot back.
  - `default` exists for `config.yaml` only. It writes `applyModelBlock("", currentModel)`: the platform `model:` block (if any)
    plus `sessions.auto_prune: true`. With no platform provider that is `sessions:\n  auto_prune: true\n`. `SOUL.md` has no
    `default`, because nobody has checked that Hermes starts without it. History and `last_good` cover undo. *(my call)*
  - A restore also takes a snapshot first, so it can itself be undone.

### 4.2 Self-recovery in the dashboard

This replaces "operator attention required" with a customer path:

- When an instance is `DEGRADED` with reason `recovery_exhausted`, the instance page shows a repair card in place of the
  generic error:
  1. "Restore last working config": restore `last_good` for both files, then restart.
  2. "Reset config to default": restore `default` for `config.yaml`, then restart.
  3. "Edit config" (the §4.1 editors and their history) and "View logs".
- After recovery is exhausted the container is exited (`RestartPolicy: no`, `hardening.ts:133`), and Docker cannot exec into an
  exited container. The config editor still works there (archive API, two fixed files). The file manager and the shell need a
  running container, so the card hides them. No rescue container is started; that would be a new mechanism. *(my call)*
- The reconciler's attempt counter is already handled. A user start or restart that ends healthy resets `recoveryAttempts`
  (`RESET_RECOVERY`, `instance-service.ts:64`, applied at `:345` and `:407`). A user restart that fails leaves the instance
  exhausted, so the reconciler does not loop on a config that is still broken. Keep this as is, and add a test: repair, restart,
  healthy, then the counter is 0.

### 4.3 File manager

Endpoints (PRD §15.6):

```text
GET    /instances/:id/files?path=                       list a directory (max 1000 entries, then truncated: true)
GET    /instances/:id/files/content?path=               file bytes: inline text up to 2 MB, download up to 50 MB
PUT    /instances/:id/files/content?path=               raw body (application/octet-stream), max 10 MB
POST   /instances/:id/files   { op: "mkdir" | "rename", path, to? }
DELETE /instances/:id/files?path=&recursive=
```

Path rules, applied in the API before Docker is called. Each is a unit test case.

- The path is relative to `/opt/data`, written with a leading `/` (the mock's shape, `FileEntry.path`).
- Reject an empty path, NUL, any `..` segment, a backslash and anything over 1024 bytes. Collapse `//` and a trailing `/`.
- The joined absolute path must start with `/opt/data/`, or be `/opt/data` itself for a listing.
- `DELETE` and `rename` refuse `/opt/data` itself.

These checks are for clear errors and for keeping customers inside their data folder. The security boundary is uid 10000: every
operation below runs as that user. A symlink the customer made to `/etc` or `/run` therefore gets only what uid 10000 could
already do from the shell.

How each operation runs. Every one is a Docker exec as `User: "10000:10000"` with a fixed argv and no shell:

| Operation | argv |
| --- | --- |
| list | `["find", p, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\t%s\t%T@\t%f\n"]` |
| read / download | `["cat", "--", p]`, output capped (2 MB inline, 50 MB download) |
| write / upload | `["dd", "of=" + p, "status=none"]` with the body on stdin, capped at 10 MB |
| mkdir | `["mkdir", "--", p]` |
| rename | `["mv", "--", a, b]` |
| delete | `["rm", "-r", "--", p]` |

Exec needs a running container. Every file operation checks `inspect().state === 'running'` and otherwise answers
`409 instance_not_running`. A `DEGRADED` instance whose container has exited is included. On an exited container only the config
editor (§4.1) works. *(my call)*

The disk quota limits total size. A write that hits the quota answers `507 quota_exceeded`.

Writes, deletes and renames are audited with path and size only (§4.5).

### 4.4 Web shell

Endpoints:

```text
POST   /instances/:id/console/sessions               -> { sessionId, ticket, expiresAt }
GET    /instances/:id/console?ticket=                 WebSocket upgrade
```

Closing the WebSocket ends the session. "End session" in the UI closes the socket, so there is no separate end route.

**Why a ticket.** A browser cannot set `Authorization` on a WebSocket, and the JWT must never go in a URL, because URLs reach
proxy logs. The ticket:
- 32 random bytes, base64url;
- stored only as a SHA-256 hash in table `ConsoleSession` (Postgres, RLS on like other tenant tables);
- valid for 30 seconds;
- used once: the upgrade claims it with
  `UPDATE ... SET startedAt = now() WHERE ticketHash = $1 AND startedAt IS NULL AND ticketExpiresAt > now() RETURNING ...`;
- bound to the user and the instance that created it.

**Origin check.** The upgrade rejects any `Origin` other than `DASHBOARD_ORIGIN` (`src/config/env.ts:87`). That stops cross-site
WebSocket hijacking. Env validation refuses `SELF_MANAGE_SHELL=on` while `DASHBOARD_ORIGIN` is unset.

**Auth on the upgrade route.**
- `GET /instances/:id/console` carries no bearer token, so it is registered outside the customer plugin's Supabase hook.
- The ticket and the Origin check are its only authentication.
- It gets its own rate limit, 20 a minute per IP, because the plugin's limit keys on a user it does not have here. *(my call)*
- `POST /console/sessions` stays inside the customer plugin.

**Exec.**
- Settings: `User: "10000:10000"`, `Tty: true`, `AttachStdin/Stdout/Stderr: true`, `WorkingDir: /opt/data`.
- `Cmd` is `["/bin/bash", "-l"]`, or `["/bin/sh"]` when bash is absent (pre-build check §6).
- Env: `TERM=xterm-256color` only. The browser cannot add anything.

**Frames.**
- Binary frames carry terminal bytes both ways.
- Text frames carry JSON control messages. Only `{ "type": "resize", "cols": n, "rows": n }` is accepted, with cols 1-500 and
  rows 1-200; it maps to exec resize.
- Anything else closes the socket with code 1008.

**Limits.**

| Limit | Value |
| --- | --- |
| Open sessions per instance | 2 (the third `POST` answers `409 console_busy`) |
| Session creation | 10 per 10 minutes per user |
| Idle timeout (no input) | 15 minutes |
| Maximum session length | 2 hours |
| Output | Backpressure: stop reading from the exec when the socket buffer exceeds 1 MB |

A session counts as **open** when it is connected (`startedAt IS NOT NULL AND endedAt IS NULL`) or holds an unused ticket that
has not expired (`startedAt IS NULL AND ticketExpiresAt > now()`). An abandoned ticket therefore stops counting after 30 s. The
count and the insert run in one transaction under `pg_advisory_xact_lock` on the instance, the same pattern as plan stock, so two
clicks at once cannot both pass.

**State.**
- Sessions start only in `ACTIVE` or `DEGRADED` with the container running, otherwise `409 instance_not_running`. A suspended
  subscription answers `subscription_suspended`, as start does.
- Stop, restart, recreate and delete close the instance's open sessions. The exec also dies with the container.
- Open sessions are held in an in-process registry keyed by instance id. `InstanceService` stop, restart, recreate and remove
  call `registry.closeAll(instanceId)`. This works because the BullMQ worker, the scheduler and the HTTP server all start in the
  same process (`src/main.ts`, `createInstanceWorker` and `startScheduler`). Splitting them later would need a Redis pub/sub
  message instead.
- On process start, every `ConsoleSession` without `endedAt` is closed with reason `server_restart`. Shortcut: this assumes one
  API process; revisit when there are several.

**Audit.**
- Recorded: start, end, duration, bytes in and out, and the end reason (`user`, `idle`, `max_age`, `instance_stopped`,
  `server_restart`).
- Never recorded: keystrokes or output.

**Library.**
- Server: `@fastify/websocket`, a new dependency justified because Fastify has no WebSocket support built in. Pick the major
  version that supports the installed Fastify 5. The ticket check runs in a `preValidation` hook, before the upgrade is
  accepted.
- Docker: dockerode's `container.exec(...)`, then `exec.start({ hijack: true, stdin: true })`, and `exec.resize(...)` for resize.
- Proxy: Caddy proxies WebSocket upgrades without extra config. Confirm on the real host.

### 4.5 Audit and visibility

- Add a nullable `actorUserId` column to `InstanceEvent` (Prisma migration). Existing system events keep it null.
  `recordEvent` (`src/modules/instances/instance-repo.ts:65`) gains an optional actor argument.
- New event types (`message` holds no file content):

| Event | Recorded |
| --- | --- |
| `config.saved` | file and size |
| `config.restored` | file and source (`snapshot`, `last_good` or `default`) |
| `file.written` | path and size |
| `file.renamed` | old and new path |
| `file.deleted` | path |
| `console.session_started` | session id |
| `console.session_ended` | session id, duration, bytes in and out, end reason |

- Admin panel: the instance detail page lists these events with the actor's email.
- No customer activity view. Nobody asked for one, and the admin view meets the audit goal.

### 4.6 Runtime seam additions

`RuntimeManager` (`src/modules/runtime/types.ts`) gets these methods, implemented in `docker-runtime-manager.ts`. All are keyed by
instance id, with no Docker types in their signatures:

- `readDataFile(instanceId, name: 'config.yaml' | 'SOUL.md', maxBytes): Promise<string | null>` and
  `writeDataFile(instanceId, name, text): Promise<void>`: the archive API, for these two names only. The type is the allowlist.
  - They reuse `buildTar` (uid/gid 10000, mode `0644`), `collectCapped` and `readFirstFile` from `src/modules/runtime/tar.ts`.
  - The write refuses unless the current entry is a regular file or absent.
  - `applyModel` (`docker-runtime-manager.ts:272`) then calls them instead of its own copy.
- `exec(instanceId, argv, opts: { stdin?: Buffer; maxOutput }): Promise<{ stdout; stderr; exitCode }>`: non-interactive, always
  as 10000:10000. It is used for every file manager operation.
- `attach(instanceId, size): Promise<ShellSession>`: the interactive TTY used by the shell. `ShellSession` exposes a duplex
  stream, `resize(cols, rows)` and `close()`.

The test double `test/helpers/fake-runtime.ts` must gain the same methods.

Path validation sits above this seam, in a new `src/modules/files` module, so the runtime never makes policy decisions.

### 4.7 Logs

- Keep `GET /instances/:id/logs`.
- The dashboard asks for `tail=500`, the existing server maximum, instead of 200.
- The log files under `/opt/data/logs` open through the file manager.
- No new log service.

### 4.8 Dashboard

- The console, files and configuration pages call the real API, and lose their `PreviewNote` in customer mode.
- The configuration page gets "SOUL.md" and "config.yaml" editors with history and restore.
- Terminal: `@xterm/xterm` and `@xterm/addon-fit` (a new dependency in `apps/web`, justified: no shadcn/ui terminal exists).
  Colours come from `DESIGN.md` tokens. Add terminal tokens through `DESIGN.md` if any are missing, and lint it.
- The console footer text "Planned: idle sessions will time out…" becomes the real limits.
- Client methods move from `PreviewApi` to the real API (`apps/web/src/lib/api/client.ts`, implementation next to `logs` in
  `apps/web/src/lib/api/integrations.ts`). The mock (`mock.ts`) keeps working for `mock` mode.
- The customer docs (`apps/docs`, Indonesian) get one page: what the shell can do, that it can see the instance's keys, the
  limits, and how to repair a broken config.

### 4.9 Switches

Three environment variables, each `on|off`, default `off`. They are read in `src/config/env.ts`, and are listed with placeholders
in `.env.example`.

| Variable | Turns on |
| --- | --- |
| `SELF_MANAGE_CONFIG` | §4.1, §4.2 |
| `SELF_MANAGE_FILES` | §4.3 |
| `SELF_MANAGE_SHELL` | §4.4 |

- While a switch is off, its routes are not registered (404), and the dashboard keeps the current preview page for that feature.
- `GET /me` (or the existing settings response) reports which switches are on, so the dashboard knows which pages are real.
- The admin Pengaturan page shows the three modes, names only, like the other settings.

## 5. Build order

Three parts, each shippable alone. The riskiest goes last, on the exec seam the first two have already proven.

1. **S1: config editor and self-recovery** (§4.1, §4.2, the `InstanceEvent.actorUserId` part of §4.5). Archive API only, no exec.
2. **S2: file manager** (§4.3), adding `exec`.
3. **S3: web shell** (§4.4), adding `attach`, the `ConsoleSession` table and WebSocket.

Each part gets its own plan (`superpowers:writing-plans`), its own branch and PR, and its own Prisma migration, with RLS like the
other tenant tables. Each merges with its switch off. The owner turns it on after the host checks in §6.

## 6. Host checks (unknown today)

These checks gate **turning a switch on**, not merging: code merges with its switch off, so an unverified assumption cannot reach
customers. The checks are read-only commands on the VPS. Claude runs them over SSH only after the owner says so.

- Run the S2 and S3 checks before writing those plans, so each plan covers only the path that works on the real image (for
  example `sh` and `stat` if `bash` or GNU `find` is missing). *(my call)*
- S1 needs two checks before `SELF_MANAGE_CONFIG=on`:
  - `putArchive` into a running `runsc` container (today it only writes into stopped ones);
  - Hermes booting with the minimal reset config.

Full list:

- Which user `docker exec` runs as by default in the official Hermes image. The design pins `User` anyway, so this only confirms
  that pinning works.
- `docker exec` with a TTY under `runsc` on the production host.
- Whether the image has `bash`, GNU `find` (`-printf`), `cat` and `dd`. If any is missing, use the fallback (`sh`, `stat`) and
  record it.
- That Hermes boots with the minimal `config.yaml` that "reset to default" writes.
- That the egress ruleset still applies to processes started by `docker exec`. It should, because they share the container's
  network namespace.
- That `test/fixtures/hermes-stub` supports exec as uid 10000 for the integration tests.

## 7. Tests

Vitest, following the existing layout: `test/unit` (no Docker) and `test/integration` (Docker, Postgres, Redis, run serially).

- Unit tests:
  - path normalisation table, covering `..`, NUL, backslash, length, the root and an encoded `%2e%2e` that arrives decoded;
  - `config.yaml` save keeping the platform `model:` block;
  - snapshot pruning at 10;
  - ticket single use, expiry, and the wrong user or instance;
  - open-session count: an expired unused ticket does not count, and two concurrent `POST`s with one slot left give one
    success and one `409`;
  - Origin rejection;
  - resize bounds;
  - unknown control frame closing the socket;
  - suspended subscription: reads pass, every write answers 403.
- Integration tests, with the stub image:
  - a write through a symlink to `/run` fails with a permission error (runs as uid 10000, not root);
  - `writeDataFile` refuses when `config.yaml` is a symlink;
  - written files are owned by uid 10000;
  - quota hit gives 507;
  - shell idle timeout;
  - stop closes sessions;
  - a broken `config.yaml` makes the instance `DEGRADED`, then restoring `last_good` brings it back to `ACTIVE`.
- Boundary tests, like today's: no route under the customer plugin imports the secret store; tenant B cannot touch tenant A's
  files, config or shell (404).

## 8. Left to the builder

- File layout inside `src/modules/files` and `src/modules/console`.
- The exact `find` output parsing and its fallback.
- The history file naming detail, within the rules above.
- UI layout within `DESIGN.md`.
