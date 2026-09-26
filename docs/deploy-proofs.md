# Stateful deploy proofs (roadmap WS-P task 3)

Each proof is a recorded production run: what was deployed, how it was observed, and what the observer saw.

| Proof | State | Record |
|---|---|---|
| Web drain (Live) | passed 2026-09-26 | [below](#web-drain-live-2026-09-26) |
| Recorder / media-worker checkpoint (Media) | open | needs a live ingest during a Media deploy |
| Chat resume (Chat) | open | a subscribed client across a Chat deploy |
| Game shard (Games) | open | a connected client across a Games deploy |
| Ingest worker (OpenRe) | after the cutover (WS-H) | |

## Web drain (Live), 2026-09-26

**Method.** A probe on a workstation, through Cloudflare and nginx like any visitor, requested three URLs in turn every 100 ms: `https://openvibe.live/`, `/api/ready` and `/js/app.js`, each with a unique `?probe=` so no cache answered. It recorded the status and total time of each request (10 s timeout) from before the deploy until after it. The deploy is `cd /opt/openvibe.live/current && sudo deploy/scripts/deploy.sh`, which restarts `openvibe-live.service` under its systemd socket (`openvibe-live.socket`, `127.0.0.1:3000`), so connections that arrive mid-restart wait in the kernel accept queue.

**First run (09:59, release `53c9abd`): failed, and found a fault.** 100 requests: 95 × 200, **4 × 502** in one 0.6 s burst at 09:59:36 (nginx: `connect() failed (111: Connection refused)`), and 1 timeout just after. systemd did not hold the listener: the release layout's socket unit still said `0.0.0.0:3000` (the 2026-09-23 loopback fix had reached only the in-place copy) and carried `NonBlocking=` in `[Socket]`. Installing it on 2026-09-25 had dropped the socket's descriptor ("no socket file descriptors are open ... not functional until restarted"), so the service bound `0.0.0.0:3000` itself. Two consequences: every restart refused connections, and Live answered on the server's public IP past Cloudflare and nginx. The deploy script reported "socket unit active" because it checked only `is-active`.

**Repair.** The fixed units were installed by hand (backup `/etc/systemd/system/openvibe-live.socket.bak-20260926`), then the service stopped, the socket restarted and the service started: `LISTEN_FDS=1`, `ss` shows `127.0.0.1:3000` held by both `systemd` (pid 1) and `node`, and the public `:3000` no longer answers. Live `ab8abff` makes both unit copies the loopback one (`test/systemd-units.test.js`), moves `NonBlocking=` to the service drop-in, makes `deploy.sh` check that systemd really holds the listener and rebind a changed or dropped socket, and binds `127.0.0.1` in production when there is no `LISTEN_FDS`.

**Second run (10:05, release `ab8abff`): passed.** 57 requests from 10:05:07 to 10:05:24, all 200. The 20 requests in the deploy window (10:05:17 to 10:05:23) had a median of 0.134 s. The slowest, 0.955 s at 10:05:21 (`/api/ready`), was a connection that waited in the socket's queue while the new process started. The deploy reported ready after 2 s.

**What this does not cover.** Established connections (WebSockets, WHIP sessions, RTMP ingests, WebRTC transports) live in the process and end with it; clients reconnect. That is the Chat-resume and recorder proofs above.
