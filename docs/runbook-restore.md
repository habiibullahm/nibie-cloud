# Runbook: database backups and restore

How the Nibie Cloud database is backed up, how to check it, and how to put the `hermes` schema back from a dump.

**Status (2026-11-20):** backups and the restore drill are proven on the VPS (see `CURRENT_STATE.md`). The production restore
in section 4 has **not been rehearsed**. Read it fully before you start, and rehearse it on a throwaway database first when
there is time.

## 1. What is backed up

- **Where the data lives:** Supabase Postgres. The backend's tables are in schema `hermes`; sign-in accounts are in schema
  `auth`, which Supabase Auth owns.
- **Daily dump:** `hermes-db-backup` (installed on the VPS at `/usr/local/sbin/hermes-db-backup`, not in this repository) runs
  `pg_dump` of the schemas `hermes` and `auth` in custom format into `/var/backups/hermes-cloud/hermes-<UTC time>.dump`. It runs
  every day at 19:00 UTC (03:00 on the VPS clock) and before every `deploy.sh`. It keeps the newest 14 dumps.
- **Copy to R2:** `hermes-db-offsite` copies the newest dump into the restic repository on Cloudflare R2 at 19:30 UTC, with tag
  `nibie-cloud-db`. It keeps 14 daily and 8 weekly snapshots. restic encrypts on the VPS.
- **Weekly drill:** `hermes-restore-drill --from-r2` restores the newest R2 snapshot into a throwaway Postgres container with no
  network every Sunday at 20:00 UTC and checks that the core tables have rows.
- **Alerts:** `hermes-watchdog` (every minute) sends a Telegram message in these cases:
  - the newest local dump is older than 26 hours;
  - the last successful R2 upload is older than 26 hours;
  - the restore drill unit has failed;
  - where `hermes-tenant-backup.timer` is enabled: the last tenant volume backup run with no failed volume
    (`done: N ok, 0 failed` in `/var/log/hermes-tenant-backup.log`) is older than 26 hours;
  - `hermes-tenant-verify` or `hermes-tenant-retention` has failed.

  It sends a second message when the problem is gone.

**The keys to R2:** the R2 credentials and the restic password are only in `/etc/restic/r2/env` and the password file it
names. Without the restic password, the R2 snapshots cannot be read. Keep a copy of both in the password manager, outside the
VPS.

## 2. Daily or weekly check

On the VPS (`ssh nibie-cloud`):

```bash
systemctl list-timers "hermes-db-*" --no-pager                                    # LAST under 25 hours
sudo grep -E "OK: uploaded|ERROR" /var/log/hermes-db-offsite.log | tail -5        # last line: OK: uploaded <last night's dump>
journalctl -u hermes-restore-drill -n 10 --no-pager                               # last Sunday: restore drill OK
```

`Load(<lock/...>) ... The specified key does not exist` lines in the offsite log come from the prune and check step after the
upload. They are harmless when an `OK: uploaded` line is there.

## 3. Test a restore without touching production

```bash
sudo /usr/local/sbin/hermes-restore-drill --from-r2; echo "exit=$?"   # newest R2 snapshot
sudo /usr/local/sbin/hermes-restore-drill; echo "exit=$?"             # newest local dump
```

The run passes when it prints `restore drill OK`, `exit=0`, and row counts that are not 0. It uses only its own container
(`hc-restore-drill`) and a temporary directory.

## 4. Restore production (`hermes` schema)

Use this only when the `hermes` data is wrong or lost, for example after a bad manual change or a broken migration. Everything
the platform wrote after the dump is lost: payments, wallet entries, new instances, provider and Telegram settings.

This runbook never restores `auth`: Supabase Auth owns that schema. If the whole Supabase project is lost, start from Supabase's
own backups (Supabase dashboard, Database, Backups) and ask for help. The `auth` rows in our dump are a last resort only.

### 4.1 Choose the dump

- **Local:** `ls -lt /var/backups/hermes-cloud/ | head`. Pick the newest dump from before the damage.
- **From R2:** use this when the VPS copy is gone or too new.

  ```bash
  sudo -i
  set -a; . /etc/restic/r2/env; set +a
  restic snapshots --tag nibie-cloud-db
  restic restore <snapshot id> --target /root/restore
  find /root/restore -name 'hermes-*.dump'
  ```

Write down the dump's UTC time; you need it in 4.5.

### 4.2 Stop everything that writes

```bash
sudo systemctl stop hermes-watchdog.timer hermes-pull-deploy.timer hermes-db-backup.timer hermes-db-offsite.timer
sudo /usr/local/sbin/hermes-db-backup     # a dump of the damaged state, kept for later comparison
sudo docker compose --env-file /etc/hermes-cloud/backend.env -f /opt/hermes-cloud/deploy/compose.prod.yaml stop backend
```

The watchdog must be stopped first: it restarts a backend that does not answer.

### 4.3 Restore the `hermes` schema

In a root shell (`sudo -i`). The database URL is read from the env file and passed to the container by name, never on a
command line:

```bash
url=$(grep -m1 '^DATABASE_URL=' /etc/hermes-cloud/backend.env | cut -d= -f2- | tr -d "\"'\r")
export PGURL=${url%%\?schema=*}
DUMP=/var/backups/hermes-cloud/hermes-<UTC time>.dump      # or the file found under /root/restore
docker run --rm -i --network host -e PGURL postgres:17 \
  sh -c 'pg_restore -d "$PGURL" --schema=hermes --clean --if-exists --no-owner --no-privileges --single-transaction' < "$DUMP"
echo "exit=$?"
```

`--single-transaction` means that a failure changes nothing: fix the cause and run it again. `pg_restore` needs a direct or
session-mode connection; the daily `pg_dump` uses the same URL, so it should work.

Check that row level security is still on for every table. The query must return no rows:

```bash
docker run --rm --network host -e PGURL postgres:17 sh -c 'psql "$PGURL" -Atc "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = '"'"'hermes'"'"' and c.relkind = '"'"'r'"'"' and not c.relrowsecurity"'
exit
```

### 4.4 Start again

As `ubuntu`, not root:

```bash
/opt/hermes-cloud/ops/host/deploy.sh      # dump, build, apply migrations newer than the dump, start, wait for /readyz
sudo systemctl start hermes-watchdog.timer hermes-pull-deploy.timer hermes-db-backup.timer hermes-db-offsite.timer
```

Check the admin panel (Ringkasan, Pelanggan, Instance) against what you expect.

### 4.5 Repair what happened after the dump

- **Payments:** in the SumoPod dashboard, Payments tab, find the orders completed after the dump time. Resend their webhooks
  (`runbook-payments.md`, playbook A). Each order is then applied again, exactly once.
- **Instances created after the dump:** their containers and volumes still run, but the database does not know them. List them
  with `sudo docker ps -a --filter name=hermes-` and compare with the admin Instance page. Do not delete a volume: it holds the
  customer's data. Ask the customer, then decide.
- **Customers who signed up after the dump:** they are still in `auth`, but their tenant is gone. Check what the dashboard shows
  them before you tell them anything.
- **NibieRouter:** router users and keys made after the dump still exist at the router, and the provisioning rows are gone. The
  billing tick may report `orphan_key`; see `setup.md`, "NibieRouter key and credit".

Then record the restore in `CURRENT_STATE.md`: the time, the dump, the reason, and what was repaired.
