# Capacity: when to grow the server

Owner question of 2026-11-17: what does 100 users need? The numbers below are an **estimate**, to be replaced by the
measurements this repository now records.

## Measured so far

- Host: 4 vCPU, 15.5 GB RAM, 217 GB disk; tenant volumes on a 100 GB XFS image (quota per instance from `Plan.storageMb`).
- One idle tenant container (plan 1 CPU, 1 GB, gVisor): about 240 MB RAM and under 1 % CPU. Busy behaviour is **not** measured yet.

## Estimate for 100 users on one server

RAM 64 GB (100 x about 0.5 GB average plus about 6 GB for the system, backend, Redis, Caddy and the owner's own agent), 16 vCPU (8 minimum;
agents mostly wait for the model), disk 300 GB, normal outbound bandwidth. 32 GB suits roughly 40 to 50 users. Several servers are only
worth it above roughly 200 users; node scheduling is not built (separate milestone).

## How it is measured

`ops/host/hermes-usage.sh` (systemd timer every 5 minutes, install like the other host scripts) appends one row per running tenant container and
one host row to `/var/log/hermes-usage.csv`: `ts_utc,kind,name,cpu_pct,mem_mb,mem_limit_mb`. Host rows carry the 1-minute load average in
`cpu_pct`. The file is rotated weekly (12 kept). A quick look at the busiest hour per container:

```bash
sudo awk -F, '$2=="tenant" {if ($5>m[$3]) m[$3]=$5} END {for (k in m) print m[k], k}' /var/log/hermes-usage.csv | sort -rn | head
```

Rule of thumb for the decision: grow the server when the sum of the peak memory of all instances reaches 70 % of host RAM, or the host
load stays above the number of cores for an hour.
