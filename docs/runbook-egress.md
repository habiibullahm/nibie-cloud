# Runbook: tenant egress rules

What this protects, how to check it, and what to do when it fails. Design:
[superpowers/specs/2026-11-12-egress-controls-design.md](superpowers/specs/2026-11-12-egress-controls-design.md).
What has and has not been verified: [egress-host-notes.md](egress-host-notes.md).

Tenant containers sit on bridges named `hn<12 hex>`. One iptables chain, `HERMES-EGRESS`, is jumped to
from `DOCKER-USER` and `INPUT` for `-i hn+`. It lets established traffic, DNS to the configured
resolvers and any configured `ip:port` exceptions through, rejects TCP 25, caps new connections per
tenant, rejects private, link-local (cloud metadata), reserved and host-local destinations, and returns
for everything else (the public internet). The control plane refuses to start in production if a canary
shows the rules are not in force.

## Check that the rules are loaded

```bash
sudo /opt/hermes-cloud/ops/egress/hermes-egress.sh status
sudo iptables -S HERMES-EGRESS
sudo iptables -S DOCKER-USER
sudo iptables -S INPUT | grep HERMES-EGRESS
systemctl status hermes-egress.service
```

`status` exits 0 only when the chain and both jumps exist. The jump should be the first rule in
`DOCKER-USER` and in `INPUT`.

## Change the configuration

Edit `/etc/hermes-egress/egress.conf` (start from `ops/egress/egress.conf.example`), then:

```bash
sudo /opt/hermes-cloud/ops/egress/hermes-egress.sh apply --dry-run --config /etc/hermes-egress/egress.conf  # review
sudo systemctl restart hermes-egress.service
```

`apply` flushes and refills the chain, so for a moment the chain is incomplete. Do it when you can
accept that, and run `status` afterwards. A malformed value makes the script exit non-zero without
changing anything.

## Add an exception for NibieRouter (or any single ip:port)

Only if NibieRouter is reachable on a private address, which is not decided yet. Add the single
address and port to `EXCEPTIONS` (TCP only, space-separated), for example
`EXCEPTIONS="198.51.100.20:8443"` (a documentation address, not a real one), and re-apply. Nothing else
on that host becomes reachable. Do not put a hostname there: rules match addresses, not names. Prefer a
public URL for NibieRouter, which needs no exception.

## The control plane exits at startup

The log line names one thing:

| Message | Meaning | What to do |
| --- | --- | --- |
| `Egress policy is not in force (check: gateway)` | the canary container reached a listener on its own bridge gateway | rules are missing or do not match: run `status`, then `systemctl restart hermes-egress.service`, then start the control plane |
| `... (check: private)` | it reached the host's private address (`HERMES_CANARY_PRIVATE_IP`) | same, and confirm the address is really a host address |
| `... (check: metadata)` | it connected to `169.254.169.254:80` | same; a metadata service answered, so the range reject is not in force |
| `Egress canary could not run` | Docker is down, the canary image is missing or lacks `nc`, or the probe produced no result | the log line before it carries a reason (`image_missing`, `docker_error`, `probe_failed`...); `docker pull` the pinned `HERMES_CANARY_IMAGE`, check the Docker daemon |

If the rules disappeared after a Docker restart or a reboot, check the ordering of
`hermes-egress.service` against `docker.service` (it must start after Docker and be restarted with it),
and see the open items in [egress-host-notes.md](egress-host-notes.md): persistence across restarts has
not been verified yet.

Never run production with `HERMES_EGRESS_POLICY=off`; the configuration refuses it. For local
development only, `HERMES_EGRESS_POLICY=off` skips the canary and the network name check.

## An instance fails with `network_policy_missing`

Its Docker network was created before this policy (no `hn` bridge name), or another network already
uses the same bridge name. Docker cannot rename a bridge, so delete and reprovision the instance
(there are no production tenants yet). The control plane never reuses such a network while the policy
is enforced.
