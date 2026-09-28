# The node registry reporter

`ovhost nodes report` tells OpenVibe.Network which machines this inventory runs, and how healthy each one is right now.

- It is roadmap WS-X1 step 3 and ADR-034 section 12.
- `openvibe-nodes.timer` runs it every five minutes.
- Products read the result at `GET https://openvibe.network/api/v1/nodes`, which returns `network.node-list-result@1`. It can be filtered with `?role=` and `?region=`. `openvibe-sdk/geo` uses it to pick the nearest node for a role, for example a game-server list or a ping tool with several locations.

## The inventory

`/etc/openvibe/host.json` holds two keys for this:

- **`nodeSource`** names this inventory. The default is `primary`.
- **`nodes`** lists each machine's public description, which is `network.node@1` without `health` and `updated_at`.

```json
"nodeSource": "oregon",
"nodes": [
  { "id": "oregon-1", "name": "Oregon 1", "roles": ["web", "app", "data", "ingest"],
    "location": { "region": "us-west", "country": "US" }, "provider": "ovh",
    "beacon": "https://openvibe.network/api/v1/nodes/oregon-1/beacon" }
]
```

The registry is public, so the inventory refuses any node that carries an `address` or `ip`. Location stays at region level.

## Health

Health is measured, never assumed. Each node's beacon is fetched on every run:

| Beacon result | Health |
|---|---|
| a 2xx within 2 s | `up` |
| a slower 2xx | `degraded` |
| anything else | `down` |

A node removed from the inventory is marked `down` by Network. It is not deleted.

## Running it

```
sudo ovhost nodes report --dry-run   # measure and print; nothing is sent
sudo cp /usr/local/lib/openvibe-host/deploy/systemd/openvibe-nodes.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openvibe-nodes.timer
```

- **Credentials:** it uses Host's principal from `/etc/openvibe/host.env`, the same one `ovhost alerts relay` uses, with the scope `network.node.report`. Neither the secret nor the token is ever printed.
- **Metrics:** each run writes `openvibe_nodes_report.prom` to the textfile collector.
- **Alerts:** `OpenVibeNodeReportStale` fires when no report has reached Network for an hour. `OpenVibeNodeDown` fires when a beacon has failed for 15 minutes.
