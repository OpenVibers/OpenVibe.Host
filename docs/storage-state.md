# Storage state (roadmap Wave 22)

This page covers two Wave 22 exit criteria:
- "No service still queries SQLite for canonical data unless that is its documented and reviewed state."
- "Each service's /ready tells the truth about its actual backing store."

It has one row per deployed service. Each row gives the service's backing store, whether that store is
canonical, its status under ADR-007, what its readiness handler actually checks (read from the handler,
not from docs), and its backup and drill status from [restore-drills.md](restore-drills.md).

ADR-007 (`OpenVibe.Contracts/docs/adr/ADR-007-data-ownership.md`) decides:
- "SQLite remains the documented store per service while the platform is single-host; each service's
  `/ready` reports its actual store."
- A service moves to PostgreSQL individually when it needs concurrent writers across processes, a second
  host, or sizes SQLite handles poorly.
- Money paths use SERIALIZABLE transactions and row locks when they move.

Every service below runs on SQLite (better-sqlite3), with one database per service. No repository has a
PostgreSQL driver or config. **This page is the Wave 22 review of that state.**

Sources:
- Each repository's `server/config.js`, `.env.example` and `deploy/systemd/*.service`.
- The ovhost inventory example [`host.example.json`](../host.example.json), which lists production paths.
- The operator notes of 2026-09-23, for what is deployed.
- Live was read at `~/orca/workspaces/OpenVibe.Live/seadragon` (`ae07553`).

`openvibe-shared/ready` (v1.3.0, `node_modules/openvibe-shared/ready.js:43-124`) behaves like this:
- It has no checks of its own.
- A service passes named checks, and each check is required unless it is marked optional.
- It answers 503 only when a required check fails.
- A failed optional check gives 200 with `status: "degraded"`.
- The default timeout is 2 s.

## Findings

1. **Readiness that does not check the store.**
   - *(Fixed 2026-09-23, Games `f11e21c`: `/api/ready` checks `world.db` and the tick; host-only.)* **Games** had no `/api/ready`. `/healthz` returns `{ ok: true, tick }` without touching `world.db`
     (`apps/server/src/net/httpServer.ts:596-600`).
   - *(Fixed 2026-09-23, Chat `45f2b1f`: required `db` read of `chat_messages`, optional `live_sync` degraded after 60 s without a clean pass.)* **Chat** `/ready` was 200 as soon as `ctx.stats.lastSyncAt` was set (`server/app.js:77-86`). That
     timestamp is set even when every Live sync step fails, because `tick()` and `sync()` catch each
     step's error and set it anyway (`server/live-context.js:665-683`). The only database access is the
     `mirror.pending` count (`SELECT COUNT(*) FROM live_mirror_outbox`, `server/bridge/live-mirror.js:34`,
     production runs `LIVE_MIRROR=1`). A broken `chat.db` would therefore surface as a thrown 500, not as a
     named check.
2. **Readiness that checks the main store but not every store.**
   - **Live** runs `SELECT 1` on `live.db`. It does not check `data/analytics.db` or `data/rs-companion.db`.
   - The **Tools** satellites maps, text, yt and food only check `analytics.db`, and only as an optional
     check. By design, that is their only database, and the tools work without it.
   - The **Tools** gateway reports each satellite as an optional upstream. So a failed `jobs.db` on img,
     audio or docs makes the gateway *degraded* (still 200), while that satellite's own `/api/ready`
     answers 503.
3. **ovhost's post-deploy readiness URL is not the truthful endpoint for four services.**
   `host.example.json` polls:
   - Network `/api/health`, which is static (`server/index.js:392-394`), although Network's `/api/ready`
     checks the database and the signing key;
   - Media `/healthz`, which is liveness only, although Media's `/api/ready` checks the database and
     storage;
   - Tools gateway `/api/health`;
   - Games `/healthz` (the inventory now uses `/api/ready`, 2026-09-23; Network, Media and Tools too).

   The inventory should point at `/api/ready` where one exists. Games has none.
4. *(Fixed: the inventory has had AI and OpenRe entries since `f0dbd0c`, and both are in the scheduled
   `ovhost backup --all` with off-host copies, [backups.md](backups.md). Their drills are still unsupported.)*
   **Two services have no ovhost inventory entry, so no `ovhost backup` and no drill**: AI (`ai.db`) and
   OpenRe.Stream (`openre.db`). Whether they are backed up any other way is unknown. Check the host's cron
   and timers.
5. **The inventory's Tools backup list is incomplete.** It names the seven `analytics.db` files only.
   The job databases `apps/{img,audio,docs}/data/jobs.db` (table `tool_jobs`,
   `apps/_shared/jobs/index.js:77`) are missing. Tools W11 jobs have been in production since
   2026-09-23.
6. **SQLite reads outside the documented state.** These go against exit criterion 1, and each has an entry
   in [compatibility-register.md](compatibility-register.md):
   - **Live reads its frozen legacy `vods`/`pastes` tables for live pages**, although Media and Community
     hold the canonical rows (C-73):
     - `server/ai/chat-ai-routes.js:337`
     - `server/admin/routes.js:91-92`
     - `server/arena/arena-service.js:436`
     - `server/streaming/routes.js:1547`
   - **Network may open Live's `live.db`** read-only at boot (`syncLinkedLiveRoles`,
     `server/db/database.js:28-99`), which ADR-007 forbids (C-58). None of its default paths is Live's
     production path. Whether `OPENVIBELIVE_DB_PATH` is set is unknown: check `/etc/openvibe/network.env`.
   - **Chat reads Live's files** at `/opt/openvibe.live/data/sounds`. These are files, not a database
     (`deploy/systemd/openvibe-chat.service:43`).
7. **Canonical money is still in Live.** Billing's `billing.db` is a shadow (Billing
   `STATUS.json: "authoritative": false`) until the cutover in [cutover-runbook.md](cutover-runbook.md)
   step B.

## Per service

"Drill" is the latest result in [restore-drills.md](restore-drills.md), all 2026-09-23. "Deployed" is from
the operator notes unless cited. Where a repo's `STATUS.json` disagrees, the operator notes and the drill
log win.

| Service | Backing store (production path; env, default) | Canonical? | ADR-007 status | Readiness checks (handler) | Store checked? | Backup / drill |
|---|---|---|---|---|---|---|
| **Network** | `/opt/openvibe.network/data/network.db`; `DB_PATH`, default `./data/network.db` (`server/config.js:55`). Analytics lives in the same file (`README.md:306-307`). | Yes: identity, OAuth clients, subjects, OpenCoins wallets, themes, notifications, analytics | SQLite, the reviewed single-host state. `docs/platform-plan.md:74,111` defers PostgreSQL "until a room needs it". | `/api/ready` (`server/observability.js:58-96`). Required: `db` (`SELECT COUNT(*) FROM oauth_clients`), `signing_key` in production (signs and verifies an RS256 probe; fails on the HS256 dev key). Optional: `registry_poll`, `discord_bot`. | **Yes** | Drill passed 05:22. ovhost's deploy readiness polls the static `/api/health` (finding 3). |
| **Live** | `/opt/openvibe.live/data/live.db` (legacy in-place layout, "current production", Live `docs/deploy.md:31`); `DB_PATH`, default `./data/live.db` (`server/config.js:228`). Also `data/rs-companion.db`, and `data/analytics.db`, whose path is hard-coded with no env (`server/index.js:361-363`). | Yes: streams, channels, follows, Live accounts, restreams, **money** (`BILLING_AUTHORITY` unset = `live`), AI state (`vod_ai_state`/`clip_ai_state`), analytics. **Not canonical:** the 12 chat mirror tables (Chat is, since 02:03 UTC) and the frozen `vods`/`clips`/`pastes` (Media and Community are). | SQLite, the reviewed state. No PostgreSQL plan. Money moves to Billing, not to PostgreSQL. | `/api/ready` (`server/index.js:748-756`, `server/web/observability.js:79-106`). Required: `boot`, `db` (`SELECT 1` on `live.db`). Optional: `sfu`, `media` (`MEDIA_URL/healthz`, cached 30 s), `network_key` (PEM loaded, no call). | **Yes** for `live.db`; not `analytics.db` or `rs-companion.db` | `ovhost backup` covers `live.db` and `rs-companion.db`. `analytics.db` is left out on purpose (`host.example.json` `_databasesNote`). Drill **unsupported**: `analytics.db` is opened relative to the checkout, RTMP always binds, and restreams, relays and AI jobs resume from the copy. |
| **Media** | `/opt/openvibe.media/data/media.db`; `DB_PATH`, default `./data/media.db` (`server/config.js:24`). Local `VOD_PATH`, `CLIPS_PATH`, `PASTES_PATH`, `THUMBNAILS_PATH`, `FILES_PATH`, `OBJECTS_PATH` (`config.js:27-58`), plus B2 and R2 object storage. | Yes: media objects, VODs, clips, files, thumbnails, avatars. Paste writes are frozen (Community is canonical). Media still serves paste screenshot bytes. | SQLite, the reviewed state. No PostgreSQL plan. | `/api/ready` (`server/observability.js:72-107`). Required: `db` (`SELECT COUNT(*) FROM apps`), and `storage_{vods,clips,pastes,thumbnails,files,objects}` (writes and unlinks a probe). Optional: `network_jwks`, `remote_b2`/`remote_r2` (HeadBucket, cached 60 s), `events_outbox` (>1000 pending). Also reports `recordings_in_progress`. | **Yes** (database and disk; object storage optional) | `ovhost backup` covers `media.db`. Drill **unsupported**: webhooks to Live come from the `apps` table, and ffmpeg jobs run against production paths. ovhost's deploy readiness polls `/healthz` (finding 3). |
| **Tools** | The gateway has no database. Each satellite has `apps/<app>/data/analytics.db` (relative to `/opt/openvibe.tools`). img, audio and docs also have `data/jobs.db` (`apps/_shared/jobs/index.js:77`), `data/uploads` and `data/output`; yt has `data/downloads`. Job results go to Media when `TOOLS_JOB_RESULTS=media` (default `local`, `apps/_shared/jobs/index.js:32-36`). | Yes: jobs (img, audio, docs) and per-app analytics | SQLite, the reviewed state. One file per process, so ADR-007's "concurrent writers across processes" trigger does not apply. | `/api/ready` on every unit (`apps/_shared/observe.js:71-162`). Gateway: `catalog` required; `network_key`, `service_directory`, `community`, and each `satellite_<name>` optional (`apps/gateway/server/index.js:60-72`). img, docs, audio: `jobs_db` (`SELECT COUNT(*) FROM tool_jobs`), `job_runtime` and data directories required. yt: `downloads_dir`. food: `maps` upstream. maps, text: none required (`analytics_db` optional). | **Partly**: `jobs.db` yes on its satellites; analytics optional by design; the gateway reports satellites as optional (finding 2) | `ovhost backup` covers the seven `analytics.db` files only; **`jobs.db` is missing** (finding 5). Drill **unsupported**: eight units, relative `analytics.db` paths, job runtimes re-queue at start. |
| **Games** | `/opt/openvibe.games/data/world.db`; `DB_PATH`, default `data/world.db` (`apps/server/src/config.ts:79`). No `.env.example`. | Yes: world, accounts, inventory | SQLite, the reviewed state. No PostgreSQL plan. | `/api/ready` (since `f11e21c`): required `db` (`meta.schema_version` in `world.db`) and `tick` (last step < 5 s ago); 404 on the public vhosts. `/healthz` unchanged. | **Yes** | `ovhost backup` covers `world.db`. Drill **unsupported** (runtime side effects not reviewed). Games is `managed: false` in the inventory. |
| **Community** | `/var/lib/openvibe-community/community.db` (`StateDirectory`, `deploy/systemd/openvibe-community.service:26-27`). `/opt/openvibe.community/data/community.db` is the legacy location, and the inventory keeps whichever of the two exists. `COMMUNITY_DB_PATH`, default `./data/community.db` (`server/config.js:56`). | Yes: pastes (`PASTES_AUTHORITY=community` since 2026-09-22), comments, spaces, threads, Pulse | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:29-66`). Required: `db` (`SELECT COUNT(*) FROM sqlite_master WHERE type='table'`, fails on 0). Optional: `network_jwks`, `media` (community mode) or `live` (live mode). Reports `pastes_authority`. | **Yes** | Drill passed 03:44 (manual) and 05:22. |
| **Events** | `/var/lib/openvibe-events/events.db` (`deploy/systemd/openvibe-events.service:30-31`); `EVENTS_DB_PATH`, default `./data/events.db` (`server/config.js:67`). | Yes: the durable event store, subscriptions, deliveries, DLQ | SQLite, the reviewed state. `README.md:163`: "the plan's PostgreSQL + Redis fanout is a later step". No dated plan. | `/api/ready` (`server/app.js:41-66`). Required: `db` (`store.ping()` = `SELECT 1`), `network_jwks`, `delivery_worker` (unless `EVENTS_WORKER=off`). Optional: `dlq` (degraded at more than `EVENTS_DLQ_DEGRADED_AT`, default 100). | **Yes** | Drill passed 05:22. |
| **Chat** | `/var/lib/openvibe-chat/chat.db` (`deploy/systemd/openvibe-chat.service:38-39`); `CHAT_DB_PATH`, default `./data/chat.db` (`server/config.js:34`). It also reads Live's `/opt/openvibe.live/data/sounds` (`:43`). | Yes, since 2026-09-23 02:03 UTC: the 12 chat tables (`table_authority = 'chat'`). Six staged tables are still Live's. | SQLite, the reviewed state. | `/ready` (loopback). Since `45f2b1f`: required `db` (`SELECT MAX(id) FROM chat_messages`, 503 on failure); optional `live_sync` (degraded when no clean Live sync pass for `LIVE_SYNC_STALE_MS`, 60 s, or one step is late). `mirror.pending` is still reported only. | **Yes** | Drill passed 05:22. |
| **OpenRe.Stream** | `/var/lib/openre/openre.db` (all four units); default `./data/openre.db`. | Stream definitions, sessions and destinations for switched slots. **No slot is switched**, so Live is still the ingest authority for every stream. | SQLite, the reviewed state. `README.md:66` names PostgreSQL only as a future ADR-007 trigger. | `/api/ready` (`server/app.js:31-51`, own handler). Required: `db` (`SELECT 1`), `key` (Network public key). Reported but not required: workers, coordinator lease, store, events. Not checked: RTMP reachability, Media, Events. | **Yes** | **Not in the ovhost inventory: no `ovhost backup`, no drill** (finding 4). |
| **Billing** | `/var/lib/openvibe-billing/billing.db` (`deploy/systemd/openvibe-billing.service:23-25`, `StateDirectoryMode=0700`); `BILLING_DB_PATH`, default `./data/billing.db` (`server/config.js:62`). The journal is append-only (triggers refuse UPDATE and DELETE, `README.md:45-50`). | **Not yet.** It is a shadow: `STATUS.json` `"authoritative": false`. Live holds the money until the cutover. | SQLite, the reviewed state. ADR-007's SERIALIZABLE and row-lock rule applies when money moves to PostgreSQL. No plan yet. | `/api/ready` (`server/app.js:54-60`, own handler). `SELECT 1 FROM settings WHERE id = 1` and Network public key loaded, otherwise 503 `service.not_ready`. `/api/health` reports frozen state and providers. | **Yes** | Drill passed 05:22. |
| **Tips** | `/var/lib/openvibe-tips/tips.db` (`deploy/systemd/openvibe-tips.service:25`); `TIPS_DB_PATH` (`server/config.js:31`). | Yes: creator tip profiles, interactions, goals | SQLite, the reviewed state. | `/api/ready` (`server/app.js:74-79`, own handler): `SELECT 1 FROM settings WHERE id = 1` and key loaded. | **Yes** | Drill passed 05:23. |
| **VIP** | `/var/lib/openvibe-vip/vip.db` (`deploy/systemd/openvibe-vip.service:25`); `VIP_DB_PATH` (`server/config.js:31`). | Yes: creators, plans, memberships, perks (checkout closed until the Billing cutover) | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:20-48`). Required: `db` (`COUNT(*) FROM vip_creators >= 1`). Optional: `network_jwks`, `billing`. | **Yes** | Drill passed 05:23. |
| **AI** | `/var/lib/openvibe-ai/ai.db` (`deploy/systemd/openvibe-ai.service:30-31`); `AI_DB_PATH`, default `./data/ai.db` (`server/config.js:81`). | Yes: workflows, runs, providers, quotas, usage (Live keeps its AI product state, AI `docs/migration.md:30-35`) | SQLite, the reviewed state. | `/api/ready` (`server/app.js:26-33`, own handler). Required: `db` (`SELECT 1`), `key`, `workflows` (at least one registered). | **Yes** | **Not in the ovhost inventory: no `ovhost backup`, no drill** (finding 4). |
| **Search** | `/var/lib/openvibe-search/search.db` (`deploy/systemd/openvibe-search.service:28`); `SEARCH_DB_PATH` (`server/config.js:49`). | **No**: a derived FTS5 index, rebuildable from its owners (sources, wiki, blog, news, reviews) | SQLite FTS5. `docs/adr-engine.md` plans PostgreSQL FTS "once a PostgreSQL instance exists" (`server/engine/fts5.js:16` keeps the engine behind an interface). | `/api/ready` (`server/app.js:30-43`): `SELECT 1` and key loaded. | **Yes** | Drill passed 05:23. |
| **Sources** | `/var/lib/openvibe-sources/sources.db` (`deploy/systemd/openvibe-sources.service:29`); `SOURCES_DB_PATH` (`server/config.js:41`). | Yes: source registry, items, revisions, fetch runs | SQLite, the reviewed state. | `/api/ready` (`server/app.js:25+`): `SELECT 1`, key, and the worker when enabled. | **Yes** | Drill passed 05:23. |
| **Wiki** | `/var/lib/openvibe-wiki/wiki.db` (`deploy/systemd/openvibe-wiki.service:29`); `WIKI_DB_PATH` (`server/config.js:27`). | Yes: spaces, pages, revisions | SQLite, the reviewed state. | `/api/ready` (`server/app.js:63-75`). Required: `db` (`wiki_pages` exists). Optional: jwks, events_relay, community, sources, media. | **Yes** | Drill passed 05:23. |
| **Blog** | `/var/lib/openvibe-blog/blog.db` (`deploy/systemd/openvibe-blog.service:28`); `BLOG_DB_PATH` (`server/config.js:32`). | Yes: blogs, posts, revisions | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:19-58`). Required: `db` (charter tables exist). Optional: jwks, events_relay, scheduler. | **Yes** | Drill passed 05:23. |
| **News** | `/var/lib/openvibe-news/news.db` (`deploy/systemd/openvibe-news.service:29`); `NEWS_DB_PATH` (`server/config.js:32`). | Yes: topics, stories, source items | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:21-65`). Required: `db` (charter tables). Optional: jwks, events_relay, events_webhook, sources_pull. | **Yes** | Drill passed 05:23. |
| **Reviews** | `/var/lib/openvibe-reviews/reviews.db` (`deploy/systemd/openvibe-reviews.service:30`); `REVIEWS_DB_PATH` (`server/config.js:28`). | Yes: entities, signals, summaries | SQLite, the reviewed state. | `/api/ready` (`server/app.js:82-99`). Required: `db` (three review tables). Optional: jwks, sources, events relay and webhook, community, editors. | **Yes** | Drill passed 05:23. |
| **Deals** | `/var/lib/openvibe-deals/deals.db` (`deploy/systemd/openvibe-deals.service:28`); `DEALS_DB_PATH` (`server/config.js:34`). | Yes: offers, products, votes | SQLite, the reviewed state. | `/api/ready` (`server/observability.js`). Required: `db` (tables exist, `:26-28`). Optional: jwks, events_relay, sources_import, worker, abuse_keys. | **Yes** | Drill passed 05:23. |
| **Coupons** | `/var/lib/openvibe-coupons/coupons.db` (`deploy/systemd/openvibe-coupons.service:29`); `COUPONS_DB_PATH` (`server/config.js:32`). | Yes: coupons, merchants, domains | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:24-26`). Required: `db`. Optional: jwks, events_relay, sweep, sources_import, reporter_key. | **Yes** | Drill passed 05:23. |
| **Trade** | `/var/lib/openvibe-trade/trade.db` (`deploy/systemd/openvibe-trade.service:29`); `TRADE_DB_PATH` (`server/config.js:32`). | Yes: instruments, observations, source documents (informational, ADR-025) | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:23-25`, mounted `server/app.js:121`). Required: `db`. Optional: jwks, events_relay, sources_sync, freshness. | **Yes** | Drill passed 05:23. |
| **Codes** | `/var/lib/openvibe-codes/codes.db` (`deploy/systemd/openvibe-codes.service:29`); `CODES_DB_PATH` (`server/config.js:37`). | Yes: manifests, releases, trust | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:24-32`). Required: `db`, `docs`. Optional: jwks, network, oauth_client, events_relay. | **Yes** | Drill passed 05:23. |
| **Host** | Stage B: `/var/lib/openvibe-host-api/host.db` and `HOST_STORAGE_DIR` blobs (`deploy/systemd/openvibe-host.service:37-38`; `server/config.js:47-49`). Stage A (`ovhost`) keeps JSONL logs in `/var/lib/openvibe-host` and has no database. | Yes: tenant projects, sites, deploys, domains | SQLite, the reviewed state. | `/api/ready` (`server/observability.js:22-29`). Required: `db`, `storage` (`blobs.writable()`, `server/storage.js:98-102`). Optional: jwks, events_relay, domain_checks. | **Yes** (database and blob directory) | Drill passed 05:23 (`host.db`, counts only). `README.md` and `STATUS.json` say Stage B is **not deployed**, while the drill counted a production `host.db`. Whether `openvibe-host.service` is running is unknown: check `systemctl status openvibe-host`. |

## Deployed-state notes

- **Loopback only**, not on their domains yet (operator notes): Tips, VIP, Search, Sources, News, Reviews,
  Codes, AI and OpenRe's API. **Public**: Wiki and Blog (since ~03:00 UTC). **Staff console public**:
  Billing. Deals, Coupons and Trade passed drills against production, so they run on the host. Whether
  they are public is unknown: check nginx `sites-enabled`. Sites still has placeholders for
  openvibe.deals, .coupons and .trade.
- Several `STATUS.json` files are stale against the operator notes and the drill log. Chat, Events, OpenRe
  and AI still say `"deployed": false`, and so do Tips, Search, Sources, News, Reviews, Deals, Coupons,
  Trade and Codes. `STATUS.json` stays each service's own record to fix. This page does not change it.

## Re-checking

```
sudo ovhost status <service>                       # unit, port, readiness as ovhost sees it
curl -s 127.0.0.1:<port>/api/ready | jq .checks    # the named checks and their state
sudo ovhost backup <service> && sudo ovhost drill <service>
```

To re-verify a row, read the handler cited in the row. A readiness change is a code change in that
service, and this page is updated in the same week.
