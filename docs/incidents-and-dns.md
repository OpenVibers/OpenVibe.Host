# Incidents, maintenance, freezes and DNS

Roadmap WS-N task 12. Containers are decided in [ADR-032](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-032-containers.md): platform services stay systemd units.

## Incidents and maintenance (the public status page)

Every command here posts to openvibe.network/status (Contracts 0.66.0 `network.status-incident-request@1`).
It uses Host's service token (`network.status.incident`) from `/etc/openvibe/host.env`, the same credentials as
release notifications.

```bash
sudo ovhost incident open --title "Live streams stall on start" --services live --severity major \
     --message "New streams take a minute to start. We are on it."
sudo ovhost incident update inc_… --state identified --message "A restart left the ingest socket unbound."
sudo ovhost incident update inc_… --state resolved --message "Rebound; streams start at once again."
sudo ovhost incident list

sudo ovhost maintenance schedule --title "Media storage move" --services media \
     --from 2026-09-28T03:00:00Z --until 2026-09-28T04:00:00Z --message "Uploads pause for up to an hour." --freeze
sudo ovhost maintenance start inc_… --message "Moving now."
sudo ovhost maintenance complete inc_… --message "Done."        # also lifts the window's freezes
```

- **Incident states:** investigating, identified, monitoring, resolved.
- **Maintenance states:** scheduled, in_progress, completed.
- **Closed:** a resolved incident or completed window refuses further updates.
- **Messages are public:** no internal hostnames, secrets or personal data.
- **Staff admins** can post the same through `POST /api/v1/status/incidents` with their session.

## Freezes (deploy holds)

```bash
sudo ovhost freeze live --reason "incident: streams stall" --incident inc_…
sudo ovhost freeze all --reason "network-wide change window"
sudo ovhost freeze                 # what is frozen
sudo ovhost unfreeze live
```

- **A frozen service's `ovhost deploy`** refuses with exit 6. `--force` deploys through and says so in the log.
- **Rollbacks are never frozen:** they are how an incident ends.
- **Storage:** freezes live in `/var/lib/openvibe-host/freeze/`.

## DNS (Cloudflare)

These run on the operator's workstation, where the token is (`~/.config/cloudflare-token`, or `--token-file`).
The production host holds no Cloudflare token. No inventory is needed.

```bash
node lib/cli.js dns list openvibe.live
node lib/cli.js dns ensure beta.openvibe.live CNAME openvibe.live --proxied            # dry run
node lib/cli.js dns ensure beta.openvibe.live CNAME openvibe.live --proxied --apply
node lib/cli.js dns delete beta.openvibe.live CNAME --apply
```

- **Proxy mode:** web records name theirs (`--proxied` or `--dns-only`).
- **Never proxied:** names in the inventory's `dns.dnsOnly`. The default list is `ingest.openvibe.live`,
  `relay.openvibe.live`, `turn.openvibe.live`, `cname.openvibe.host` and `ingest.openre.stream`, as of
  2026-09-26. Service records (`_dmarc`, `*._domainkey`) are never proxied either.
- **One record per name and type:** duplicates of a name and type are refused and must be resolved by hand.
- **Dry run by default:** nothing changes without `--apply`. The token is never printed or written.
