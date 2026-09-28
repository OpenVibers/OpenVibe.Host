# The data role (ADR-035, roadmap WS-X2)

PostgreSQL 18, PgBouncer, pgBackRest, Valkey and their exporters, configured from files in this directory,
so a data server is provisioned the same way as this host. Everything listens on loopback until a private
network exists (WS-X1).

| Piece | Port | Notes |
|---|---|---|
| PostgreSQL 18 | 5432 | `conf.d/openvibe.conf` (tuning, WAL, `pg_stat_statements`), `pg_hba.conf` (SCRAM, loopback) |
| PgBouncer | 6432 | transaction pooling; SCRAM through `auth_query` (`pgbouncer.get_auth`), no password list to maintain |
| Valkey | 6379 | `volatile-lru`, AOF every second, ACLs: `default` off, one user per service confined to `ov:<svc>:*` |
| pgBackRest | — | stanza `openvibe`, encrypted repository beside ovhost's backup prefix in the same B2 bucket, 14 days of PITR; weekly full, daily differential (systemd timers) |
| Exporters | 9187, 9121, 9127 | PostgreSQL, Valkey, PgBouncer; loopback only |

```bash
sudo roles/data/provision.sh --check     # what would change
sudo roles/data/provision.sh             # apply (idempotent)
sudo roles/data/add-service.sh wiki      # database ov_wiki, roles ov_wiki / ov_wiki_app, Valkey user ov_svc_wiki,
                                         # and DATABASE_URL, DATABASE_DIRECT_URL, VALKEY_URL, VALKEY_PREFIX in /etc/openvibe/wiki.env
```

Generated passwords live only in `/etc/openvibe/data.env` (root, 0600). PostgreSQL receives SCRAM secrets and
Valkey receives SHA-256 hashes, so no plaintext is ever in SQL, logs, a process list or the scripts' output.
The one plaintext outside that file is PgBouncer's own auth user in `/etc/pgbouncer/userlist.txt`
(postgres only). **Escrow `PGBACKREST_CIPHER_PASS`** off the host with the backup key (O8): without it the
database backups cannot be read.

Applications connect with `DATABASE_URL` (the pooled runtime role: DML only, `statement_timeout` 15 s,
`lock_timeout` 5 s). Migrations use `DATABASE_DIRECT_URL` (the owner role, session features allowed).
