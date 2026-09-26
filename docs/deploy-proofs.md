# Stateful deploy proofs (roadmap WS-P task 3)

Each proof is a recorded production run: what was deployed, how it was observed, and what the observer saw.

| Proof | State | Record |
|---|---|---|
| Web drain (Live) | passed 2026-09-26 | [below](#web-drain-live-2026-09-26) |
| Recorder / media-worker checkpoint (Media) | open | needs a live ingest during a Media deploy |
| Chat resume (Chat) | passed 2026-09-26, with a limit | [below](#chat-resume-chat-2026-09-26) |
| Game shard (Games) | passed 2026-09-26 | [below](#game-shard-games-2026-09-26) |
| Ingest worker (OpenRe) | after the cutover (WS-H) | |

## Web drain (Live), 2026-09-26

**Method.** A probe on a workstation, through Cloudflare and nginx like any visitor, requested three URLs in turn every 100 ms: `https://openvibe.live/`, `/api/ready` and `/js/app.js`, each with a unique `?probe=` so no cache answered. It recorded the status and total time of each request (10 s timeout) from before the deploy until after it. The deploy is `cd /opt/openvibe.live/current && sudo deploy/scripts/deploy.sh`, which restarts `openvibe-live.service` under its systemd socket (`openvibe-live.socket`, `127.0.0.1:3000`), so connections that arrive mid-restart wait in the kernel accept queue.

**First run (09:59, release `53c9abd`): failed, and found a fault.** 100 requests: 95 × 200, **4 × 502** in one 0.6 s burst at 09:59:36 (nginx: `connect() failed (111: Connection refused)`), and 1 timeout just after. systemd did not hold the listener: the release layout's socket unit still said `0.0.0.0:3000` (the 2026-09-23 loopback fix had reached only the in-place copy) and carried `NonBlocking=` in `[Socket]`. Installing it on 2026-09-25 had dropped the socket's descriptor ("no socket file descriptors are open ... not functional until restarted"), so the service bound `0.0.0.0:3000` itself. Two consequences: every restart refused connections, and Live answered on the server's public IP past Cloudflare and nginx. The deploy script reported "socket unit active" because it checked only `is-active`.

**Repair.** The fixed units were installed by hand (backup `/etc/systemd/system/openvibe-live.socket.bak-20260926`), then the service stopped, the socket restarted and the service started: `LISTEN_FDS=1`, `ss` shows `127.0.0.1:3000` held by both `systemd` (pid 1) and `node`, and the public `:3000` no longer answers. Live `ab8abff` makes both unit copies the loopback one (`test/systemd-units.test.js`), moves `NonBlocking=` to the service drop-in, makes `deploy.sh` check that systemd really holds the listener and rebind a changed or dropped socket, and binds `127.0.0.1` in production when there is no `LISTEN_FDS`.

**Second run (10:05, release `ab8abff`): passed.** 57 requests from 10:05:07 to 10:05:24, all 200. The 20 requests in the deploy window (10:05:17 to 10:05:23) had a median of 0.134 s. The slowest, 0.955 s at 10:05:21 (`/api/ready`), was a connection that waited in the socket's queue while the new process started. The deploy reported ready after 2 s.

**What this does not cover.** Established connections (WebSockets, WHIP sessions, RTMP ingests, WebRTC transports) live in the process and end with it; clients reconnect. That is the Chat-resume and recorder proofs above.

## Chat resume (Chat), 2026-09-26

**Method.** A probe on a workstation opened `wss://openvibe.live/ws/chat` (served by OpenVibe.Chat) as an anonymous client and joined global chat, remembering the newest message id it had seen (80891 at the start). On any close it reconnected after 1 s (doubling to 8 s), sent the join again, and read `GET /api/chat/global/history?after_id=<last seen>` to pick up what it missed, counting new and duplicate ids. Chat was restarted under it with `systemctl restart openvibe-chat`, the restart every Chat deploy makes (`ovhost deploy chat` had no new commit to deploy, so it did not restart).

**Result.** The socket closed at 11:29:35.5 UTC (code 1005). The client was connected again at 11:29:36.6, 1.1 s later, with a 103 ms connect. The cursor read returned 0 missed and 0 duplicate messages. `/api/ready` answered at 11:29:56, about 21 s after the restart: the WebSocket accepts connections before readiness completes, which an anonymous join does not notice.

**Limit.** Global chat was quiet, so no message was written during the 1.1 s gap. The catch-up path was exercised but not with a message in the gap. A proof with traffic needs a test account posting in a test room, or the integration environment (WS-Q task 2), since writing probe lines into public chat is not acceptable.

## Game shard (Games), 2026-09-26

**Method.** A probe opened `wss://openvibe.games/ws` (through Cloudflare and nginx), then Games was restarted with `systemctl restart openvibe-games`, the restart a Games deploy makes. On a close the probe waited 500 ms and connected again. No player was online (readiness `sessions.online` 0).

**Result.**
- **Graceful stop: passed.** SIGTERM at 12:36:03.0 UTC; Games logged `world saved on shutdown` and `stopped` 34 ms later (1 player session, 0 editors, 0 terminated, 0 requests cut). The client got close code **1012 `server_restart`** at 12:36:03.5. `/api/ready` answered again at 12:36:05.1.
- **Reconnect during the restart: a probe artefact, one edge left.** The probe's reconnect, started at about 12:36:04 while Games was down, neither opened nor failed for over 40 s, while a fresh connection afterwards opened in 165 ms (Games attaches its upgrade handler before it listens, so the wait is most likely Cloudflare holding the upgrade while the origin restarts). The real game client does not do this: on close it polls `/healthz` every 2 s and reloads the page once Games answers (`apps/client/src/main.ts`), so players come back with a clean resync. The edge left: a page that opens its first connection during the 2 s gap waited without a timeout on "connecting…". Fixed the same day (Games `b207e78`): the first connect gives up after 10 s, and a refused or timed-out connect waits for `/healthz` and reloads like a dropped one.
- World state survived the restart (saved on shutdown, loaded on boot); a state-level check (a placed tile before and after) needs a game-protocol client.

