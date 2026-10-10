# Backups: scheduled, local and off-host

`ovhost backup --all --offsite` runs once a day from a systemd timer. It backs up every database
the inventory declares, keeps a week of daily and a month of weekly copies on the host, and uploads
an encrypted copy of each run to S3-compatible object storage (Backblaze B2). The cluster is covered by pgBackRest, which every run verifies, with a per-service logical dump on a slower cadence. This page covers what it does, how to install it,
and how to restore from the off-host copy.

Restore drills (a second instance started from a backup and compared with production) are in
[restore-drills.md](restore-drills.md). A drill works on an off-host copy too: see
[Testing a restore](#testing-a-restore).

## What is backed up

Every inventory database is PostgreSQL. `ovhost backup --all` verifies the cluster's pgBackRest backups and WAL archiver on every run. It makes a per-service `pg_dump -Fc` when the last good logical dump is over seven days old or when `--logical` is given. Declared content-addressed object directories are archived as `.tar.gz` files. Restore drills use the logical dumps and object archives.

## One run

Run `sudo ovhost backup --all --offsite`. A failed pgBackRest or WAL check is recorded as a failure. A run with no dump due and no object directories records successful verification without creating an artifact directory. Backup artifacts are root-owned, with 0700 directories and 0600 files; `pg_dump` writes into a postgres-owned staging directory before root takes ownership. The off-site uploader encrypts artifacts before upload.

## PostgreSQL services

A PostgreSQL service's data does not live in a file ovhost can copy. It lives in the host's cluster, so
ovhost does not make the durability layer — [pgBackRest](#pgbackrest-is-the-durability-layer) already
does — it **verifies** that layer on every run, and takes a per-service logical dump on a slower cadence
for restores and drills. Everything runs as the `postgres` OS user over peer auth
(`local postgres peer` in `roles/data/files/pg_hba.conf`), so ovhost still reads no service env value.

**Every night: verify pgBackRest.** Before anything else, the run asks pgBackRest about the whole-cluster
stanza (`runuser -u postgres -- pgbackrest --stanza=openvibe info --output=json`). Two conditions must
hold:

- the stanza's newest backup **stopped within 26 hours** and the stanza **status is ok** (newest first,
  whatever its type);
- `pg_stat_archiver.failed_count` has **not increased** since the last run. The last value ovhost saw is
  kept in `<stateDir>/pgbackrest-archiver.json`, and each run compares against it, so a WAL segment that
  failed to archive is caught even though it is not visible in a single night's snapshot.

The result is recorded per service in `<stateDir>/backups/<svc>.jsonl` as `verified: { type, stop, walOk }`.
A **failed verification** makes that service's status `failed` — never `skipped` — so `ovhost backup --all`
exits `2`, `openvibe_backup_last_run_ok` goes to `0` and `OpenVibeBackupFailed` pages. A run where every
PostgreSQL service only verified is `verified` in the summary.

**Weekly, or on demand: the logical dump.** A `pg_dump -Fc` of each of the service's databases is taken
when the last good dump is older than **7 days**, or on any run with `--logical`. It lands in the existing
layout, one file per database:

```
/var/backups/openvibe/<service>/<stamp>/<name>.dump      # pg_dump -Fc, owned root:root 0600
```

The off-site code encrypts and uploads each `.dump`, so the archive
reaches the bucket as `<service>/<name>.dump.ovbk` and is restored by `restore-download` unchanged.
`pg_restore --list` proves a `.dump` is a readable archive.

**Metrics and alerts.** The run rewrites `/var/lib/prometheus/node-exporter/openvibe_backup.prom` for
node_exporter's textfile collector:

- `openvibe_backup_pg_verified{service}` — `1` when that PostgreSQL service's last verification passed,
  `0` when it failed;
- `openvibe_pgbackrest_last_backup_age_seconds` — the age of the stanza's newest backup (gauge, seconds);
- `openvibe_backup_services{status}` gains the value `verified` (a service with a verification-only run).

`deploy/prometheus/openvibe-rules.yml` reads those:

- `DataBackupStale` fires when `openvibe_pgbackrest_last_backup_age_seconds` is over **30 hours**, or the
  metric is absent (no run has written it). It is the cluster staleness alert; the per-service
  `openvibe_backup_pg_verified` says which service's verification failed.
The rules live in [`deploy/prometheus/openvibe-rules.yml`](../deploy/prometheus/openvibe-rules.yml).

### pgBackRest is the durability layer

It backs up the whole cluster — encrypted, off-host, with point-in-time recovery: a full backup every
Sunday, a differential nightly, and the WAL stream. The per-service `.dump` files are **not** the
durability layer; they are smaller, service-scoped, portable restore units (a logical archive survives a
PostgreSQL major-version change, and it is what the drills restore and compare). Losing the cluster is
recovered from pgBackRest; losing one service's rows, or drilling a service, uses its `.dump`.

## Retention

**On the host** (per service). Kept: the newest good backup of each of the last **7 days** that have
one, and the newest good backup of each of the last **4 ISO weeks** that have one. Everything else is
pruned, with three safeguards:

- Only directories named by a stamp and recorded in the service's `.jsonl` are ever pruned. A
  directory you copied in by hand is never touched.
- Days and weeks without a good backup do not use up a slot. A service whose backups have been failing
  for a month still keeps its last good ones.
- A failed backup is removed only once a newer good one exists.

**Off-host.** A run is deleted **30 days** after its run id (`BACKUP_OFFSITE_RETENTION_DAYS`) by
`ovhost` itself. This only happens after a run that uploaded everything, and the newest 7 runs with a
manifest are always kept. Failing uploads therefore never let the last good off-host copies age out.
To leave deletion to a bucket lifecycle rule instead, set `BACKUP_OFFSITE_PRUNE=0` (see
[Bucket](#bucket-backblaze-b2)).

## Off-host copies

### Layout

```
s3://<BACKUP_S3_BUCKET>/<BACKUP_S3_PREFIX>/<host>/<run>/<service>/<name>.dump.ovbk   # a PostgreSQL dump
s3://<BACKUP_S3_BUCKET>/<BACKUP_S3_PREFIX>/<host>/<run>/manifest.json
```

`<host>` is the inventory's `host` (`openvibe-oregon`), or the machine's hostname if the inventory has
none.

- Every `.ovbk` object is encrypted on the host before upload. Files are streamed:
  - read,
  - hashed,
  - encrypted,
  - uploaded, in one `PutObject` below 64 MiB, or as a multipart upload in 64 MiB parts.
  
  Nothing extra is written to disk, and memory use is about one part.
- `manifest.json` is uploaded last and is not encrypted. It holds:
  - service and file names and source paths;
  - plaintext and ciphertext sizes and SHA-256 hashes;
  - the key id;
  - any upload failures;
  - an HMAC-SHA256 over the manifest, made with a key derived from the backup key.
  
  It holds no data and no secret. `restore-download` refuses a manifest whose HMAC does not verify, and
  a file whose hashes do not match it. This catches a swapped or rolled-back object, not only a
  corrupted one.

### Encryption format (OVBKAES1)

Node's built-in `crypto` does the encryption: AES-256-GCM over 1 MiB chunks. The implementation is
in `lib/backup-crypto.js`. Integers are big-endian.

| Offset | Bytes | Field |
|---|---|---|
| 0 | 8 | magic `OVBKAES1` |
| 8 | 4 | chunk size C (plaintext bytes per chunk; ovhost writes 1 MiB) |
| 12 | 32 | salt, random per file |
| 44 | 8 | key id: `HMAC-SHA256(master, "openvibe-backup key-id v1")`, first 8 bytes |
| 52 | … | chunks: each is ciphertext (C bytes; the last one 0..C) followed by its 16-byte GCM tag |

- The file key is `HKDF-SHA256(master, salt, "openvibe-backup v1 file key")`, 32 bytes.
- The nonce of chunk *i* is 11 bytes of *i* (big-endian), then one flag byte: `1` on the last chunk,
  `0` on the others.
- Every chunk's AAD is the 52 header bytes.
- The last chunk is always present, even when it is empty.

Because of this format:
- a changed byte fails authentication;
- truncation fails, because the last remaining chunk lacks the final flag;
- appended data fails;
- an edited header fails;
- a file encrypted with another key is reported by its key id.

The manifest HMAC key is `HKDF-SHA256(master, "", "openvibe-backup v1 manifest")`.

### The key

The encryption key is 32 random bytes in a root-only file on the host. ovhost refuses the key file,
and the env file, unless they are owned by root and not readable by group or others.

**The key must also exist somewhere other than this host.** If the host is lost, the key is lost
with it, and every off-host copy becomes unreadable. Keep one copy offline, for example in the owner's
password manager, or on paper in a safe. Never put a copy in the bucket, and never put one in a
repository. `ovhost offsite check` prints the key id. Write that id next to the escrowed copy, so you
can match the copy to its backups later.

## Installing on the host (operator)

Run these as root on the host. They install nothing system-wide beyond what ovhost already has:
the S3 client is an npm dependency of OpenVibe.Host (`@aws-sdk/client-s3`, the same client Media uses).

1. **Update ovhost** (from the Host README's install layout):
   ```
   cd /usr/local/lib/openvibe-host
   sudo git pull --ff-only
   sudo npm ci --omit=dev --no-audit --no-fund
   sudo git checkout -- package-lock.json   # only if npm rewrote it (npm 9 on the host)
   ovhost --help | grep -q 'backup --all' && echo ok
   ```
2. **Bucket and key** (Backblaze web UI or `b2` CLI; see [Bucket](#bucket-backblaze-b2)):
   - a private bucket, for example `openvibe-backups` (not Media's bucket);
   - an application key restricted to that bucket.
3. **Encryption key**, generated on the host and escrowed off it:
   ```
   sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/openvibe/backup.key'
   sudo chown root:root /etc/openvibe/backup.key && sudo chmod 0600 /etc/openvibe/backup.key
   sudo cat /etc/openvibe/backup.key        # copy it into the password manager now, then clear the screen
   ```
4. **Env file** `/etc/openvibe/backup.env` (root:root 0600):
   ```
   sudo install -o root -g root -m 0600 /dev/null /etc/openvibe/backup.env
   sudoedit /etc/openvibe/backup.env
   ```
   ```
   BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   BACKUP_S3_BUCKET=openvibe-backups
   BACKUP_S3_PREFIX=openvibe-backups
   BACKUP_S3_KEY_ID=<application key id>
   BACKUP_S3_SECRET=<application key>
   BACKUP_ENCRYPTION_KEY_FILE=/etc/openvibe/backup.key
   # optional
   # BACKUP_S3_REGION=us-west-004          (derived from a B2 endpoint; else us-east-1)
   # BACKUP_S3_FORCE_PATH_STYLE=1          (default 1; B2 wants path-style)
   # BACKUP_OFFSITE_RETENTION_DAYS=30
   # BACKUP_OFFSITE_PRUNE=1                (0 when a bucket lifecycle rule deletes old runs)
   ```
   Use the endpoint and region of the bucket's own B2 region. Media's `MEDIA_B2_ENDPOINT` shows the
   format. Media's bucket and key are separate, and are not reused here.
5. **Check** that the config, the key and the bucket work, and do a first run by hand:
   ```
   sudo ovhost offsite check
   sudo ovhost backup --all --offsite       # exit 0; prints one line per service and the OFFSITE line
   sudo ovhost offsite list
   ```
6. **Timer:**
   ```
   sudo install -o root -g root -m 0644 deploy/systemd/openvibe-backup.service deploy/systemd/openvibe-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now openvibe-backup.timer
   systemctl list-timers openvibe-backup.timer
   ```
   (Run these from `/usr/local/lib/openvibe-host`.) The timer fires daily at 03:30 UTC, up to 15 minutes
   later (`RandomizedDelaySec`). A run missed while the host was down happens at the next boot
   (`Persistent=true`). To run one now: `sudo systemctl start openvibe-backup.service`.
7. **Disk.** Local retention keeps up to 11 copies of every database. Check the space before the first
   week fills up: `sudo du -sh /var/backups/openvibe/*` against `df -h /var/backups`. If space is tight,
   lower `--keep-daily`/`--keep-weekly` in the unit's `ExecStart`.

### Watching it

```
systemctl status openvibe-backup.service           # last result: exit 0, or status=2/INVALIDARGUMENT on a failure
journalctl -u openvibe-backup.service --since today
sudo ls -t /var/lib/openvibe-host/backup-runs | head -1
sudo jq '{ok, services: [.services[] | {service, status, error}], offsite: {ok: .offsite.ok, failures: .offsite.failures}}' /var/lib/openvibe-host/backup-runs/<run>.json
```

The monitoring stack alerts on it (all in `deploy/prometheus/openvibe-rules.yml`):
`OpenVibeBackupFailed` pages when the last run failed, `OpenVibeBackupMissed` when no run has succeeded
for 30 hours, and `DataBackupStale` when pgBackRest itself is stale. The unit also fails (exit 2) and the summary says
`"ok": false`.

### Bucket (Backblaze B2)

- **Private** bucket, used for backups only, in a different account or bucket from Media's content.
- **Application key**, restricted to this bucket. It needs `listFiles`, `readFiles` and `writeFiles`,
  plus `deleteFiles` when ovhost prunes (`BACKUP_OFFSITE_PRUNE=1`, the default).
- **Lifecycle.** B2 keeps old versions by default: a delete through the S3 API only *hides* the file.
  Add a lifecycle rule on the prefix with `daysFromHidingToDeleting: 1`, so pruned runs really go. In
  the UI this is "Keep only the last version of the file".
- **Stronger option** against a compromised host deleting its own backups:
  - give the key no `deleteFiles`;
  - set `BACKUP_OFFSITE_PRUNE=0`;
  - let the lifecycle rule delete old runs: `daysFromUploadingToHiding: 30`,
    `daysFromHidingToDeleting: 1`.
  
  You can also enable Object Lock on the bucket with a 30-day retention. The trade-off is that the
  "always keep the newest 7 runs" safeguard no longer applies, because the bucket deletes by age alone.

## Restoring from an off-host copy

`ovhost restore-download` only downloads, verifies and decrypts. **It never writes into a live
database, a service checkout or a database directory**, and it never overwrites anything:
- the target directory must not exist, or must be empty;
- the target must not overlap any declared database directory, checkout, `/var/backups/openvibe` or
  `/var/lib/openvibe-host`;
- every file is created exclusively.

Putting a copy in place is a separate, manual step.

### 1. Find the run

```
sudo ovhost offsite list                  # every run, newest first
sudo ovhost offsite list live             # runs that include live
```

### 2. Download, verify and decrypt

```
sudo ovhost restore-download live latest
sudo ovhost restore-download live 20260924-033412
sudo ovhost restore-download live 20260924-033412 --out /var/lib/openvibe-restore/live-before-incident
```

The default target is `/var/lib/openvibe-restore/<service>-<run>/` (`root:root 0700`, files `0600`).
For each file, the command:

- checks the manifest's HMAC;
- streams the object through GCM decryption;
- checks both SHA-256 hashes against the manifest;
- runs `pg_restore --list` on each `.dump`.

Any failure removes that file and exits non-zero. The output lists each file with its size, its hash,
its check and the production path it came from.

### 3. Restore a service database

Use `pg_restore` from the downloaded `.dump` into a new PostgreSQL database, then point the service's `DATABASE_URL` and `DATABASE_DIRECT_URL` at it. Check the application before changing production settings. `ovhost drill` automates a scratch restore and comparison without changing the production database.

### Disaster recovery: a new host

The bucket, the escrowed key and this repository are enough.

1. Install ovhost as in the Host README.
2. Copy `host.example.json` to `/etc/openvibe/host.json` (root:root 0640).
3. Write `/etc/openvibe/backup.key` from the escrowed copy (root:root 0600), and check that
   `sudo ovhost offsite check` prints the same key id.
4. Write `/etc/openvibe/backup.env`.
5. The new machine has another hostname, so name the old host explicitly:
   ```
   sudo ovhost offsite list --from-host openvibe-oregon
   sudo ovhost restore-download live latest --from-host openvibe-oregon
   ```
6. Deploy each service's checkout and unit, and put each database in place as in step 3, before its
   first start.

## Testing a restore

A restore is proven only when a restored copy runs. The downloaded directory has the same file names
as a local backup, so a restore drill can use it directly (for services with a drill block):

```
sudo ovhost backup --all --offsite                        # a fresh run, so counts match production
sudo ovhost restore-download community latest --out /var/lib/openvibe-restore/drill-community
sudo ovhost drill community --backup /var/lib/openvibe-restore/drill-community
sudo rm -rf /var/lib/openvibe-restore/drill-community
```

The drill verifies each PostgreSQL dump with `pg_restore --list`, restores it into a scratch database, compares the second instance with production, and drops the scratch database and role. For a service without a supported drill, verify the downloaded `.dump` with `pg_restore --list` before a manual scratch restore.

Do this at least once after installing, and again after any change to the key or the bucket.

## Commands

| Command | What it does | Exit |
|---|---|---|
| `ovhost backup --all [--offsite] [--logical] [--no-prune] [--keep-daily n] [--keep-weekly n]` | back up every service with databases or object directories (verify pgBackRest, dump PostgreSQL when due or `--logical`, archive object directories); prune; summary; optionally upload | 0 all ok · 1 lock/usage · 2 any failure |
| `ovhost offsite push [--run <run>]` | upload a run (default: the latest) again, for example after a failed upload | 0 · 1 config · 2 failure |
| `ovhost offsite list [<service>] [--from-host <h>]` | runs off-host, newest first | 0 · 1 config · 2 bucket error |
| `ovhost offsite check` | config, key and bucket access; uploads nothing | 0 · 1 config · 2 bucket error |
| `ovhost restore-download <service> <run\|latest> [--out <dir>] [--from-host <h>]` | download, verify and decrypt into a new root-only directory | 0 · 1 refused · 2 verification failed |

The offsite commands and `restore-download` need root. They take `--backup-env <file>`, whose default
is `/etc/openvibe/backup.env` (or `$OVHOST_BACKUP_ENV`).
