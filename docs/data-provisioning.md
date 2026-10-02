# Provisioning a service's PostgreSQL database (`ovhost data`)

The data role ([roles/data/README.md](../roles/data/README.md), ADR-035) is configured from code:
`add-service.sh` gives one service its database, roles and Valkey user, and `switch-service.sh` moves a
service from SQLite to PostgreSQL. The agent pipeline may run only `ovhost` through its broker, so both
scripts are reachable from the CLI:

```
sudo ovhost data provision <service> [--dry-run]
sudo ovhost data switch <service> [--sqlite <file>] [--dry-run]
```

Both run the script **from the ovhost install** (`<install>/roles/data/`), exactly as
`sudo ovhost self-update` maintains it, and **pass the script's own exit code through** (a `switch` that
gives up on protected sessions exits the same code the script did). `--dry-run` prints what would run and
changes nothing. A service the inventory does not list is refused before anything runs. Both must run as
root (`sudo ovhost data …`; `--dry-run` need not): the scripts need it, and an inner `sudo` would reset
`SWITCH_UNITS`/`SWITCH_DIR` and switch the default unit and directory instead.

- **`data provision`** runs `roles/data/add-service.sh <service>` with no arguments of its own. It is
  idempotent: passwords are generated once into `/etc/openvibe/data.env`, the roles, database and Valkey
  user are created if missing, and the four connection settings are replaced in place in the service's
  env file. The script prints **names only** — `DATABASE_URL`, `DATABASE_DIRECT_URL`, `VALKEY_URL`,
  `VALKEY_PREFIX` — never a value.
- **`data switch`** runs `roles/data/switch-service.sh <service> [<file>]`. It takes `SWITCH_UNITS` and
  `SWITCH_DIR` from the inventory entry (`units` plus `workerUnits`, a template worker shown as a glob
  such as `openre-rtmp-ingest@*.service`, plus the `unitsMatch` glob when set; `repo`), so a release-layout service such as OpenRe needs no
  hand-set environment. `--sqlite <file>` names the SQLite file when it is not
  `/var/lib/openvibe-<service>/<service>.db` (Host: `/var/lib/openvibe-host-api/host.db`). Before running
  it, the service's postgres branch must be merged with green CI and its auto-deploy frozen
  (`sudo ovhost freeze <service> --reason …`); the script unfreezes and deploys at the end. Its output
  is collected and printed when the script exits, not streamed: while it waits (up to 12 hours) for
  protected sessions to go idle, no `[switch] waiting…` line appears, so give the caller (the broker) a
  timeout longer than that wait, or switch when the service is idle.

**`switch` needs the service's `scripts/migrate-to-postgres.js`.** The script clones `main`, installs it
and runs that file (`openvibe-sdk` `runSqliteMigration`: migrate, import, verify counts and checksums)
with the unit's own environment. A service without it cannot be switched this way.

**No URL or password appears in the output.** `add-service.sh` prints names only, and every line either
command writes out (stdout, stderr, `--json`, and the `--dry-run` command line) passes through a redact
pass: a `postgres://`, `postgresql://`, `redis://` or `valkey://` URL becomes `<redacted-url>` and a
`…PASSWORD=value` becomes `…PASSWORD=<redacted>`. This is asserted by `test/data-provision.test.js`.

## Precedent: the 2026-10-02 manual runs

On 2026-10-02 Tools, Chat and Network were provisioned and switched **by hand** with exactly these
scripts, before the CLI wrappers existed:

| Service | Switch |
|---|---|
| Tools | `scripts/migrate-to-postgres.js` over `apps/*/data` |
| Chat | `scripts/import-sqlite-to-pg.js` |
| Network | its T2 runbook |

Those runs are the reason `data provision` takes no inventory-specific flags and `data switch` reads the
units and directory from the inventory: the scripts already encode the per-service rules, and the CLI only
supplies what the entry knows.
