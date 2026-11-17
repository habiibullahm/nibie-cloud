# Disk quota host notes

Results of the host verification spike (disk quota plan, Task 1). Every line says where it was
observed. Nothing here has been verified on an XFS host with project quotas yet.

## Observed (cloud sandbox, Docker 29.9.2, Engine API 1.56, ext4, no project quota)

- `POST /volumes/create` with `{"Driver":"local","DriverOpts":{"size":"64m"}}` is rejected with
  HTTP 400 and the message `create <name>: quota size requested but no quota support`. So the volume
  size is the top-level `size` driver option, and Docker refuses at create time on a filesystem
  without quota support. This is the signature `isQuotaUnsupported` matches.
- `--opt o=size=64m` is not the quota option: for the local driver it is a mount option and fails with
  `missing required option: "device"`.

- `GET /system/df?type=volume` returns `Volumes[]` with `Labels` and `UsageData.Size` for local
  volumes. A 5 MiB file written into a volume was reported as exactly 5242880 bytes, and unlabeled
  volumes are skipped by `volumeUsage()`. With dockerode, put the query in the modem `options`
  (`path: '/system/df?'`, `options: { type: 'volume' }`): a query string written into `path` is mangled.

## Not yet verified (needs an XFS host with `prjquota`)

- That `size` produces a working limit: a 100 MB write into a 64 MB volume stops with
  `No space left on device` near 64 MB.
- What `docker volume inspect` shows in `Options` for a sized volume (the parser assumes `size` with a
  `k`, `m` or `g` suffix, or plain bytes).
- How long the volume df call takes with about 10 populated volumes, and that `UsageData.Size` behaves
  the same on an XFS quota volume.
- Behaviour under `runsc`.

## Growing an existing volume (not verified; draft for the 1 GB to 5 GB change of 2026-11-17)

A volume's quota is set once, when Docker creates it, so a plan change (`deploy/sql/2026-11-17-storage-5gb.sql`) only
reaches new instances. On an XFS host with `prjquota`, Docker's local driver gives each sized volume an XFS project; the
limit of that project can be raised in place, without stopping the container. Expected steps on the VPS, to be checked
on the host before use:

```bash
# 1. The volume of one instance (names derive from the instance id only)
V=hermes-data-<instanceId>
D=$(sudo docker volume inspect -f '{{ .Mountpoint }}' "$V")
# 2. Its XFS project id, and the mount point of the filesystem that holds it
P=$(sudo xfs_io -c lsproj "$D" | awk '{print $NF}')
M=$(df --output=target "$D" | tail -1)
# 3. Raise the hard limit to 5 GiB and check it
sudo xfs_quota -x -c "limit -p bhard=5120m $P" "$M"
sudo xfs_quota -x -c "report -p -h" "$M" | grep -w "$P"
```

`docker volume inspect` keeps showing the old `size` option afterwards, so the backend still records
`disk.quota_mismatch` for that volume; the event is informational. The alternative that needs no host step is to delete
the instance and create a new one, which loses its data.
