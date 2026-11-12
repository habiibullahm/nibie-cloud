# Egress host notes

Results of the host verification spike (egress plan, Task 2) and of the checks that could run without
a Docker host with tenant containers. Every line says where it was observed. **Nothing here proves that
tenant traffic is blocked on a real host yet**: no container could be started in the authoring sandbox
(no image could be pulled), so the ruleset has never seen tenant traffic. Task 8 of the plan is open.

## Observed (cloud sandbox, Docker 29.9.2, iptables 1.8.10 nf_tables backend, root)

- `docker network create -d bridge -o com.docker.network.bridge.name=hnaaaaaaaaaaaa
  -o com.docker.network.bridge.enable_icc=false --ipv6=false` creates a bridge whose Linux interface is
  exactly `hnaaaaaaaaaaaa` (seen in `/sys/class/net`). `docker network inspect` shows both options and
  `EnableIPv6: false`. The same result through the Engine API with `EnableIPv6: false` in the body (the
  control plane's `ensureNetwork`).
- A second network asking for the same bridge name is rejected with **HTTP 403** and the message
  `... conflicts with network ...: networks have same bridge name`. A duplicate network *name* is
  HTTP 409. The control plane maps the 403 (policy `enforce`) and a stale network without the option to
  `network_policy_missing`. Checked against the real daemon with a throwaway script: a fresh network, a
  reused network, a stale network created without the option, and a collision all behaved as designed.
- `ops/egress/hermes-egress.sh apply` (real, not `--dry-run`) loads on this kernel: `conntrack`,
  `hashlimit`, `addrtype`, `REJECT --reject-with tcp-reset` and the CIDR rejects are all accepted.
  Running `apply` twice leaves exactly one jump in `DOCKER-USER` and one in `INPUT` and one chain;
  `status` exits 0; `remove` leaves nothing; `status` exits 1 and names what is missing afterwards.
- The startup canary against a real daemon: a missing image gives the fixed "Egress canary could not run"
  error (reason `image_missing`), exits the control plane with status 1, and leaves no network or
  container behind.

## Not verified (needs a Docker host that can run containers)

- That a container on an `hn` network actually hits the rules: counters incrementing on a
  `-i hn+ -j LOG` test rule in `DOCKER-USER` and in `INPUT` (plan Task 2 step 3). This also decides
  whether the rule order with Docker's own chains is right (`DOCKER-USER` runs before Docker's
  isolation chains; the ruleset ends with `RETURN` so they still apply).
- Whether `DOCKER-USER` contents survive a Docker restart and a reboot, and the ordering of
  `hermes-egress.service` against `docker.service` (Task 2 step 4). The unit is `PartOf=docker.service`,
  so a Docker restart stops and starts it, which leaves a short window with no rules while Docker is
  coming back. Not measured.
- Which resolver a tenant container uses and whether it is a private or loopback address on the real
  host (Task 2 step 5). If it is private, put it in `RESOLVERS`; until measured, DNS is unverified.
- Everything under gVisor (`runsc`): whether its network path hits these rules at all (step 6).
- The rate cap. `NEW_CONN_RATE` defaults to `200/sec` as a **placeholder**. It has not been measured
  against a normal Hermes workload (provider calls, a package install, a web fetch) and must not be
  described as correct. Record the measured peak and the chosen value here.
- The canary with a real image: that `nc` in the chosen image connects to the control plane's listener
  when the rules are absent (the check can fail) and fails to connect when they are applied.
- The live harness egress checks (`test/validation/egress-checks.ts`): they have never run.

## To record after Task 8

| Item | Result |
| --- | --- |
| Interface counters on `DOCKER-USER` and `INPUT` (runc) | not run |
| Same under runsc | not run |
| Rules after `systemctl restart docker` | not run |
| Rules after reboot | not run |
| Upstream resolver and whether it is private | not run |
| Measured peak new-connection rate and chosen `NEW_CONN_RATE` | not run |
