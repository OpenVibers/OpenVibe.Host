# Database files on the host (WS-S task 6, hazard H14)

Inventory of 2026-09-26: every SQLite file under /opt, /var/lib, /root, /home and /srv that no process had open. 42 open files (the live databases) are not listed. Paths, sizes and dates only; nothing was read.

`ovhost archive push <file>...` encrypts files with the backup key and copies them to `<BACKUP_S3_PREFIX>-archive/<host>/<stamp>/`, outside the backup runs so retention never prunes them; `ovhost archive list` and `ovhost archive restore <stamp> <path> --out <dir>` read them back. It never deletes a local file.

| Class | File | Size | Modified | Recommended action |
|---|---|---|---|---|
| legacy | `/opt/backups/hobo.quest-2026-08-16/data/world.db` | 0.1 MB | 2026-08-16 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/backups/legacy-quest-20260817/hobo-quest.db` | 69.1 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/backups/pre-openvibe-20260817/hobo-tools-final.db` | 731.0 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/backups/pre-openvibe-20260817/hobo-tools.db` | 731.0 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/backups/pre-openvibe-20260817/hobostreamer-final.db` | 177.7 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/backups/pre-openvibe-20260817/hobostreamer.db` | 177.7 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/backups/pre-openvibe-20260817/world-final.db` | 0.1 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/hobo.quest-old-20260816/data/world.db` | 0.1 MB | 2026-08-16 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/hobo.quest/data/world.db` | 0.1 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/hobo/hobo-quest/data/hobo-quest.db` | 69.1 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/hobo/hobo-tools/data/hobo-tools.db` | 731.0 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/hobo/hobo-tools/data/hobotools.db` | 0.0 MB | 2026-03-22 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/hobostreamer/data/hobostreamer.db` | 177.7 MB | 2026-08-17 | archive (done: see below), then delete locally with the owner's OK |
| legacy | `/opt/hobostreamer/hobostreamer.db` | 0.0 MB | 2026-08-11 | archive (done: see below), then delete locally with the owner's OK |
| live-backup | `/opt/openvibe.live/shared/data/backups/live-20260926-072748.db` | 270.9 MB | 2026-09-26 | delete (owner OK) once its migration is a release old; archive first if wanted |
| live-backup | `/opt/openvibe.live/shared/data/backups/live-pre-643a2e6.db` | 252.5 MB | 2026-09-17 | delete (owner OK) once its migration is a release old; archive first if wanted |
| live-backup | `/opt/openvibe.live/shared/data/live-before-rs-slots-20260924T0153Z.db` | 266.2 MB | 2026-09-24 | delete (owner OK) once its migration is a release old; archive first if wanted |
| live-backup | `/opt/openvibe.live/shared/data/live.db.bak-preAIstate` | 175.9 MB | 2026-08-19 | delete (owner OK) once its migration is a release old; archive first if wanted |
| rehearsal | `/var/lib/openvibe-billing/live-snapshot-202609230121.db` | 266.2 MB | 2026-09-23 | delete (owner OK); the nightly backups cover Live |
| rehearsal | `/var/lib/openvibe-chat/live-snap-a.db` | 266.2 MB | 2026-09-23 | delete (owner OK); the nightly backups cover Live |
| rehearsal | `/var/lib/openvibe-chat/live-snap-b.db` | 266.2 MB | 2026-09-23 | delete (owner OK); the nightly backups cover Live |
| rehearsal | `/var/lib/openvibe-chat/live-snapshot-0159.db` | 266.2 MB | 2026-09-23 | delete (owner OK); the nightly backups cover Live |
| rehearsal | `/var/lib/openvibe-chat/rehearsal.db` | 0.3 MB | 2026-09-23 | delete (owner OK); the nightly backups cover Live |
| migration-backup | `/var/lib/openvibe-community/community.pre-c24-20260925T185117Z.db` | 2.1 MB | 2026-09-25 | delete (owner OK); the migrations are verified |
| migration-backup | `/var/lib/openvibe-community/community.pre-c24b-20260925T185400Z.db` | 2.1 MB | 2026-09-25 | delete (owner OK); the migrations are verified |
| migration-backup | `/var/lib/openvibe-community/community.pre-c24c-20260925T185425Z.db` | 2.1 MB | 2026-09-25 | delete (owner OK); the migrations are verified |
| migration-backup | `/var/lib/openvibe-community/community.pre-live-comments-20260923T191345Z.db` | 1.9 MB | 2026-09-23 | delete (owner OK); the migrations are verified |
| ip-bearing | `/opt/hobo/hobo-audio/data/analytics.db` | 24.7 MB | 2026-08-17 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/hobo/hobo-docs/data/analytics.db` | 1.4 MB | 2026-08-17 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/hobo/hobo-food/data/analytics.db` | 0.5 MB | 2026-08-17 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/hobo/hobo-img/data/analytics.db` | 3.3 MB | 2026-08-17 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/hobo/hobo-maps/data/analytics.db` | 1.0 MB | 2026-08-17 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/hobo/hobo-text/data/analytics.db` | 6.2 MB | 2026-08-17 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/hobo/hobo-yt/data/analytics.db` | 0.5 MB | 2026-08-17 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.live/shared/data/backups/analytics-pre-adr021-2026-09-23.db` | 1682.4 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.tools/backups/analytics-2026-09-23/audio.analytics.db` | 57.5 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.tools/backups/analytics-2026-09-23/docs.analytics.db` | 1.6 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.tools/backups/analytics-2026-09-23/food.analytics.db` | 0.4 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.tools/backups/analytics-2026-09-23/img.analytics.db` | 5.4 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.tools/backups/analytics-2026-09-23/maps.analytics.db` | 0.6 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.tools/backups/analytics-2026-09-23/text.analytics.db` | 9.1 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| ip-bearing | `/opt/openvibe.tools/backups/analytics-2026-09-23/yt.analytics.db` | 0.9 MB | 2026-09-23 | delete after 2026-10-07 (WS-S task 5), never archive |
| secrets | `/opt/openvibe.network/data/network-pre-refresh-hash-2026-09-24.db` | 266.2 MB | 2026-09-24 | delete after the rollback window (WS-S task 5), never archive |
| secrets | `/opt/openvibe.network/data/network-pre-secrets-2026-09-24.db` | 266.2 MB | 2026-09-24 | delete after the rollback window (WS-S task 5), never archive |
| stale | `/opt/openvibe.blog/data/blog.db` | 0.4 MB | 2026-09-24 | delete (owner OK) |
| stale | `/opt/openvibe.community/data/community.db` | 0.2 MB | 2026-09-25 | delete (owner OK) |
| stale | `/opt/openvibe.games/data/legacy-import/world-before-20260923T184930Z.db` | 0.2 MB | 2026-09-23 | delete (owner OK) |
| stale | `/opt/openvibe.live/shared/data/hobo.db` | 0.0 MB | 2026-03-13 | delete (owner OK) |
| stale | `/opt/openvibe.live/shared/data/openvibe.db` | 0.0 MB | 2026-08-18 | delete (owner OK) |
| stale | `/opt/openvibe.live/shared/data/rs-companion.db` | 8.2 MB | 2026-03-10 | delete (owner OK) |
| migration-backup | `/opt/openvibe.media/data/backups/owner-subject-20260923.media.db` | 9.1 MB | 2026-09-23 | delete (owner OK); the owner-subject migration is verified |
| migration-backup | `/opt/openvibe.media/data/reports/h15-repair-applied-20260925.media.db` | 10.8 MB | 2026-09-25 | delete (owner OK) once the H15 repair is a release old |
| stale | `/opt/openvibe.tips/data/tips.db` | 0.0 MB | 2026-09-23 | delete (owner OK) |
| in use | `/opt/openvibe.tools/apps/gateway/data/token-revocations.db` | 0.0 MB | 2026-09-25 | keep: Tools' guard opens it per request (apps/_shared/guard/revocations.js) |
| stale | `/root/blog-stale-db-before-revert-20260924T174243.db` | 0.4 MB | 2026-09-24 | delete (owner OK) |
| system | `/var/lib/PackageKit/transactions.db` | 0.0 MB | 2026-05-11 | leave |
| system | `/var/lib/command-not-found/commands.db` | 3.6 MB | 2026-07-27 | leave |
| system | `/var/lib/fwupd/pending.db` | 0.0 MB | 2026-07-27 | leave |

Classes:
- **legacy**: the pre-OpenVibe sites' databases; the only copies, so they are archived before anything else happens.
- **live-backup**, **rehearsal**, **migration-backup**: copies made around a migration; the nightly encrypted backups cover the live data.
- **ip-bearing**, **secrets**: dated deletions in WS-S task 5 (section 10); archiving them would defeat the point.
- **stale**: files an older layout left behind (H14 names the Blog one).
- **system**: Ubuntu's own.
- **in use**: closed at the moment of the inventory but opened on demand; never archive or delete.

Deleting anything here is the owner's call (WS-S task 6). The files a deletion may touch are exactly the rows above.
