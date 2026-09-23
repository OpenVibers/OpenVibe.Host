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

Open work: an `ovhost drill <service>` command that automates the steps above for every service with
declared databases and read-only comparison paths in the inventory.
