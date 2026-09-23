# Final cutover runbook (roadmap Wave 22)

The Wave 22 exit criterion is: "The final cutover runbook, with rollback, is absorbed into OpenVibe.Host."
This page gathers every service cutover of the realignment into one ordered runbook. Each section gives the
cutover's production state and its rollback, and links the per-repository document that stays
authoritative for the details. When a step here and its original disagree, the original wins; fix this
page.

- Host: `ssh openvibe-ovh` (single host). The public IPv4 is in `~/OpenVibers/RUNBOOK.md` on the
  operator workstation, which is not in a repository.
- Env files: `/etc/openvibe/<service>.env`. Units: `openvibe-<service>.service`. Checkouts:
  `/opt/openvibe.<service>`.
- Live paths are from `~/orca/workspaces/OpenVibe.Live/seadragon` (`ae07553`).
- Production state is from the operator notes of 2026-09-23.

State markers:
- **DONE**: executed on production, with the date.
- **IN PROGRESS**: partly on production.
- **BLOCKED (owner)**: waits for something only the owner can do. The action is spelled out.
- **READY**: nothing blocks it.
- **NOT STARTED**

## Overview

| # | Cutover | State | Per-repo original | Rollback in one line |
|---|---|---|---|---|
| A | Pastes → OpenVibe.Community (Wave 5) | **DONE** 2026-09-22 ~23:35 UTC | ADR-011; Community `README.md:16-21,354,387-390` | `PASTES_AUTHORITY=live` in Community and Live, remove Media's two flags, restart all three |
| B | Chat → OpenVibe.Chat (Wave 6) | **DONE** 2026-09-23 02:03 UTC | Chat [`docs/cutover.md`](https://github.com/OpenVibers/OpenVibe.Chat/blob/main/docs/cutover.md) | Remove the nginx include, drain the mirror, unset `CHAT_AUTHORITY`, restart Live |
| C | AI → OpenVibe.AI (Wave 13) | **DONE** 2026-09-23 ~15:40 UTC (`AI_SERVICE=remote`) | AI [`docs/migration.md`](https://github.com/OpenVibers/OpenVibe.AI/blob/main/docs/migration.md) | Unset `AI_SERVICE`, restart Live |
| D | Events delivery signature v2 | **IN PROGRESS**: Events sends v2; consumer deploys unknown; v1 still sent | Events [`docs/replay-window-rollout.md`](https://github.com/OpenVibers/OpenVibe.Events/blob/main/docs/replay-window-rollout.md) | The consumer redeploys its previous release; replay the DLQ |
| E | Money → OpenVibe.Billing | **BLOCKED (owner)**: PowerChat dashboard. Billing runs in shadow. | Billing [`docs/live-cutover.md`](https://github.com/OpenVibers/OpenVibe.Billing/blob/main/docs/live-cutover.md) | Depends on the step reached. After step 9 there is **no tool** |
| F | RTMP ingest → OpenRe.Stream | **BLOCKED (owner)**: DNS `ingest.openre.stream` and port 1936. OpenRe is deployed. | OpenRe [`README.md` "Cutover runbook"](https://github.com/OpenVibers/OpenRe.Stream/blob/main/README.md#cutover-runbook) | Per slot `{"authority":"live"}`. All slots: unset `OPENRE_URL` |
| G | Retire the shims | **NOT STARTED**. Dated in [compatibility-register.md](compatibility-register.md) | Network [`docs/retirement.md`](https://github.com/OpenVibers/OpenVibe.Network/blob/main/docs/retirement.md) | per entry |

The remaining order is D → E → F → G.
- D first: nothing depends on it, and v1 can stop only when every consumer requires v2.
- E before F: the Billing switch restarts Live once, and it is best done before any stream depends on
  OpenRe.
- G follows each entry's date in the register.

## What the owner must do

These actions need the owner's accounts or physical presence. Nothing in this runbook can do them.

1. **PowerChat dashboard, for step E4.** In the PowerChat developer dashboard, for OpenVibe.Live's app,
   change the webhook URL:
   - from `https://openvibe.live/api/powerchat/webhook`
   - to **`https://billing.openvibe.network/webhooks/powerchat`**

   Keep the **same signing secret** (Billing's `POWERCHAT_WEBHOOK_SECRET` equals Live's
   `powerchat_webhook_secret`). Do this only at step E4 of the sequence, **not before**: Live freezes
   first, and Billing is frozen to hold deliveries. A 410 from Live makes PowerChat disable the endpoint
   (Billing `docs/live-cutover.md:131-134, 170-175`).
2. **Cloudflare DNS, for step F.** Create an A record `ingest.openre.stream` pointing at the host's IP,
   **DNS only (grey cloud)**. RTMP cannot go through Cloudflare's proxy (OpenRe `README.md:145`,
   `deploy/nginx/openre.stream.conf:15-17`).
3. **Port 1936/tcp, for step F.** Open it in the host firewall **and** at the provider edge (OpenRe
   `README.md:145,160`).
4. **Broadcaster windows, for step F.** For each slot, agree a maintenance window with its broadcaster.
   The slot is offline, and the broadcaster regenerates the key and pastes the new server into OBS
   (ADR-009).
5. **Cloudflare browser cache TTL** (ADR-016, not a cutover, but it affects every deploy). Set the zone
   to "Respect existing headers". Today Cloudflare raises `/shared/*` `max-age=300` to 4 h.

## 0. Deploy rules that apply to every step

These rules are learned from outages. `ovhost` encodes them (see [README](../README.md#purpose)). As of
2026-09-23 it is used read-only on the host, so the per-repo scripts are still what runs.

- **Live**: `sudo /opt/openvibe.live/deploy/scripts/deploy.sh [--wait-idle|--restart|--force]`
  (`deploy/scripts/deploy.sh:7-12`).
  - Production uses the legacy in-place layout (Live `docs/deploy.md:31`). `--rollback` is refused
    there (`deploy.sh:347`), and a failed-readiness rollback resets the checkout without restoring
    `node_modules`. The release layout (`deploy/scripts/migrate-to-releases.sh`) is register entry C-76.
  - **`openvibe-live.socket` survives restarts.** It has no `PartOf=`
    (`deploy/systemd/openvibe-live.socket:13-23`). The script makes sure it is active and restarts only
    `openvibe-live` (`deploy.sh:205-222`). HTTP queues on the socket during boot. WebSocket, WHIP, WebRTC
    and RTMP sessions drop and reconnect. **Never stop or restart the socket.**
  - Readiness: polls `/api/ready` every 1 s for up to 90 s. If it is not ready, the script rolls back and
    exits 3; if the rollback also fails, it exits 4 (**manual intervention**) (`deploy.sh:31-32,139-147`).
  - `--wait-idle` polls `/api/streams` every 60 s and needs 2 idle checks in a row, for up to 8 h
    (`deploy.sh:120-137`). The script treats a failed `curl` as zero streams (`deploy.sh:121-125`).
    Check by hand when it matters.
  - `public/`, `docs/` and tests deploy without a restart. Schema changes take an online backup to
    `data/backups/live-<ts>.db` first (`deploy.sh:192-203`). `deploy/nginx/` is **never** installed by
    the script.
  - Owner decision, 2026-09-23: restarts while streamers are live are permitted "for now". Prefer
    `--wait-idle` when it costs nothing, and say when a restart hit a live stream.
- **Media**: there is **no deploy script** in the repo. Pull, `npm ci --omit=dev` if dependencies
  changed, then `systemctl restart openvibe-media`.
  - **Do not restart Media while it is recording** (hazard H3,
    `OpenVibe.Network/docs/roadmap-baseline/10-hazards.md:11`). Check first:
    `curl -s 127.0.0.1:4100/api/ready | jq .recordings_in_progress`, or ovhost's probe
    `SELECT count(*) FROM vods WHERE is_recording = 1` run read-only as the service user.
  - If a restart does cut a recording: 5 s after boot, Media finalizes every `is_recording = 1` row that
    has no ffmpeg. It merges chunks, remuxes, falls back to `.master.mkv`, and marks very short results
    `needs_review` (`server/index.js:197-210`, `server/vod/finalize.js`). Interrupted clips are marked
    failed.
  - **Known gap:** the unit's `TimeoutStopSec=30` (`deploy/systemd/openvibe-media.service:16`) is
    shorter than the recorder's ffmpeg stop grace (`VOD_STOP_GRACE_MS`, default 60 000 ms,
    `server/vod/recorder.js:35`). systemd therefore SIGKILLs a stop that is still flushing a recording,
    and the boot sweep has to recover it.
- **Tools**: `deploy/scripts/deploy.sh` (run from the checkout).
  1. Fetch, and drop untracked lockfiles that the incoming release tracks.
  2. `git pull --ff-only`, and `npm install --omit=dev` in apps whose `package.json` changed.
  3. Reinstall any dependency that does not resolve. If it still does not, **ABORT, nothing restarted**.
  4. Check that img, audio and docs load the jobs runtime.
  5. Restart **all** `openvibe-tools*` units at once, then curl the gateway's `/api/health`.

  (`deploy/scripts/deploy.sh:1-42`.) It has **no automatic rollback** and does not check `/api/ready`.
  `apps/gateway/deploy/scripts/deploy.sh` is the superseded per-app script. Do not use it.
- **OpenRe.Stream**: `sudo bash /opt/openre.stream/repo/deploy/scripts/deploy.sh release|api|workers|status|prune`.
  - `api` restarts the API and coordinator only, polls `/api/ready` for 60 s, and rolls back on failure
    (exit 2).
  - `workers` starts a new generation. The old ones drain for up to 30 min.
  - **Never `systemctl restart` a worker instance during a broadcast.** (OpenRe `README.md:147-160`.)
- **Everything else** (Network, Community, Events, Chat, Billing, and the loopback services): pull,
  install if the lockfile changed, restart the unit, then poll `/api/ready`. Network's own
  `deploy.sh` and Sites' `deploy.sh` exist (Host `README.md`, rules table).
- **Always**:
  - Stage explicit paths when committing on the host. Never `git add -A`: on 2026-09-23 02:09 it
    committed half-done work and took Network down for two minutes.
  - Production WebSocket probes send `join` only, never `chat` or `dm` frames.
  - Take `sudo ovhost backup <service>` before any data move.

## A. Pastes → OpenVibe.Community (Wave 5): DONE 2026-09-22

Community owns pastes and comments (ADR-011). Production values:

| Service | Setting | Effect |
|---|---|---|
| Community | `PASTES_AUTHORITY=community` in `community.env` | Serves pastes natively. The database is `/var/lib/openvibe-community/community.db`. |
| Live | `PASTES_AUTHORITY=community` in `live.env` | `/api/pastes` forwards to Community with a service token (`server/pastes-client.js`, `server/media-proxy/pastes.js:250-319`). |
| Media | `PASTES_FROZEN_APPS=live` | Paste writes answer 410 (`server/pastes/routes.js:47-55`). |
| Media | `PASTES_MOVED_TO=https://openvibe.community` | 301 for `/p/:slug` and raw text (`server/public/routes.js:446-494`). |
| Tools | none | Forwards `/api/pastes/*` to Community with the visitor's token, and has no switch (`apps/gateway/server/index.js:183-207`). |

Import: 889+2 pastes, 60 comments, 48 likes. Held: 1 paste and 4 comments, `ambiguous_owner`. Shadow
parity before the flip was 878/878 (ADR-011 §Migration consequences).

**Verify:** `curl -s 127.0.0.1:4200/api/ready | jq .pastes_authority` must print `"community"`.

**Rollback** (ADR-011 §Rollback):
1. Export the writes made in Community since the cutover. **No export tool exists.** Write one before you
   need it (register C-10).
2. Set `PASTES_AUTHORITY=live` in `community.env` and `live.env`.
3. Remove `PASTES_FROZEN_APPS` and `PASTES_MOVED_TO` from `media.env`.
4. Restart Community, Live and Media.

   Tools has no switch: revert `fd5d318` in Tools and deploy. Community deletes are soft and never
   remove Media bytes.

## B. Chat → OpenVibe.Chat (Wave 6): DONE 2026-09-23 02:03 UTC

Chat serves `/ws/chat`, `/api/chat/`, `/api/dm/`, `/api/tts/` and `/api/sounds`. It runs on
127.0.0.1:4400 (`openvibe-chat`) with `/var/lib/openvibe-chat/chat.db`, `LIVE_MIRROR=1` and `EVENTS_URL`
set. Traffic reaches it through `include /opt/openvibe.chat/deploy/nginx/*.locations.conf;` in
openvibe.live's vhost. Live runs `CHAT_AUTHORITY=chat` and `OV_CHAT_INTERNAL_URL`. Its chat tables are a
read mirror kept current by Chat (register C-01–C-03).

Record of the run (Chat `docs/cutover.md`):
- Prerequisites `:51-84`: Network principal `chat` and grants; Live patch deployed without the flag;
  Chat installed and not started.
- Rehearsal `:86-123`.
- Cutover `:125-167`:
  1. Start Chat and import snapshot 1.
  2. Set `CHAT_AUTHORITY=chat`, restart Live, add the include, `nginx -t && systemctl reload nginx`.
  3. Import pass 2. `held` must be 0.
  4. Check that `mirror.pending` and `chat_bridge_outbox` are near 0, and that no `ChatRemote` refusals
     appear.
- Imports: pass 1 had 70,860 messages, held 0. Parity was 15/15 read paths (ADR-010 §Acceptance tests).
- The pre-cutover nginx backup is `/root/openvibe.live.conf.pre-chat-<ts>` on the host.

**Verify:** `curl -s 127.0.0.1:4400/ready | jq '.live, .mirror'`.
- `mirror.pending` should be near 0.
- `live.failures` should not grow.

`/ready` stays 200 while Live syncs fail (see [storage-state.md](storage-state.md) finding 1), so read the
body, not just the status.

**Rollback** (Chat `docs/cutover.md:169-184`, ADR-010 §Rollback). The order matters:
1. Remove the include from openvibe.live's vhost, then `sudo nginx -t && sudo systemctl reload nginx`.
   Chat traffic returns to Live, which answers 503 until step 3.
2. Make sure everything Chat wrote has reached Live. `curl -s 127.0.0.1:4400/ready | jq .mirror.pending`
   must be `0`. If Chat is down, run `scripts/mirror-flush.js` in the Chat checkout; exit 0 means it is
   drained. This must happen **before** step 3, because Live accepts mirror writes only while
   `CHAT_AUTHORITY=chat`.
3. Remove `CHAT_AUTHORITY` from `/etc/openvibe/live.env` and restart Live
   (`deploy.sh --restart`). At boot, `drainToLocal()` applies `chat_bridge_outbox` to Live's own tables
   (`server/chat/chat-remote.js:351-372`). A write Chat applied but never acknowledged is applied twice
   (`:354`).
4. `sudo systemctl stop openvibe-chat`. Keep `/var/lib/openvibe-chat/chat.db`.

## C. AI → OpenVibe.AI (Wave 13): DONE 2026-09-23

OpenVibe.AI runs on 127.0.0.1:4700 as principal `ai`, with `/var/lib/openvibe-ai/ai.db`. Live runs
`AI_SERVICE=remote` (`server/ai/ai-service.js:39`). With it, `llm.complete`, translation, paste/frame,
overview, media and recap calls go through AI workflows. There is **no fallback to Live's own key** when
AI returns nothing (`server/ai/llm.js:299-313`). Streamer BYO providers bypass AI.

Steps from AI `docs/migration.md:72-99`:
- Steps 1-6 (deploy, import, grants, Live `AI_SERVICE=remote`, verify) are **DONE**.
- Step 7 is **DONE**: Network calls `network.site_copy` itself (Network `422f8e9`). Live's
  `/internal/ai/site-copy` remains as Network's fallback (register C-21).
- The Live grant names its namespaces (`live.*`, `network.site_copy`; Network `988330b`), and AI fails
  closed on a token with no `ns` (register C-22/C-23).

**Verify:**
- `curl -s 127.0.0.1:4700/api/ready`.
- `GET /api/v1/runs?workflow=live.translate` shows recent succeeded runs.
- `journalctl -u openvibe-live | grep '\[AI service\]'` is empty.

**Rollback** (AI `docs/migration.md:101-103`, ADR-015 §Rollback):
1. Unset `AI_SERVICE` in `live.env` and restart Live. Live then uses its own provider settings. **Keep the
   shared key in Live's settings** until C-20's removal date. Without it, this rollback has no provider.
2. Namespace problems only: set `AI_NS_FALLBACK` back to its default, or set `AI_NS_REQUIRED=false`, in
   `ai.env`, then restart AI.

Stopping OpenVibe.AI touches no product data.

## D. Events delivery signature v2: IN PROGRESS

Events signs every attempt with v1 (`X-OpenVibe-Signature`) **and** v2 (`X-OpenVibe-Timestamp`,
`X-OpenVibe-Signature-V2` = HMAC of `"<t>.<raw body>"`, ±300 s) (Events `server/worker.js:56,66-68`).
v1 cannot be switched off by env.

| Step (Events `docs/replay-window-rollout.md:22-34`) | State |
|---|---|
| 1. Tag openvibe-sdk `v0.4.0` | **DONE**: the tag exists. The doc's status line (`:3`) is stale. |
| 2. Deploy Events. Confirm one real delivery carries the v2 headers. Compare `date +%s` with a trusted clock. | **DONE**: Events sends v2 (operator notes). |
| 3. Codes docs | **DONE** in the repo (Codes `a9371c3`). The tester still checks v1 only (register C-61). |
| 4. Consumers, one at a time, in this order: Live (`/internal/openre-events`), Search, News, Deals, Trade, Reviews, then Tips and VIP after a clean day, then Examples | **Committed in every repo**: Live `ae07553`, Search `5a7e59b`, News `1802e7d`, Deals `e72aeec`, Trade `9a55644`, Reviews `3151c05`, Tips `435f32b`, VIP `dc98781`, Examples `6ea9cfd`. **Deployed: unknown.** Check `git -C /opt/openvibe.<svc> log -1` for each. |
| 5. Stop sending v1 (optional; only after every consumer requires v2) | **NOT STARTED** (register C-60, target 2026-10-07) |

For each consumer deploy:
- Pin `openvibe-sdk` v0.4.0 (Search has no SDK), run `npm test` on Node 22, and deploy.
- Watch that service for `401 *.bad_signature`.
- Watch Events with `GET /api/v1/deliveries?status=failed&subscription_id=…`.

**Rollback** (rollout doc `:36`, ADR-004): redeploy the consumer's previous release, which unsets
`requireV2`. Events keeps retrying for about 2 h 13 min (1 s, 5 s, 30 s, 2 min, 10 min, 1 h, 1 h), then
moves the delivery to the DLQ. Requeue with `POST /api/v1/deliveries/replay { subscription_id, event_ids }`
or `{ subscription_id, from_seq }`. Replays are signed afresh, and the consumer inbox dedupes on
`event_id`. Rolling back Events itself is safe only while no consumer requires v2.

## E. Money → OpenVibe.Billing: BLOCKED on the owner (PowerChat dashboard)

Billing runs in shadow on 127.0.0.1:4600 (principal `billing`), and its staff console is public at
`https://billing.openvibe.network`. Live is the authority: `BILLING_AUTHORITY` unset = `live`
(`server/monetization/money-authority.js:26-31`). Billing's own status is "prepared, **not executed**"
(Billing `docs/live-cutover.md:3`).

**Before the day** (Billing `docs/live-cutover.md:56-102`):

| Prerequisite | State |
|---|---|
| 1. `billing.env`: `POWERCHAT_WEBHOOK_SECRET` equal to Live's, `POWERCHAT_SITE_USERNAME`, `POWERCHAT_ALLOW_TEST_FULFILLMENT` off, `BILLING_*` rates equal to Live's | `POWERCHAT_SITE_USERNAME` set 2026-09-23 (operator notes). The rest: unknown. Check with `sudo ovhost validate billing`, which prints names only. |
| 2. Network grants for client `live`: `billing.intent.create`, `billing.transfer.create`, `billing.balance.read`, `billing.cashout.request`, `billing.subscription.manage`, `billing.entitlement.check`, plus `identity.subject.resolve`. **Not** `billing.cashout.manage` or `billing.ledger.admin`. | **DONE** (operator notes: Live granted `billing.*` except `cashout.manage` and `ledger.admin`) |
| 3. Staff console: redirect URI, `BILLING_STAFF_SUBJECTS`, `BILLING_SESSION_SECRET`, vhost, sign-in works | **DONE** (console live; staff subject is the owner only) |
| 4. Live patch deployed with `BILLING_AUTHORITY` unset; `/api/admin/money` shows `authority: "live"` | **DONE** (Live `c384787`) |
| 5. `identity-legacy-sync` has run since the last new account; a fresh shadow import has no holds for anyone with a balance | Shadow import done 2026-09-23: 322 transactions, reconcile OK. Re-run it on the day. |

**The sequence** (Billing `docs/live-cutover.md:116-168`). Keep the order: it guarantees that every
PowerChat delivery lands in exactly one ledger.

0. Check who is live: `curl -s https://openvibe.live/api/streams`. Step 6 restarts Live.
1. Freeze Live money writes: `POST /api/admin/money/freeze {on:true, reason:'Billing cutover'}` (owner).
   `GET /api/admin/money` must show `frozen: true`.
2. Wait **at least 60 minutes**, because minted PowerChat links live for an hour. Then run
   `POST /api/powerchat/reconcile`. List `payment_orders` that are `pending` or `paid` from the last 3
   days. A `paid` row is an anomaly; fix it first.
3. Back up Billing to `/var/lib/openvibe-billing/billing-pre-cutover.db`, **keep it for rollback**. Then
   run `node scripts/freeze.js on 'Live cutover'`.
4. **Owner: re-point the PowerChat webhook** (see "What the owner must do", item 1). From here on, Billing
   stores and holds every delivery (202).
5. Take the final snapshot to `/var/backups/openvibe/live-cutover-<date>.db` and **keep it**. Run
   `import-live.js --dry-run`, then the import, then `reconcile.js`. `holds` must be empty for anyone with
   money, and reconciliation must print **OK**.
6. Add `BILLING_AUTHORITY=billing`, `OV_BILLING_INTERNAL_URL=http://127.0.0.1:4600` and
   `OV_BILLING_PUBLIC_URL=https://billing.openvibe.network` to `live.env`. Run
   `sudo /opt/openvibe.live/deploy/scripts/deploy.sh --wait-idle`.
   `GET /api/admin/money` must show `authority: "billing"`, `reachable: true` and `drift: []`.
7. Unfreeze Billing with `node scripts/freeze.js off`. Held deliveries settle once. Deliveries that Live
   already credited are rejected (`billing.intent_settled_in_live`). Then `reconcile.js` must print OK.
8. Verify the reads while Live is still frozen: balances match, and `billing.actions.attention: []`.
9. Unfreeze Live: `POST /api/admin/money/freeze {on:false}`.
10. Make a real 100-Vibes PowerChat purchase. Expect one settled event, +100 exactly once, reconcile OK,
    and Live's legacy columns unchanged.

**Rollback** (Billing `docs/live-cutover.md:177-200`):
- **Before step 6:**
  1. Re-point PowerChat back to `https://openvibe.live/api/powerchat/webhook`.
  2. Leave Billing **frozen**.
  3. Unfreeze Live. Live's reconciler (every 15 min) backfills payments made in the window.
- **After step 6, before step 9:**
  1. Remove `BILLING_AUTHORITY` and run `deploy.sh --wait-idle`.
  2. Re-point PowerChat to Live and unfreeze Live.
  3. Stop Billing, restore `billing-pre-cutover.db` (delete its `-wal`/`-shm` files), freeze it, and start
     it.
- **After step 9:** ADR-012's rollback re-derives Live's columns from Billing's journal. **No tool for this
  exists.** It is manual and lossy. Prefer fixing forward.

**What the switch does not preserve** (`:202-239`):
- PowerChat side effects that arrived on Live's webhook (chat lines, alerts, goals) stop at the re-point.
- Displays that read Live's `transactions` table freeze.
- Renewal notices stop.
- The SPA sends no `Idempotency-Key` yet.

Read the full list before choosing the day. VIP checkout stays closed until this cutover.

## F. RTMP ingest → OpenRe.Stream: BLOCKED on the owner (DNS, port 1936, broadcaster windows)

OpenRe is deployed. The API is `openre-api` on 127.0.0.1:4500. The other units are
`openre-session-coordinator`, `openre-rtmp-ingest@<sha>` and `openre-restream-worker@<sha>`. The database
is `/var/lib/openre/openre.db`. RTMP is bound to 127.0.0.1:1936 (`OPENRE_RTMP_BIND`). A loopback rehearsal
with an ffmpeg test pattern passed: the session went live→ended, a wrong key was refused, `openre.session.*`
reached Events, and the key never appeared in logs.

Live carries the integration (`f0ca18b`). It is inert until `OPENRE_URL` is set. `ingest_authority`
defaults to `live` on every slot (`server/openre/schema.js:5-7`), and only RTMP moves
(`server/openre/authority.js:18`). WHIP, JSMPEG and SFU are **not ported** (OpenRe `README.md:207-209`).

**Once, before the first slot** (OpenRe `README.md:188-194`):

| Step | State |
|---|---|
| 1. Network client `openre` and its grants; release the contract proposals | **DONE** (operator notes: principal `openre` in `openre.env`; openre capabilities released by contracts v0.19.0) |
| 2. Deploy OpenRe; `curl 127.0.0.1:4500/api/ready` shows ready, with one ingest worker, one restream worker and a valid coordinator lease | **DONE** |
| — Owner: DNS-only `ingest.openre.stream`; 1936/tcp open at the host and provider edge; RTMP bound publicly (`OPENRE_RTMP_BIND`) | **BLOCKED (owner)** |
| 3. Events subscription `openre.session.*` → `http://127.0.0.1:3000/internal/openre-events`; its secret in Live as `OPENRE_EVENTS_SECRET` | Unknown. Check `GET /api/v1/subscriptions` on Events and `ovhost validate live`. |
| 4. Live: `OPENRE_URL=http://127.0.0.1:4500`, `OPENRE_PUBLIC_URL`, then `deploy.sh --wait-idle`. With no slot switched this changes nothing. | Unknown. Check `GET /api/admin/openre/status`. |
| 5. Rehearsal with a test account from OBS to `rtmp://ingest.openre.stream:1936/live`. Deploy Live and `deploy.sh api` during the broadcast, and check that nothing drops. | Needs the DNS and port first |

**Per slot** (`README.md:196-203`; `migrate-from-live.js --checklist` prints the same list):
1. Agree a window with the broadcaster. The slot must be offline.
2. Run `node scripts/migrate-from-live.js --live-db <fresh snapshot> --apply --slots <id>`. Review held
   destinations on openre.stream.
3. `PUT /api/admin/openre/managed/<id>/ingest-authority {"authority":"openre"}` on Live. From then on,
   Live refuses the old key and has rotated its own copy (`server/openre/authority.js:103-146`).
4. The broadcaster presses **Regenerate stream key** on Go Live (it is shown once) and sets OBS to
   `rtmp://ingest.openre.stream:1936/live`.
5. Rotate the broadcaster's personal Live key (`users.stream_key`). ADR-009 requires every pre-cutover
   key to be rotated.
6. Test a broadcast. Watch `deploy.sh status`, `/api/admin/openre/status` and output health.

**Rollback:**
- Per slot: `{"authority":"live"}`. The broadcaster regenerates the key on Live and points OBS back at the
  Live RTMP URL.
- All slots: unset `OPENRE_URL` in `live.env` and restart Live (`README.md:205`,
  `server/openre/authority.js:47-49`).
- Live's ingest code stays until the last protocol has run on OpenRe for two weeks (ADR-009 §Rollback).
- Port 1935 moves to OpenRe (`OPENRE_RTMP_EXTRA_PORTS=1935`) only after Live stops listening
  (`README.md:139-145`).

## G. Retiring the shims: NOT STARTED

Every remaining shim has an owner, a removal condition, a date and a rollback lever in
[compatibility-register.md](compatibility-register.md). The ones on the critical path:

- **The shared internal key** (C-50–C-58), per Network `docs/retirement.md`:
  1. Move each caller to a service token by 2026-10-09.
  2. Remove each key path after 14 days with no legacy use. Check with the `principal_usage` query in
     that doc.
  3. Delete `INTERNAL_API_KEY` from every env file by 2026-11-06.
- **The hard-coded `openvibe-internal-2026` secret** in Live cosmetics (C-59): remove it by 2026-10-09.
- **Events v1 signatures** (C-60): stop them after every consumer is deployed with `requireV2`.
- **Chat's Live mirror** (C-01–C-03), and Live's frozen legacy tables and their readers (C-73): target
  2026-11-06.

Before removing a shim, take `sudo ovhost backup <service>` for any service whose data it touches. Update
the register row in the same change.
