# OpenVibe.Host

> The network's deployment/control plane first; then isolated hosting for community sites, bots and mods.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `openvibe.host`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.3.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Stage A consolidates the deploy/TLS/nginx/readiness/drain/rollback helpers duplicated across Live, Network, Media, Tools and Sites behind stable adapters. Stage B adds tenant static hosting on Media object storage. Stage C hosts sandboxed user code only after isolation and metering are proven.

## Owns

- service manifests and environment validation, release install/rollback, systemd/container adapters, reverse-proxy generation, certificate inventory/renewal, DNS adapters, readiness/drain orchestration, config snapshots, backup/restore hooks, incident controls
- later: tenant projects, immutable deploy artifacts, domains/TLS, build logs, quotas; sandbox profiles, budgets, secret references, outbound policy

## Does not own

- product business logic (Host calls product deploy hooks)
- platform-wide credentials for hosted code (never)

## Planned surfaces

- operator CLI/API; hosting dashboard for tenants (Stage B+)

## Data (authority tables / families)

- releases, configs, certificates, tenants, deployments, logs/metrics links

## Capabilities and events

- `host.release.*`, `host.config.*`, `host.tenant.*`, `host.deployment.*`

Events: ``host.release.deployed|rolled_back``, ``host.deployment.*``

## Depends on

- OpenVibe.Network
- OpenVibe.Media
- OpenVibe.Events
- OpenVibe.Contracts

## Acceptance (must be true before "done")

- deploy/restart/rollback one service without interrupting unrelated runtimes or protected sessions
- certificate renewal cannot expose provider credentials
- a hosted static project cannot read another tenant's objects
- killing/revoking one extension does not affect Chat/OpenRe/Live

## Bootstrap / extraction source

The deploy scripts in each current repository (`deploy/scripts/deploy.sh` variants), Network's TLS/nginx helpers and Sites' vhost generator.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
