# Backups: scheduled, local and off-host

`ovhost backup --all --offsite` runs once a day from a systemd timer. It backs up every database
the inventory declares, keeps a week of daily and a month of weekly copies on the host, and uploads
an encrypted copy of each run to S3-compatible object storage (Backblaze B2). This page covers what it
does, how to install it, and how to restore from the off-host copy.

Restore drills (a second instance started from a backup and compared with production) are in
[restore-drills.md](restore-drills.md). A drill works on an off-host copy too: see
[Testing a restore](#testing-a-restore).

## What is backed up

`ovhost backup --all` backs up every service in the inventory (`/etc/openvibe/host.json`) that has
a `databases` list. With `host.example.json` that means:

| Service | Databases |
|---|---|
| network | `network.db` |
| live | `live.db` (includes the money ledger while `BILLING_AUTHORITY=live`), `rs-companion.db`. `data/analytics.db` is left out on purpose ([storage-state.md](storage-state.md): analytics, hard-coded path, not canonical). |
| media | `media.db` (the media files themselves are in B2/R2, not covered here) |
| tools | seven `apps/*/data/analytics.db`, and `jobs.db` for img, audio and docs |
| games | `world.db` |
| ai | `ai.db` |
| openre | `openre.db` |
| community, events, chat, billing, host, search, sources, wiki, blog, tips, vip, news, reviews, deals, coupons, trade, codes | one database each |

A database that does not exist yet (a service that is not deployed) is reported as `skipped` and
does not fail the run. Adding a database to the inventory is all it takes to include it.

## One run

For each service, one after another:

1. **Copy.** The SQLite online backup API (`better-sqlite3` `.backup()`) makes a consistent copy while
   the service keeps running. The copy is made by a worker running **as the service user**: root never
   opens a service database, because a root-owned `-wal`/`-shm` file would stop the service from
   writing its own database.
2. **Check.** The worker switches the copy to `journal_mode=DELETE`, which checkpoints it and removes
   its `-wal`/`-shm`, and runs `PRAGMA quick_check`. A copy that does not answer `ok` fails.
3. **Take over.** The worker writes into `/var/backups/openvibe.staging/<service>-<stamp>/`, which
   belongs to the service user. Root then takes that directory back (`root:root 0700`), so the service
   user can no longer reach it. Root checks that each copy is a plain file with one link, and makes it
   `root:root 0600`. It then renames the directory to `/var/backups/openvibe/<service>/<stamp>/`.
4. **Record.** The backup is appended to `/var/lib/openvibe-host/backups/<service>.jsonl`, with
   `ok: false` when any database failed.
5. **Prune** (see [Retention](#retention)).

**Permissions.** Backups hold user data. Every directory under `/var/backups/openvibe` is
`root:root 0700` and every copy is `root:root 0600`, with no `-wal`/`-shm` next to it. Directories left
by older versions (`ubuntu`, 0750) are locked down on the next run. The staging parent
`/var/backups/openvibe.staging` is `root:root 0711`, and each run removes its own staging directory.

**Failures.** A failing database never stops the other databases of the service, and a failing
service never stops the other services. The run's exit code is `2` when anything failed and `0`
otherwise. If a service fails halfway (one of two databases), the good copy is kept but the backup is
marked `ok: false`. Such a backup is never picked by a drill, and it is pruned once a newer good backup
exists.

**Summary.** Each run writes `/var/lib/openvibe-host/backup-runs/<run>.json` (`root`, 0640). It holds
per-service status, files, sizes, errors, what was pruned, and the off-host result: objects, bytes,
failures, and the key id. The summary never holds a secret. The run id is the start time in UTC, for
example `20260924-033412`.

```
sudo ovhost backup --all                 # local only
sudo ovhost backup --all --offsite       # what the timer runs
sudo ovhost backup --all --json          # the summary on stdout
sudo ovhost backup --all --keep-daily 14 --keep-weekly 8
sudo ovhost backup --all --no-prune
```

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
s3://<BACKUP_S3_BUCKET>/<BACKUP_S3_PREFIX>/<host>/<run>/<service>/<name>.db.ovbk
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

Nothing alerts on a failed run yet. The unit fails (exit 2) and the summary says `"ok": false`. Hook
an `OnFailure=` unit or the monitoring stack to that when one exists.

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
- runs `PRAGMA quick_check` on the result.

Any failure removes that file and exits non-zero. The output lists each file with its size, its hash,
`quick_check ok` and the production path it came from.

### 3. Put it in place (manual, one service at a time)

Take a fresh local backup of the current state first, even a broken one, so the restore can be undone.
Then stop the service, move its current database aside, install the copy as the service user's file,
and start the service again. For Live, check protected sessions first (`ovhost status live`). The
socket unit stays up, and only the service unit stops.

```
sudo ovhost backup live                                   # the state you are about to replace
sudo systemctl stop openvibe-live.service                 # never the .socket unit
cd /opt/openvibe.live/data
sudo mv live.db live.db.replaced-$(date -u +%Y%m%d-%H%M%S)
sudo rm -f live.db-wal live.db-shm                        # only after the service has stopped
sudo install -o ubuntu -g ubuntu -m 0640 /var/lib/openvibe-restore/live-20260924-033412/live.db live.db
sudo systemctl start openvibe-live.service
curl -s 127.0.0.1:3000/api/ready | jq .status
```

- Use the production path from the restore output (`was …`). The owner and mode must match the other
  files in that directory (`ls -l`).
- For services with a `StateDirectory` (`/var/lib/openvibe-*`), the directory is owned by the service
  user.
- Remove `/var/lib/openvibe-restore/<service>-<run>` when you are done: it holds user data.
- **Money.** `live.db` holds the ledger while `BILLING_AUTHORITY=live`. A restore loses every
  transaction made after the backup. Before any money action resumes, reconcile against the payment
  provider for the gap (see [cutover-runbook.md](cutover-runbook.md)). Consider setting the owner-only
  `money_writes_frozen` flag first.

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

The drill:
- copies the databases into its sandbox as the service user (`install -o <user> -m 0600`);
- runs `integrity_check`;
- starts a sandboxed second instance and compares it with production;
- stops it and cleans up.

Record the result in [restore-drills.md](restore-drills.md) and note "off-host" in the Backup column.

For services without a drill (live, media, tools, games, openre), download the copy and check it by
hand:

```
sudo ovhost restore-download live latest --out /var/lib/openvibe-restore/check-live
sudo sqlite3 -readonly /var/lib/openvibe-restore/check-live/live.db 'PRAGMA integrity_check; SELECT count(*) FROM users;'
sudo rm -rf /var/lib/openvibe-restore/check-live
```

(`sqlite3` is the Debian package of the same name. `restore-download` has already run `quick_check`;
this adds a full `integrity_check` and a look at the data.)

Do this at least once after installing, and again after any change to the key or the bucket.

## Commands

| Command | What it does | Exit |
|---|---|---|
| `ovhost backup --all [--offsite] [--no-prune] [--keep-daily n] [--keep-weekly n]` | back up every service with databases; prune; summary; optionally upload | 0 all ok · 1 lock/usage · 2 any failure |
| `ovhost offsite push [--run <run>]` | upload a run (default: the latest) again, for example after a failed upload | 0 · 1 config · 2 failure |
| `ovhost offsite list [<service>] [--from-host <h>]` | runs off-host, newest first | 0 · 1 config · 2 bucket error |
| `ovhost offsite check` | config, key and bucket access; uploads nothing | 0 · 1 config · 2 bucket error |
| `ovhost restore-download <service> <run\|latest> [--out <dir>] [--from-host <h>]` | download, verify and decrypt into a new root-only directory | 0 · 1 refused · 2 verification failed |

The offsite commands and `restore-download` need root. They take `--backup-env <file>`, whose default
is `/etc/openvibe/backup.env` (or `$OVHOST_BACKUP_ENV`).
