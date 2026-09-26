# Host firewall (proposal, owner decision)

Found 2026-09-26 during the WS-P task 3 web-drain proof: the host firewall is **off** (`ufw status: inactive`, no iptables rules for service ports). Anything that binds `0.0.0.0` answers on the public IP. That is how Live's port 3000 became reachable past Cloudflare and nginx from 2026-09-25 to 2026-09-26 (fixed: Live `ab8abff`, loopback socket).

Public listeners on 2026-09-26, all intended:

| Port | Proto | What |
|---|---|---|
| 22 | tcp | sshd |
| 80, 443 | tcp | nginx |
| 1935 | tcp | Live RTMP ingest (DNS-only `ingest.openvibe.live`) |
| 1936 | tcp | OpenRe RTMP ingest |
| 3478, 5349 | tcp + udp | coturn |
| 49152–65535 | udp | coturn relay range (`min-port`/`max-port`) |
| 9710–9789 | tcp | nginx JSMPEG ports (bound to the public address) |
| 10000–10100 | udp (+ tcp) | Live mediasoup WebRTC (`MEDIASOUP_MIN_PORT`/`MAX_PORT` defaults), opened per session |
| 68 | udp | DHCP client |

Everything else (every service port 3000–4999, databases, metrics) is loopback-only today, but only by each service's own bind address.

**Proposal.** Default-deny inbound with the table above as the allow list:

```
sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow 22/tcp && sudo ufw allow 80,443/tcp && sudo ufw allow 1935,1936/tcp
sudo ufw allow 3478,5349/tcp && sudo ufw allow 3478,5349/udp && sudo ufw allow 49152:65535/udp
sudo ufw allow 9710:9789/tcp && sudo ufw allow 10000:10100/udp && sudo ufw allow 10000:10100/tcp
sudo ufw enable
```

Why it is not switched on without the owner:
- a wrong rule set can end SSH access (the provider's console is the only way back);
- it can break live WebRTC and TURN media, and the ranges must match `MEDIASOUP_*` and coturn;
- the provider's edge firewall may already filter some of these ports.

Enable it at a quiet time, with a second SSH session open, then run the browser check and a WebRTC publish and view.
