# Restore drills (roadmap Wave 22)

A drill restores a service's database from its latest `ovhost backup`, starts a second instance of the
service on a spare loopback port against the restored copy, and compares its answers with production.
The production instance is never touched.

| Date (UTC) | Service | Backup | Checks | Result |
|---|---|---|---|---|
| 2026-09-23 03:44 | community | `/var/backups/openvibe/community/20260923-034341/` (`ovhost backup community`) | `pragma integrity_check` = ok; restored instance `/api/ready` 200; `/api/pastes?limit=5`, `/api/v1/spaces`, `/api/v1/pulse?limit=5` byte-identical to production; pastes 892 = 892 | passed |
| 2026-09-23 05:22 | community | `/var/backups/openvibe/community/20260923-052231/` (`ovhost drill community`) | `pragma integrity_check` (community) = ok; drill instance `/api/ready` 200 after 1s; `/api/pastes?limit=5`, `/api/v1/spaces`, `/api/v1/pulse?limit=5` identical to production; pastes 892 = 892; spaces 3 = 3; threads 0 = 0; posts 0 = 0 | passed |
| 2026-09-23 05:22 | network | `/var/backups/openvibe/network/20260923-052241/` (`ovhost drill network`) | `pragma integrity_check` (network) = ok; drill instance `/api/ready` 200 after 1s; `/api/health`, `/api/.well-known/jwks`, `/api/brand`, `/api/themes?limit=500`, `/api/domains`, `/api/v1/registry/capabilities` identical to production; users 393 = 393; oauth_clients 22 = 22; wallets 30 = 30; coin_transactions 34 = 34 | passed |
| 2026-09-23 05:22 | events | `/var/backups/openvibe/events/20260923-052251/` (`ovhost drill events`) | `pragma integrity_check` (events) = ok; drill instance `/api/ready` 200 after 1s; events 69 = 69; subscriptions 8 = 8; deliveries 20 = 20; consumer_checkpoints 0 = 0 | passed |
| 2026-09-23 05:22 | billing | `/var/backups/openvibe/billing/20260923-052254/` (`ovhost drill billing`) | `pragma integrity_check` (billing) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/rates` identical to production; accounts 22 = 22; transactions 322 = 322; ledger_entries 996 = 996; subscriptions 0 = 0; payment_intents 5 = 5 | passed |
| 2026-09-23 05:22 | chat | `/var/backups/openvibe/chat/20260923-052257/` (`ovhost drill chat`) | `pragma integrity_check` (chat) = ok; drill instance `/ready` 200 after 1s; `/api/chat/filters/friendly` identical to production; dm_conversations 11 = 11; dm_messages 1522 = 1522; emotes 42 = 42; moderation_actions 264 = 264 | passed |
| 2026-09-23 05:23 | search | `/var/backups/openvibe/search/20260923-052300/` (`ovhost drill search`) | `pragma integrity_check` (search) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/search?q=openvibe&limit=10`, `/api/v1/suggest?q=open&limit=10` identical to production; documents 10 = 10; doc_acl 0 = 0; doc_facets 0 = 0 | passed |
| 2026-09-23 05:23 | sources | `/var/backups/openvibe/sources/20260923-052303/` (`ovhost drill sources`) | `pragma integrity_check` (sources) = ok; drill instance `/api/ready` 200 after 1s; sources 6 = 6; items 0 = 0; item_revisions 0 = 0; fetch_runs 0 = 0 | passed |
| 2026-09-23 05:23 | wiki | `/var/backups/openvibe/wiki/20260923-052306/` (`ovhost drill wiki`) | `pragma integrity_check` (wiki) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/spaces`, `/feed.json` identical to production; wiki_spaces 1 = 1; wiki_pages 10 = 10; wiki_page_revisions 10 = 10 | passed |
| 2026-09-23 05:23 | blog | `/var/backups/openvibe/blog/20260923-052309/` (`ovhost drill blog`) | `pragma integrity_check` (blog) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/blogs/openvibe/posts?limit=10`, `/feed.json` identical to production; blogs 1 = 1; blog_posts 1 = 1; blog_post_revisions 1 = 1 | passed |
| 2026-09-23 05:23 | tips | `/var/backups/openvibe/tips/20260923-052312/` (`ovhost drill tips`) | `pragma integrity_check` (tips) = ok; drill instance `/api/ready` 200 after 1s; `/sitemap.xml` identical to production; creator_tip_profiles 0 = 0; tip_interactions 0 = 0; tip_goals 0 = 0 | passed |
| 2026-09-23 05:23 | vip | `/var/backups/openvibe/vip/20260923-052315/` (`ovhost drill vip`) | `pragma integrity_check` (vip) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/creators/network`, `/api/v1/plans?creator=network`, `/api/v1/perks?creator=network` identical to production; vip_creators 1 = 1; vip_plans 0 = 0; vip_memberships 0 = 0 | passed |
| 2026-09-23 05:23 | news | `/var/backups/openvibe/news/20260923-052318/` (`ovhost drill news`) | `pragma integrity_check` (news) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/stories?limit=10`, `/api/v1/topics` identical to production; news_topics 12 = 12; news_stories 0 = 0; news_source_items 0 = 0 | passed |
| 2026-09-23 05:23 | reviews | `/var/backups/openvibe/reviews/20260923-052321/` (`ovhost drill reviews`) | `pragma integrity_check` (reviews) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/entities?limit=10`, `/feed.json` identical to production; review_entities 0 = 0; review_signals 0 = 0; review_summaries 0 = 0 | passed |
| 2026-09-23 05:23 | trade | `/var/backups/openvibe/trade/20260923-052323/` (`ovhost drill trade`) | `pragma integrity_check` (trade) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/instruments?limit=10`, `/feed.json` identical to production; trade_instruments 0 = 0; trade_market_observations 0 = 0; trade_source_documents 0 = 0 | passed |
| 2026-09-23 05:23 | deals | `/var/backups/openvibe/deals/20260923-052326/` (`ovhost drill deals`) | `pragma integrity_check` (deals) = ok; drill instance `/api/ready` 200 after 1s; `/api/v1/offers?sort=new&page=1` identical to production (JSON without volatile keys where declared); deal_offers 0 = 0; deal_products 0 = 0; deal_votes 0 = 0 | passed |
| 2026-09-23 05:23 | coupons | `/var/backups/openvibe/coupons/20260923-052329/` (`ovhost drill coupons`) | `pragma integrity_check` (coupons) = ok; drill instance `/api/ready` 200 after 1s; `/sitemaps/merchants.xml`, `/feed.json` identical to production; coupons 0 = 0; coupon_merchants 0 = 0; coupon_merchant_domains 0 = 0 | passed |
| 2026-09-23 05:23 | codes | `/var/backups/openvibe/codes/20260923-052332/` (`ovhost drill codes`) | `pragma integrity_check` (codes) = ok; drill instance `/api/ready` 200 after 1s; `/sitemap.xml` identical to production; manifests 0 = 0; releases 0 = 0; trust 0 = 0 | passed |
| 2026-09-23 05:23 | host | `/var/backups/openvibe/host/20260923-052335/` (`ovhost drill host`) | `pragma integrity_check` (host) = ok; drill instance `/api/ready` 200 after 1s; host_projects 0 = 0; host_sites 0 = 0; host_deploys 0 = 0; host_domains 0 = 0 | passed |
| 2026-09-23 19:24 | openre | `/var/backups/openvibe/openre/20260923-192308/` (`ovhost drill openre`) | `pragma integrity_check` (openre) = ok; drill instance `/api/ready` 200 after 1s; `/api/health`, `/robots.txt` identical to production; stream_definitions 1 = 1; ingest_keys 1 = 1; destinations 0 = 0; migration_map 0 = 0 | passed |

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

## Drilling an off-host copy

Scheduled backups and their encrypted off-host copies are described in [backups.md](backups.md).
To drill a copy from the bucket, not the local disk, download it first. The directory
`restore-download` writes has the layout `--backup` expects:

```
sudo ovhost restore-download community latest --out /var/lib/openvibe-restore/drill-community
sudo ovhost drill community --backup /var/lib/openvibe-restore/drill-community
sudo rm -rf /var/lib/openvibe-restore/drill-community
```

Write "off-host" and the run id in the Backup column of the table above.

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
   Backups are root-only (directories 0700, files 0600, see [backups.md](backups.md)), so root makes
   the copy with `install -o <service user> -m 0600`, and the copy belongs to the service user.
   `PRAGMA integrity_check`, run as the service user, must return `ok` for each copy;
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
- openre (not run yet). Only openre-api starts (`drill.command`), with `OPENRE_DRILL=1`. From OpenRe
  `5e86ea7` on, that makes it read-only: writes, `/play/` and sign-in answer 503. The coordinator
  and every transport worker refuse to start in a drill, and the event relay and Media calls are
  off. The API never runs a transport or the relay in any case. Empty `EVENTS_URL` and
  `OV_OAUTH_CLIENT_SECRET`, plus `MEDIA_URL` on the closed port, cover older releases. The workers
  stay out of every ovhost command: they are `workerUnits`, which are listed and never restarted.
  Run it after the OpenRe release with `OPENRE_DRILL` is deployed (OpenRe `docs/cutover.md`
  phase C).

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
