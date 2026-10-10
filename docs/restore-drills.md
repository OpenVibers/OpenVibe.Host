# Restore drills (roadmap Wave 22)

A drill restores a service's database from its latest `ovhost backup`, starts a second instance of the
service on a spare loopback port against the restored copy, and compares its answers with production.
The production instance is never touched.

The inventory `drill` block maps each database to its `DATABASE_URL` and `DATABASE_DIRECT_URL` setting. A drill selects the newest good logical dump, checks it with `pg_restore --list`, restores it into a scratch database under a temporary role, and starts a sandboxed second instance. It compares declared HTTP paths and row counts, stops the instance, and drops the scratch database and role.

## R2 eviction drills (Media's hot cache)

`scripts/r2-eviction-drill.js` in OpenVibe.Media evicts one VOD's R2 hot-cache copy and proves that the canonical B2 copy serves it, then puts the R2 copy back (docs/object-model.md#r2-eviction-drill there). It refuses unless the B2 and R2 copies match in size and first MiB, and unless the VOD is unheld and not recording.

| Date (UTC) | VOD | Steps | Result |
|---|---|---|---|
| 2026-09-25 18:55 | 2178 (3.5 MB, `--pick --max-mb 200`, real `GET /v/2178?raw=1`) | before: served from R2 · evict: R2 copy removed, row → b2 · from B2: served from the canonical copy with the same first MiB · re-warm: R2 copy restored from B2 (HEAD verified), row → r2 · after: served from R2 again; `media_locations` b2 and r2 present. Artifact `/opt/openvibe.media/data/drills/r2-eviction-2178-2026-09-25T18-55-13-212Z.json` | passed |

## Drilling an off-host copy

Scheduled backups and their encrypted off-host copies are described in [backups.md](backups.md).
To drill a copy from the bucket, not the local disk, download it first. The directory
`restore-download` writes has the layout `--backup` expects:

```
sudo ovhost restore-download community latest --out /var/lib/openvibe-restore/drill-community
sudo ovhost drill community --backup /var/lib/openvibe-restore/drill-community
sudo rm -rf /var/lib/openvibe-restore/drill-community
```

Record the run id and that the copy came from off-host storage.

## Running a drill with `ovhost drill`

Run `sudo ovhost drill <service>` or pass `--backup <absolute directory>` to select a copy. The service must have a supported drill block and an unused loopback port. PostgreSQL drills require URL mappings for every declared database and a `VALKEY_URL` override so the drill cannot write into production.

### A PostgreSQL drill

A service whose `databases[]` entry is `engine: postgresql` ([db-inventory.md](db-inventory.md)) restores a **logical dump**:

1. **Restore.** The drill takes the service's newest `<name>.dump` (`pg_dump -Fc`, from
   `<stateDir>/backups/<service>.jsonl`, or the `--backup <dir>` directory) and creates a scratch
   database `ov_<id>_drill_<stamp>` owned by a **freshly created login role** `ov_<id>_drill_<stamp>`,
   whose password is generated with `crypto.randomBytes` and never printed. It then runs
   `pg_restore --no-owner --no-privileges --role=<drill role>` into that database: `--no-owner` because the
   archive names the production role, `--no-privileges` so none of the archive's GRANTs hands a production
   role anything, `--role` so every object ends up owned by the scratch role the drilled instance connects
   as. Before restoring, scratch databases and roles an earlier, killed drill of the same service left
   behind (`ov_<id>_drill_*`) are dropped, and every drop uses `dropdb --force`.
2. **Start.** `drill.env` overrides the three values the drilled release would otherwise take from
   production:
   - `DATABASE_URL` and `DATABASE_DIRECT_URL` — the scratch database on `127.0.0.1:5432`;
   - `VALKEY_URL=redis://127.0.0.1:9/0` — a closed port.

   The drill **refuses to start** if any of the three would keep its production value. They are not
   optional, because the sandbox runs the release's real boot path:
   - **`DATABASE_DIRECT_URL` un-overridden would migrate production.** The release runs its migrations
     from the direct URL at boot, and a drill is deliberately pointed at a copy precisely so that boot
     can run them there.
   - **`VALKEY_URL` un-neutralised would write into the production keyspace.** The drill sandbox allows
     loopback (services need Network's public keys there), so a Valkey URL left at production would let
     the second instance write locks, caches and queues into production's keyspace.
   - **`DATABASE_URL` un-overridden would serve production data.** The drilled instance would read and
     write the live database instead of the restored copy, and every comparison would be vacuous.
3. **Compare.** `counts` are read from production and from the scratch database over `psql`. `countsTolerance` in the drill block (default `0`) is the number of rows that
   may differ: production keeps writing between the read that makes the backup and the read that counts
   it, so a busy table is allowed to drift by that many rows instead of failing the drill.

The connection is `127.0.0.1:5432`, the cluster itself, and deliberately **not PgBouncer's 6432**:
PgBouncer pools the production app roles and databases, and the scratch database and its generated role
exist only in the cluster, not in PgBouncer's configuration. Connecting directly to the port the
`pg_restore` used is also what guarantees the instance reaches the scratch database and not a pool that
happens to route back to production.

Free space is checked before the restore: the drill refuses below **2x the dump size + 1 GB**, because
`pg_restore` needs room for the restored tables on top of the archive and the database's own WAL and
temporary files.

The scratch database and its role are dropped in a `finally`, together with stopping the instance, on
success and on failure. A PostgreSQL drill always cleans up after itself; `--keep` keeps the drill
directory (the copy, `drill.env`, `drill.log`) but never the scratch database or role.

Each database check uses `pg_restore --list`, and row counts are read with `psql` from production and the scratch database.
