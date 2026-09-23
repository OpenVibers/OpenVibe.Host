# Restore drills (roadmap Wave 22)

A drill restores a service's database from its latest `ovhost backup`, starts a second instance of the
service on a spare loopback port against the restored copy, and compares its answers with production.
The production instance is never touched.

| Date (UTC) | Service | Backup | Checks | Result |
|---|---|---|---|---|
| 2026-09-23 03:44 | community | `/var/backups/openvibe/community/20260923-034341/` (`ovhost backup community`) | `pragma integrity_check` = ok; restored instance `/api/ready` 200; `/api/pastes?limit=5`, `/api/v1/spaces`, `/api/v1/pulse?limit=5` byte-identical to production; pastes 892 = 892 | passed |

## How a drill was run (community)

1. `sudo ovhost backup community`
2. Copy `<backup>/community.db` to a temp directory owned by the service user; `pragma integrity_check`.
3. Start `node server/index.js` from the production checkout with the service's env file, overriding
   `PORT` (spare loopback port), `COMMUNITY_DB_PATH` (the copy), and turning off side effects
   (`DISCORD_RELAY_ENABLED=0`, `EVENTS_URL=` empty) so the drill instance never talks to the world.
4. Compare responses of read endpoints with production; compare row counts.
5. Stop the drill instance by its port's pid (not `pkill -f`, which can match the operator's own shell),
   delete the temp directory.

Looking back at that manual run: `EVENTS_URL=` had no effect, because Community has no events relay. The
instance could also still reach production Network over loopback (JWKS, service tokens, identity
resolve-batch). The inventory's `community` drill block now also empties `OV_OAUTH_CLIENT_SECRET` and
points `OV_LIVE_INTERNAL_URL` and `OV_MEDIA_INTERNAL_URL` at a closed port.

## Running a drill with `ovhost drill`

```
sudo ovhost backup community          # a fresh backup keeps the comparison meaningful
sudo ovhost drill community           # restore, start, compare, stop, clean up, log
sudo ovhost drill community --keep    # keep the drill directory (copy, drill.env, drill.log)
sudo ovhost drill community --backup /var/backups/openvibe/community/20260923-034341
```

The command does the steps above automatically for any service whose inventory entry has a `drill`
block (see `host.example.json`):

1. **Restore.** The command picks the latest `ovhost backup` from `<stateDir>/backups/<service>.jsonl`,
   or the `--backup` directory. It copies every database named in `drill.databases` into
   `/var/lib/openvibe-drills/<service>-<stamp>/db/`, a directory owned by the service user (mode 0700).
   The copy is made as the service user. `PRAGMA integrity_check` must return `ok` for each copy;
   otherwise the drill fails before anything starts.
2. **Start.** A second instance starts from the production checkout through `systemd-run`, as the
   service user. It uses the production unit's `ExecStart` and `WorkingDirectory`, the production
   unit's non-secret `Environment=` values and the production env file. After that it loads
   `drill.env`, which holds the drill port, the restored database paths and the switches that turn
   side effects off. `drill.env` holds inventory values only and is loaded last, so its values win.
   ovhost never reads the env file's values.
3. **Sandbox.** The instance runs with:
   - `ProtectSystem=strict`, with only the drill directory writable;
   - `PrivateTmp`, `ProtectHome=read-only` and `NoNewPrivileges`;
   - binding allowed only on its drill port (`SocketBindAllow`);
   - no addresses beyond loopback (`IPAddressDeny=any`, `IPAddressAllow=localhost`);
   - `RuntimeMaxSec`, which stops it even if ovhost dies.

   Loopback stays open because services fetch Network's public keys there. Production services
   are therefore still reachable on loopback, and the inventory's overrides are what keep the drill
   away from them.
4. **Compare.** Once the instance answers its readiness path, every `drill.compare` path is fetched
   from production and from the drill instance. Bodies must match byte for byte, or as JSON with the
   listed volatile keys removed. Statuses must match, and production must answer 2xx. Each
   `drill.counts` table is counted in production and in the restored copy.
5. **Stop and record.** The instance's own MainPID gets SIGTERM, then SIGKILL after 20 s. ovhost
   never uses `pkill -f` and never signals a production pid. The drill directory is removed unless
   `--keep` is set, or unless the instance could not be confirmed stopped. The result is appended to
   `/var/lib/openvibe-host/drills/<service>.jsonl`, and a row for the table above is printed.

Exit codes are `0` passed, `1` refused, and `2` failed. A refusal happens when ovhost is not run as
root, the port is in use, there is no backup, or the service's drill is unsupported. A failure is
integrity, readiness, a mismatch, or a stop that did not complete. Every failure is still logged and
cleaned up.

A drill compares the backup with production *now*. If writes landed after the backup, row counts and
list endpoints differ, and the drill reports that honestly. Take the backup right before the drill.

### Services

Supported with declared overrides (not yet run on the host with `ovhost drill`):

- network
- community
- events
- host (the Host API: `host.db` only, counts only)
- billing
- chat
- search
- sources
- wiki
- blog
- tips
- vip
- news
- reviews
- deals
- coupons
- trade
- codes

Services that are not deployed yet (everything except network, live, media, tools, community and
games as of 22 Sep) have entries built from their repositories' `deploy/` directories.

Marked `drill: { supported: false }`, with the reason in the inventory:

- **live:** `data/analytics.db` is opened relative to the checkout at boot. It is read-only in the
  sandbox, and without the sandbox it would be production's file. RTMP always binds. Restreams, relays,
  AI jobs and Media reconcilers resume from rows in the copy.
- **media:** webhooks to Live take their URL from the `apps` table and have no env switch. The health
  job, junk sweep and clip jobs run ffmpeg against production files through absolute paths stored in
  the database.
- **tools:** eight units. yt, food and maps open `analytics.db` relative to the checkout. The job
  runtimes re-queue and prune with no switch.
- **games:** its runtime side effects have not been reviewed.
