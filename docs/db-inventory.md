# PostgreSQL databases in the host inventory

Every `services.<id>.databases[]` entry names a database in the host PostgreSQL cluster:

```json
{ "name": "trade", "engine": "postgresql", "database": "ov_trade" }
```

`engine` must be `postgresql`, `database` must match `ov_[a-z0-9_]+`, and the entry cannot have `path`. `ovhost backup` verifies pgBackRest and periodically makes a `pg_dump -Fc` archive. A restore drill maps each database name to the service's URL settings:

```json
{ "trade": { "url": "DATABASE_URL", "directUrl": "DATABASE_DIRECT_URL" } }
```

The drill creates a scratch database and role, restores the archive, and points both settings at the scratch database. A `postgresql-count` protected-session probe runs a read-only SELECT through the postgres OS user.

Mail's `ov_mail` is both the Mail service's database and Stalwart's data store; Stalwart's tables
live in the same `public` schema. `sudo ovhost data provision mail` creates the `ov_mail` owner and
`ov_mail_app` runtime roles. Stalwart connects directly as the owner (`STALWART_DB_USER=ov_mail`,
`STALWART_DB_PASSWORD`); Mail's migrations run on `DATABASE_DIRECT_URL`, the same owner on :5432.
