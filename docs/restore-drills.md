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
| 2026-09-23 23:07 | live | `/var/backups/openvibe/live/20260923-230748/` (`ovhost drill live`) | `pragma integrity_check` (live) = ok; drill instance `/api/ready` 200 after 1s; `/api/themes`, `/api/emotes/global`, `/api/streams`, `/api/streams/recently-online?limit=20`, `/api/streams/channel/japaneseoldguy/live` identical to production (JSON without volatile keys where declared); users 352 = 352; channels 123 = 123; managed_streams 103 = 103; streams 2477 = 2477; follows 62 = 62; chat_messages 70864 = 70864 | passed |
| 2026-09-23 23:07 | media | `/var/backups/openvibe/media/20260923-230757/` (`ovhost drill media`) | `pragma integrity_check` (media) = ok; drill instance `/api/ready` 200 after 1s; `/browse?tab=videos`, `/browse?tab=clips` identical to production; media_objects 3056 = 3056; vods 906 = 906; clips 315 = 315; apps 7 = 7 | passed |
| 2026-09-24 05:40 | ai | `/var/backups/openvibe/ai/20260924-054015/` (`ovhost drill ai`) | `pragma integrity_check` (ai) = ok; drill instance `/api/ready` 200 after 1s; `/api/health` identical to production; providers 3 = 3; models 9 = 9; routes 19 = 19; templates 26 = 26; workflows 47 = 47; quotas 5 = 5; citations 0 = 0 | passed |
| 2026-09-24 05:40 | games | `/var/backups/openvibe/games/20260924-054054/` (`ovhost drill games`) | `pragma integrity_check` (world) = ok; drill instance `/api/ready` 200 after 2s; `/map.json`, `/api/v1/mods` identical to production; players 28 = 28; mods 0 = 0 | passed |
| 2026-09-24 05:41 | tools | `/var/backups/openvibe/tools/20260924-054102/` (`ovhost drill tools`) | `pragma integrity_check` (tools-docs-analytics) = ok; `pragma integrity_check` (tools-docs-jobs) = ok; drill instance `/api/ready` 200 after 1s; `/release.json` identical to production (JSON without volatile keys where declared); tool_jobs 0 = 0 | passed |

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

Supported with declared overrides (the table above records which have passed on the host):

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
- live (not run yet). Needs OpenVibe.Live `8a58aea` or later; `drill.requires` refuses an older
  checkout. The production unit's ExecStart starts with `LIVE_DRILL=1`, `DB_PATH` on the copy and
  `DATA_DIR={tmp}/data`. In that mode (Live `server/drill.js`, `docs/deploy.md#restore-drills`) Live
  refuses to start unless `DB_PATH` and `DATA_DIR` are outside the checkout and `/opt/openvibe.live`,
  `HOST` is loopback, `PORT` is not 3000 and no socket was handed over by systemd. It writes only
  under `DATA_DIR` (a fresh `analytics.db`, empty data directories; the per-location `*_PATH` values
  in `live.env` are ignored) and the copy. It starts only its HTTP server:
  - no RTMP, SRT, WHIP, SFU or JSMPEG listener, and no TURN credential;
  - no WebSocket: upgrades get 403;
  - no jobs loop, restream or relay resume, AI job, Media reconciler, Events outbox, chat bridge,
    identity sync, deploy notice, star job or registry refresh.

  Every method but GET, HEAD and OPTIONS answers 403. Outbound connections, `fetch`, programs other
  than `git`, UDP sockets and other listeners are refused in-process, so Media, Community and
  Network look down to it. `rs-companion.db` is not restored: the server never opens it. Compared:
  - `/api/themes` and `/api/emotes/global`, byte for byte;
  - `/api/streams` and `/api/streams/channel/japaneseoldguy/live`, without the values production
    changes while someone is live (viewer counts, heartbeats, live thumbnails, recording state);
  - `/api/streams/recently-online?limit=20`, without `vod_thumbnail`, the one value it asks Media for.

  Counts: `users`, `channels`, `managed_streams`, `streams`, `follows`, `chat_messages`. Not
  compared: `/release.json`, which production computes at its own boot, so a `public/`-only deploy
  without a restart makes it differ; and the home statistics, which are cached for 30 s and windowed
  by the clock. Any existing channel can replace `japaneseoldguy`.
- media (not run yet). Needs OpenVibe.Media `6e74eb0` or later (`drill.requires`). `MEDIA_DRILL=1`
  with `DB_PATH` on the copy. Media then refuses to start unless `DB_PATH` is outside the checkout
  and `/opt/openvibe.media`, `HOST` is loopback and `PORT` is not 4100. It starts only its HTTP
  server:
  - no app seeding or JWKS refresh;
  - no tiering sweep, health job, junk sweep, clip re-cuts, copy verification, jobs worker, invariant
    scans, disk guardian, thumbnail cleanup, object purge, backfill or orphan-recording finalize;
  - no Events relay and no webhook (the `apps` table's URLs are production's).

  It writes no file and creates no directory. It never opens a file path from the database: every
  byte route (`/v` and `/c` bytes, `/t`, `/a`, `/f`, `/o`, paste screenshots, live frames) answers
  503, while watch pages and `/browse` render from the copy. Every method but GET, HEAD and OPTIONS
  answers 403 and `/auth/*` 503. Connections, `fetch`, programs other than `git` (no ffmpeg or
  ffprobe), UDP and other listeners are refused in-process. `/api/ready` drops the storage and
  remote-tier checks and reports `"mode": "drill"`. The storage paths from `media.env` are moved
  under `{tmp}/storage`, which is never created, as a second switch. `THUMBNAILS_PATH` stays
  production's, read-only in the sandbox, because `/browse` counts that directory in its tab bar;
  the drill lists it and serves none of it. Compared byte for byte: `/browse?tab=videos` and
  `/browse?tab=clips`. Counts: `media_objects`, `vods`, `clips`, `apps`. Production caches the tab
  counts for 60 s, so take the backup right before the drill.

Services that are not deployed yet (everything except network, live, media, tools, community and
games as of 22 Sep) have entries built from their repositories' `deploy/` directories.

- ai (passed 2026-09-24 05:40 UTC): AI starts with AI_ENABLED=0 and every provider key, base URL
  and the HTTP seam blanked, so no run can reach a paid provider; OV_OAUTH_CLIENT_SECRET and
  EVENTS_URL are blanked (no service calls, no events) and WHISPER_BIN too (no transcription). Boot
  marks interrupted runs failed in the restored copy only. `/api/health` is compared; the counts cover
  configuration and citations, because runs, requests and usage grow by the minute (integrity_check
  covers them).
- tools (passed 2026-09-24 05:41 UTC): the **docs** app alone. Tools runs eight units; `drill.unit` picks
  `openvibe-tools-docs.service`, whose ExecStart, WorkingDirectory and Environment= the drill copies,
  and `drill.productionPort` (4016) is what the comparison reads, not the gateway's 4001. docs takes a
  data DIRECTORY (`DATA_DIR`), so both restored copies land in `{tmp}/data/` under their production
  names (`analytics.db`, `jobs.db`). Existing Tools switches make it side-effect-free:
  `TOOLS_JOB_RESULTS=local` (the job pruner would otherwise delete production Media objects for
  expired jobs in the copy), `EVENTS_PUBLISH=off` and an empty `EVENTS_URL` (the copy's pending outbox
  rows would be republished), `TOOLS_JOBS_CONCURRENCY=0` (no job runs), `UPLOADS_DIR`/`OUTPUT_DIR`
  under `{tmp}`, an empty `OV_OAUTH_CLIENT_SECRET`. Job recovery and pruning, analytics aggregation
  and upload retention still run, on the copy only. `drill.requires` refuses the drill unless the
  deployed checkout has those switches. Compares `/release.json`; counts `tool_jobs`.
- games (passed 2026-09-24 05:40 UTC): Reviewed against OpenVibe.Games `7863fc6`. One HTTP listener; `/ws` and
  `/editor-ws` are upgrades on it. tsx runs `src/main.ts` directly, with no build. The unit sets
  `DB_PATH` with `Environment=`, and that value never reaches the drill because the drill sets
  `DB_PATH` itself. `EVENTS_PUBLISH=off` stops the outbox relay, `MEDIA_MIRROR=off` stops the
  map-asset mirror, and an empty `OV_OAUTH_CLIENT_SECRET` stops every service call. The 30 Hz tick
  loop keeps running because readiness needs recent ticks, and it flushes the world into the copy
  only. `map.json` stays production's file, which is read-only in the sandbox. `drill.requires`
  checks that `apps/server/src/config.ts` has both switches. The drill compares `/map.json` and
  `/api/v1/mods` and counts `players` and `mods`, which the simulation does not write. There is no
  Games backup yet, so run `sudo ovhost backup games` first.

### What the drill block can declare for multi-process and checkout-relative services

- `unit`: which of the service's units to start (its ExecStart, WorkingDirectory and non-secret
  Environment=). It is required when there are several units and no `command`.
- `productionPort`: the production port the compare paths are read from. The default is the service's
  port.
- `databases.<name>: { "env": "DATA_DIR", "dir": true }`, or `"dir": "{tmp}/<name>"`: the copy keeps
  its production file name inside that directory, and the env var, if one is given, points at the
  directory.
- `bind: [{ "from": "{tmp}/…", "to": "<path inside the checkout>" }]`: `BindPaths=` in the drill
  unit's own mount namespace. Use it for files a service opens relative to its checkout with no env
  override: the restored copy appears at the production path for the drill instance only. Tools yt,
  maps and food open `apps/<app>/data/analytics.db` this way. Drill one of them with
  `unit: openvibe-tools-<app>.service`, a `databases` entry with `"dir": "{tmp}/app-data"`, and
  `bind: [{ "from": "{tmp}/app-data", "to": "/opt/openvibe.tools/apps/<app>/data" }]`. For yt, also
  set `YT_PROXY=`. Before first use, check on the host that `BindPaths=` works together with
  `ProtectSystem=strict` in a `systemd-run` transient unit.
- `requires: [{ "file": "<path in the checkout>", "contains": "<text>" }]`: the drill refuses before
  it creates anything unless the deployed checkout has every switch its overrides rely on. An older
  release would ignore the override and run its side effects.

### What Tools and Games should add (product side, not Host)

These make the drills stricter and quieter. Neither is needed for the drills above to be
side-effect-free.

- **Tools `TOOLS_DRILL=1`:**
  - `_shared/jobs/system.js:576-585`: skip `recover()`, `prune()`, the prune interval and `kick()`.
  - `_shared/jobs/index.js:83-105`: force local results and no outbox.
  - `_shared/analytics/tracker.js:81,105-118`: no startup `DELETE` of rate tracking, no
    flush/aggregate/prune timers, and a no-op middleware.
  - The `retention.startCleanup()` calls (img `:273`, docs `:323`, audio `:307`), and yt's
    `startCleanup()` and `startUpstreamProbe()` (`:280-281`, which spawns yt-dlp against YouTube).
  - `_shared/observe.js:95-105`: no `writableDir` probe writes.
  - A `DATA_DIR` override in yt `index.js:26`, maps `:25` and food `:20`, so those apps no longer
    need `bind`.

  With these, the restored copies stay byte-stable during a drill, and row counts other than
  `tool_jobs` become comparable.
- **Games `GAMES_DRILL=1`:**
  - `config.ts:60-99`: force the client secret, OAuth, `networkAuthUrl`, `eventsUrl` and `mediaUrl`
    to null.
  - `config.ts:77-79`: refuse to start unless `HOST` is loopback and `DB_PATH` is not the production
    path.
  - `main.ts:252`: refuse `/ws` and `/editor-ws` upgrades.
  - Return 403 for map, map-asset and mod writes (`httpServer.ts:161,231` and the `routes.ts` write
    branches), and for `/auth/*` (`httpServer.ts:333`).
  - Optionally skip the periodic flush (`gameServer.ts:2320,2502`) and the prune timer
    (`main.ts:148`), so world tables can be counted too.

Marked `drill: { supported: false }`, with the reason in the inventory:

- **ai:** a drill must start AI with every provider key blanked, or queued and new runs would call
  paid providers. Backups work.

Until 23 Sep 2026 live and media were unsupported too:
- **live:** `data/analytics.db` was opened relative to the checkout at boot. RTMP always bound.
  Restreams, relays, AI jobs and Media reconcilers resumed from rows in the copy.
- **media:** webhooks to Live took their URL from the `apps` table. The health job, junk sweep and
  clip jobs ran ffmpeg against production files through absolute paths stored in the database.

`LIVE_DRILL` and `MEDIA_DRILL` (above) replace those reasons.
