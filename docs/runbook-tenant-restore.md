# Runbook: restoring a customer's instance data

How to bring back the data of a deleted (or broken) instance from its volume backup.

**Status (2026-11-21):** rehearsed once on production with the owner's test instance "Asistant nibie 1" (deleted by the
billing lifecycle test, restored into a new free instance in about 1 minute). That run also found that no tenant snapshot
held the SQLite databases (`state.db`: conversation history and search, `kanban.db`, `response_store.db`); fixed in
`hermes-tenant-backup.sh` the same day. Snapshots taken before the fix restore everything except those databases.

## 1. What is backed up

- `hermes-tenant-backup` (timer, every day at 20:00 UTC) backs up every volume `hermes-data-<instance uuid>` to the restic
  repository on Cloudflare R2, encrypted by restic. SQLite files are copied first with SQLite's online backup API into
  `/var/lib/hermes-backup-staging/<uuid>` (consistent while the agent writes) and backed up from there; the live `*.db` files are
  skipped. After each backup the script checks that the snapshot holds as many databases as it copied, or the run fails.
- Snapshots are tagged `tenant-vol` and `inst-<uuid>`. Retention: 7 days per instance, also after the instance was deleted.
- Not in a backup: provider keys and Telegram tokens (environment variables, ADR 0003) and anything newer than the snapshot.

## 2. Find the snapshot

```bash
sudo bash -c 'set -a; . /etc/restic/r2/env; set +a; restic snapshots --tag inst-<old instance uuid> --compact'
```

Pick the newest snapshot from before the problem. A deleted instance has at most 7 days of snapshots left.

## 3. Restore

1. Create the target instance for the **same tenant**:
   - the customer deploys one in the dashboard, or
   - the operator API creates it (free plan shown; a priced plan made this way has no subscription):
     ```bash
     T=$(sudo grep -E '^ADMIN_TOKEN=' /etc/hermes-cloud/backend.env | cut -d= -f2-)
     curl -sS -X POST -H "authorization: Bearer $T" -H 'content-type: application/json' \
       -H "idempotency-key: restore-<old uuid>" -d '{"name":"<name>","planId":"<plan id>"}' \
       http://127.0.0.1:3000/api/v1/tenants/<tenant uuid>/instances
     ```
   Wait until it is ACTIVE; a free instance also gets its NibieRouter key within about 15 seconds.
2. Run the restore (it stops the target, copies, fixes ownership and starts it again):
   ```bash
   sudo /usr/local/sbin/hermes-tenant-restore <snapshot> <old instance uuid> <tenant uuid> <target instance uuid>
   ```
   The target keeps its own `config.yaml` and `.env` (its model and key settings); everything else comes from the snapshot.
3. Check: the instance is ACTIVE in the admin panel, and the customer sees their agent (SOUL, skills, sessions).
4. Tell the customer to reconnect Telegram and their own provider key if they used one, and that changes after the snapshot
   time are lost.

## 4. Install

```bash
sudo install -m 0755 /opt/hermes-cloud/ops/host/hermes-tenant-backup.sh /usr/local/sbin/hermes-tenant-backup
sudo install -m 0755 /opt/hermes-cloud/ops/host/hermes-tenant-restore.sh /usr/local/sbin/hermes-tenant-restore
```
