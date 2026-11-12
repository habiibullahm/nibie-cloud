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
