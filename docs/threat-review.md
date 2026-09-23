# Threat review: OpenVibe.Host Stage B (tenant static hosting)

Launch-rule item 6 (README, [Launch rule](../README.md#launch-rule)) and roadmap Track S require a
threat review before a service leaves placeholder status. This review covers Stage B as of this
commit:

- the Host API service (`server/`, port 4910);
- the tenant vhosts that `ovhost nginx tenants` renders (`lib/nginx.js`, `templates/nginx/`).

Stage A (`ovhost`) is covered only where it touches Stage B: vhost installation and certificates.
Stage C (tenant code) does not exist, and nothing in Stage B executes tenant content on the server.

Reviewed 2026-09-23. Fixes made during the review are in commits `1e48cb2` and `0ff29d5`. The
Status column says which risks are **fixed**, **mitigated**, **accepted** (with the reason) or
**open**.

## What is protected, and from whom

| Asset | Where it lives |
|---|---|
| Other tenants' files, deploy history, logs and domains | `host_*` tables in `/var/lib/openvibe-host-api/host.db`; objects in `<HOST_STORAGE_DIR>/projects/<prj_…>/<aa>/<sha256>` |
| OpenVibe sessions (Network SSO tokens, other products' cookies) | browsers; Network |
| The dashboard session and form tokens | `__Host-ov_host_session` cookie; `HOST_FORM_SECRET` |
| Host's own credentials (`OV_OAUTH_CLIENT_SECRET`, `HOST_FORM_SECRET`) | `/etc/openvibe/host.env` (0600) |
| Certificate private keys, DNS provider credentials | `/etc/letsencrypt`, `/root/.secrets` (root only; never read by Host) |
| The host itself: disk, memory and CPU shared with Live, Media, Chat and every database | the one production machine |
| Visitors of tenant sites | their browsers |

The adversaries are:

- a tenant, who uploads arbitrary HTML/JS/SVG/PDF and chooses file names, site names and custom
  domains;
- a visitor of a tenant site;
- anyone on the internet, with arbitrary `Host` headers, request targets and upload bodies;
- someone who controls a domain another tenant used to own.

## 1. Tenant isolation

**Serving: one site, one deploy, one project's objects.** Status: fixed by design and tested.

`server/http/tenant.js` resolves the site once from the `Host` header:

- `normaliseHost` (`:42`) accepts a lowercase name with an optional port and a trailing dot, and
  nothing else;
- `resolve` (`:92`) matches exactly one label under the sites domain, or a *verified* custom domain;
  anything deeper or unknown gets `404 Unknown host`.

It reads the site's active deploy pointer once, then only that deploy's immutable rows
(`host_deploy_files`, and the triggers in `server/db.js:172-183`). The request path is
percent-decoded segment by segment, and encoded separators (`%2f %5c %00`) are refused
(`candidates`, `:108`). The decoded path must pass the same `checkPath` as uploads
(`server/artifacts/paths.js:26`), and is then looked up in the manifest table, never on the
filesystem. The bytes are opened at `blobs.pathFor(row.project_id, row.sha256)` (`:154`,
`server/storage.js:35`): a validated `prj_` id plus a validated lowercase sha256. That path is never
built from the URL. Absolute-form request targets must name the same host as `Host` (`:186-196`).

Identical bytes uploaded by two projects are stored twice. Deleting one project's copy can never
break another's, and no tenant can confirm that another tenant has some content by uploading it.

`test/host-isolation.test.js` covers:

- 25 path tricks and 14 `Host` header tricks;
- absolute-form targets;
- tenant hosts never reaching the API, auth, metrics or readiness;
- per-project storage;
- 18 API routes answering 404 to non-members;
- a tenant pointing its own site at another tenant's deploy.

This review added:

- no CORS grant on tenant responses and no preflight success, so a script on `alpha` cannot read
  `beta`'s files in a visitor's browser;
- the Host API granting CORS to no tenant origin;
- another tenant's sha256 in `If-None-Match` or `Range` still getting a 404 (no existence oracle);
- a first-party service delegating for a person with `X-OV-Subject`, and an app principal, staying
  inside their own project (an app cannot delegate at all: 400);
- the dashboard showing a non-member no names, file paths or hashes.

**API and dashboard authorization.** Status: tested.

Every project-scoped read and write goes through `access.authorize`
(`server/domain/access.js:61-80`). A caller who is not a member gets the same 404 as for an id that
does not exist. Staff (Network role `admin`) can read and delete, but cannot deploy or activate: the
`deploy` need is refused to non-members, staff included. Reads of deploy lists, deploys and logs now
need `read` (the lowest member role, as before), so staff can review a reported site. Service tokens
must carry the route's capability (`guard`, one per route; `test/host-contracts-events.test.js`
checks every route). A sandbox token is refused on production projects.

**Same-site dashboard.** Status: mitigated, see §4 and §5.

Tenant pages on `<site>.openvibe.host` are *same-site* with the dashboard on `openvibe.host`. So:

- the API ignores cookies entirely (`server/http/api.js` routes use Bearer tokens only;
  `host-isolation` "the API ignores cookies");
- every dashboard POST needs the dashboard's own `Origin` (or `Referer`) **and** an HMAC form token
  (`server/auth/forms.js:21-35`);
- the dashboard trusts only `__Host-` cookies (`server/auth/sso.js:33`).

**Platform cookies never reach tenants.** Status: fixed by design.

Tenant sites are on `openvibe.host`, a registrable domain separate from every cookie-bearing
OpenVibe domain. `ovhost nginx tenants` refuses a sites domain under `openvibe.network|live|media|community|tools`
(`lib/nginx.js:181`). nginx:

- strips `Cookie` and `Authorization` from tenant requests;
- hides `Set-Cookie` from tenant responses;
- allows only `GET`/`HEAD`, with a 1 KB body limit (`templates/nginx/tenant-location.tmpl:3-19`).

Network treats `*.openvibe.host` as user content: it is never trusted for SSO framing, FedCM or
sign-in handoffs (OpenVibe.Network `server/auth/sso-owned.js:10-19`, `USER_CONTENT_ZONES`).

**Headers on tenant responses.** Status: fixed.

Every tenant response carries:

- `X-Content-Type-Options: nosniff`;
- a CSP (`default-src 'self'; script-src 'self'; … object-src 'none'; frame-ancestors 'self'`,
  `server/http/tenant.js:24`);
- `Cross-Origin-Opener-Policy: same-origin`;
- a restrictive `Permissions-Policy`;
- `X-Robots-Tag: noindex` for sandbox projects.

The CSP limits what a tenant page itself can do: no inline scripts, no third-party scripts. It is a
product limit as much as a protection, and README documents it.

## 2. Uploads

**Nothing is extracted to disk.** Status: fixed by design.

`server/artifacts/archive.js` parses tar and tar.gz from a Buffer. Entries become `{ path, data }`,
the validator builds a manifest, and each file is stored by the sha256 of its bytes. No archive entry
name ever becomes a filesystem path, which is why path traversal, symlinks and hard links cannot
escape a directory: there is no directory.

| Threat | Handling | Status |
|---|---|---|
| **Path traversal** (`..`, absolute, `\`, NUL/control, non-ASCII, empty segments, depth over 32; pax and GNU long-name overrides get the same checks) | `checkPath` (`paths.js:26-54`) on every name (`validate.js`), after `./` normalisation; the whole upload fails. `test/host-uploads.test.js`. | fixed |
| **Symlinks, hard links, devices, FIFOs, sparse and other special entries** | refused, never skipped (`archive.js:107-112`); a pax `linkpath` on a regular entry is refused too | fixed |
| **Gzip bomb** | `gunzipSync` with `maxOutputLength` = the smaller of the project's storage quota and `HOST_MAX_UNPACKED_BYTES` (256 MiB), plus header slack (`archive.js:67-75`, `upload.js:153`); a 40 MB bomb is in the tests | fixed |
| **Zip bomb** | `.zip` files are published as opaque bytes (`application/zip`) and never opened. A zip is not accepted as the deploy archive: it fails as "not a tar archive". | fixed |
| **Tar bomb** (millions of tiny entries, huge headers) | file count (`archive.js:115`), bytes per file and total bytes (`:116-118`) are checked as the archive is read; pax headers are bounded by the archive itself | fixed |
| **Oversized body** | `Content-Length` checked before reading and the stream capped while reading (`upload.js:36-50,122`); the connection is closed, not drained; nginx caps upload routes at 110m and tenant hosts at 1k | fixed |
| **Memory exhaustion by concurrent uploads** (each held in memory: up to 100 MiB raw plus 256 MiB unpacked) | **added:** at most `HOST_MAX_CONCURRENT_UPLOADS` (default 2) uploads are validated at once, service-wide (`upload.js:181`, `api.js:148`, dashboard); others get `503 upload.busy` + `Retry-After` before a byte is read, and are not recorded as the tenant's failure | fixed (`1e48cb2`) |
| **Event-loop stall** (`gunzipSync` runs on the main thread: decompressing 256 MiB blocks serving for roughly a second) | bounded by the concurrency cap, the per-project deploys-per-day quota (checked before the body is read, failed uploads count) and nginx `limit_req` on the upload route | accepted: move decompression to a worker thread if uploads become frequent |
| **Server-side code, credentials, databases** (`php`, `cgi`, `sh`, `jar`, `.env`, `pem`, `sqlite`, …) | refused with a reason (`paths.js:56-63`), so nobody deploys them thinking they run or stay private | fixed |
| **Content types** | allowlist by extension (`paths.js:65-84`); extension-less files are `text/plain`; everything is served with `nosniff` and the manifest's type, never a sniffed one | fixed |
| **Active content** (HTML, SVG, XML/XSLT, PDF, WebAssembly) | runs only on the tenant's own origin, under the tenant CSP; never on `openvibe.host` or a first-party origin. Same model as GitHub Pages. | accepted by design |
| **Hidden files** (`.git/`, `.env`, `.htaccess`) | refused; only `.well-known/` is published | fixed |
| **Certificate-validation files** (`.well-known/acme-challenge/`, `.well-known/pki-validation/`), which would let a tenant prove control of `<site>.openvibe.host` to a CA over HTTPS | **added:** refused in uploads and never served (`paths.js:49-53`); the operator issues every certificate | fixed (`1e48cb2`) |
| **Duplicate paths, file/directory conflicts, empty uploads** | refused (`validate.js:43,58`) | fixed |
| **A refused upload leaves partial state** | nothing is stored; the refusal is a `failed` deploy with its log and `host.deploy.failed`; the active deploy keeps serving | fixed |
| **Filling the shared disk** | **added:** deploys are refused with `507 storage.host_full` while the object store's filesystem has less than `HOST_MIN_FREE_BYTES` (default 5 GiB) free (`deploys.js:78-86`); `/api/ready` reports `disk_headroom`. Serving is unaffected. See also §6. | fixed (`0ff29d5`) |

## 3. Custom domains

| Threat | Handling | Status |
|---|---|---|
| **Claiming someone else's domain** | a custom domain is served only after `_openvibe-host.<hostname>` TXT = `openvibe-host-verification=<random token>`; the first verified proof wins (unique index, `db.js`); `test/host-domains.test.js` | fixed |
| **Dangling-CNAME takeover** (a former tenant's DNS still points at Host) | nobody can serve on that name without the TXT record, which only the domain owner can publish | fixed |
| **Claiming OpenVibe names** | refused: `openvibe.<any tld>` and subdomains, every domain in the released service manifests, the sites domain and the dashboard (`domains.js:38-47,87-96`) | fixed |
| **Keeping a domain after losing it** | verified domains are re-checked daily; a TXT record gone for `HOST_DOMAIN_LAPSE_DAYS` lapses the domain and it stops being served; pending domains fail after `HOST_DOMAIN_PENDING_DAYS` (`server/worker.js`, `domains.js:186-`) | fixed |
| **Hostile values reaching nginx** (a tenant-controlled hostname in a vhost) | `ovhost nginx tenants` re-validates every verified hostname from the database and drops anything that is not a plain host name or that falls under the sites domain (`lib/nginx.js:227`); `test/nginx-tenants.test.js` injects `evil.org; } server {…` | fixed |
| **TLS keys through the API** | never: certificates are issued by the operator with certbot (webroot for custom domains, DNS-01 for the wildcard); `ovhost certs` never reads a key file (`lib/certs.js:13`); the DNS provider credential is root-only and never passed to Host | fixed |
| **Unverified domains reaching another site** (a name CNAMEd to `cname.openvibe.host` before verification, or after lapsing, reaches nginx's *default server*, which served another site on 2026-09-22) | host-wide nginx, not Host: add a catch-all `default_server` that returns 444 on port 80 and rejects the TLS handshake on 443 (docs/launch.md, optional step 0) | **open** (host-wide; recommended at launch) |
| **Sandbox projects** | cannot add custom domains (`domains.js:115`) | fixed |

## 4. Cookies and sessions

| Threat | Handling | Status |
|---|---|---|
| A tenant page reads the dashboard session | the session is `__Host-ov_host_session`: HttpOnly, Secure, host-only; tenant origins are different hosts; nginx strips `Cookie` from tenant requests | fixed |
| **Cookie tossing** (a tenant sets `Domain=openvibe.host` cookies to fix a session or fake a sign-in) | the server trusts only `__Host-` cookies, which a subdomain cannot set (`sso.js:33`); a planted `ov_token` is ignored (`host-secrets-dashboard` "a planted ov_token cookie … is not a session") | fixed |
| **Login CSRF / forged dashboard actions from a same-site tenant page** | state cookie `__Host-` + OAuth `state`; every POST needs the dashboard `Origin` and the HMAC form token (`forms.js`); tested with same-site tenant origins | fixed |
| **Logout CSRF** (`GET /auth/logout` from a tenant page signs the visitor out of the dashboard) | nuisance only | accepted |
| **Cookie bomb** (a tenant sets many large `Domain=openvibe.host` cookies, so the visitor's browser sends oversized headers and nginx answers 400 for `openvibe.host` and every tenant site until the cookies expire or are cleared) | only the Public Suffix List stops a subdomain from setting parent-domain cookies (§5) | **accepted** for alpha; see §5 |
| `ov_token` (the Network access JWT) is JS-readable on `openvibe.host` for the shared navbar | host-only cookie: tenants cannot read it. A dashboard XSS could, and the dashboard CSP allows inline scripts (for the shared chrome). Tenant-controlled values (project names, file paths, log lines, host names) go through `esc()` in `server/render/pages.js`; ids are server-generated and site names match `[a-z0-9-]`. | mitigated; revisit when the shared chrome no longer needs inline script |
| Clickjacking the dashboard | `frame-ancestors 'none'`, `X-Frame-Options: DENY` (`server/app.js:47-60`) | fixed |

## 5. The Public Suffix List question

`openvibe.host` is not on the PSL, so browsers treat every `<site>.openvibe.host` as the same *site*
as `openvibe.host` and as each other. Listing it would:

- **stop cookie tossing and cookie bombs across tenants:** a tenant could no longer set
  `Domain=openvibe.host` cookies;
- make each tenant its own *site* for `SameSite`, storage partitioning and site isolation;
- also make `openvibe.host` itself a public suffix. The dashboard lives on that name.
  - Host-only cookies without a `Domain` attribute, which is what `__Host-` requires and what Host
    uses, remain possible on a host that equals a public suffix (RFC 6265 §5.3 step 5). This must be
    confirmed in current Chrome, Firefox and Safari before submitting.
  - The shared navbar's `ov_token`/`ov_sso_hint` cookies are also host-only.
- take weeks to be accepted and months to reach browsers. It requires a `_psl` TXT record and a
  registration that stays paid for at least two more years, and removal is equally slow.

None of Host's protections depend on the PSL (§1, §4), and tests show each one without it.

**Decision for launch:** launch without the PSL, and accept the cookie-bomb nuisance. It affects only
visitors who open a malicious tenant page, and staff can take that site down at once (§7).

**Recommended follow-up:** move the dashboard and API to a name outside the tenant zone (for example
`host.openvibe.network`, or keep `openvibe.host` for the dashboard and serve tenants from a second
registrable domain). Then submit the tenant zone alone to the PSL, the way GitHub separates
`github.com` from `github.io`. This needs an owner decision on the domain.

## 6. Quotas and resource abuse

| Limit | Default (production / sandbox) | Where |
|---|---|---|
| storage per project (deduplicated) | 1 GiB / 100 MiB | `server/config.js:91-92` (`HOST_QUOTA_*`, `HOST_SANDBOX_QUOTA_*`), staff override per project |
| deploys per project per rolling 24 h (failed ones count; checked before the body is read) | 50 / 20 | `deploys.js:88-90` |
| files per deploy; bytes per file | 10 000, 25 MiB / 2 000, 10 MiB | `archive.js:115-116`, `validate.js` |
| sites per project; custom domains per project | 10, 5 / 3, 0 | `sites.js:67`, `domains.js:117` |
| **projects per person** | **10** (was a fixed 50), `HOST_MAX_PROJECTS_PER_OWNER` | `projects.js:84-85` (`0ff29d5`) |
| request size; unpacked size; concurrent uploads | 100 MiB; 256 MiB; 2 | `config.js:72-83` |
| free disk below which deploys stop | 5 GiB, `HOST_MIN_FREE_BYTES` | `deploys.js:78-86` |
| rate limits | API 240/min, dashboard 300/min, `/auth` 60/15 min per IP (`app.js`); nginx `limit_req` per zone | `templates/nginx/tenants.conf.tmpl:10-12` |

The worst case per person is now 10 GiB of storage, down from 50 GiB. Network accounts are free,
so many accounts could still add up. The disk floor keeps that from ever filling the disk the whole
platform shares: uploads stop, and serving and every other service go on.

Serving costs no disk and little CPU. Tenant traffic is behind Cloudflare
(`*.openvibe.host` is proxied), and nginx rate-limits each client address, set by realip from
Cloudflare. **Added:** every template ovhost renders now sends `X-Forwarded-For` from
`$remote_addr` only (`1e48cb2`). The templates had still appended the client's own header, so a
request reaching the origin directly could choose the address that rate limits and logs use. The
installed vhosts were fixed by hand on 2026-09-23 (`30592c0`). `TRUST_PROXY` now defaults to 1.

Accepted for alpha: objects live only on the local disk and are not in `ovhost backup` (only
`host.db` is). A lost disk loses tenant sites, and tenants keep their source. README "Not done yet"
says so.

## 7. Abuse and takedown

Before this review, staff could only **delete** a site or a project. Deletion stops serving but also
destroys the content, which a report may need reviewed or preserved. **Added** (`1e48cb2`,
`server/domain/takedowns.js`):

- **Staff take down a site or a whole project:** `POST /api/v1/sites/:id/takedown` or
  `/projects/:id/takedown` with `{ "reason": "…" }` (staff only, capability `host.site.manage`).
  Serving stops at once on the default and every custom domain: `451`, no tenant bytes, `no-store`,
  and `Clear-Site-Data: "cache", "storage"`, so visitors' browsers drop what the site cached, stored or
  installed as a service worker (`0ff29d5`).
- **Evidence is kept:** deploys, file rows, logs and objects stay. Staff can read the deploys and
  their file lists and logs through the API. The bytes are at
  `<HOST_STORAGE_DIR>/projects/<prj>/<aa>/<sha256>`.
- **Members see why:** the reason appears on the site and project in the API and as a dashboard
  notice. They cannot upload, activate, roll back or delete anything the takedown covers.
- **Staff lift it** (`DELETE …/takedown` with an optional `note`) or delete the content. Every
  takedown and lift stays in `host_takedowns`.
- **Tests:** `test/host-abuse.test.js`.

**Procedure** for a report sent to the address on `https://openvibe.host/dmca` (the shared legal
pages, profile `ugc`, which name `dmca@openvibe.live`):

1. Take the site down (a project takedown for a pattern across sites).
2. Purge Cloudflare's cache for the site's host name. Fingerprinted assets otherwise stay at the edge
   for up to an hour: Host now sends `CDN-Cache-Control: public, max-age=3600` on them (`1e48cb2`), while
   browsers keep them for a year as `immutable`. HTML and other files revalidate on every request.
3. Review and preserve what the law requires.
4. Lift or delete.

**Needs an owner:** confirmation that `dmca@openvibe.live` is monitored for Host reports too, and a named person who acts on them. The
tooling exists; the duty does not yet. The Events log (`host.deploy.*`) and the upload logs give
the history of any site.

## 8. Host's own surface

| Item | Handling | Status |
|---|---|---|
| `/metrics` | direct loopback callers only; nginx returns 404 (`tenants.conf.tmpl:72`) | fixed |
| `/api/ready`, `/api/health`, `/release.json` | no secrets, no tenant data (`host-secrets-dashboard`) | fixed |
| Secrets in responses | allowlisted serializers (`server/http/serialize.js`); tested for the client secret, form secret, uploaded `.env` values and credential-like strings | fixed |
| Tenant secrets | Stage B stores none: no environment, build secrets or deploy keys | fixed by design |
| Tenant code execution | none: no build step, no server-side code | fixed by design |
| The tenant vhost install | transactional (`nginx -t`, restore on failure); **added:** removes the interim pending vhost in the same change (`lib/nginx.js:100-`, `nginx.tenants.replaces`) | fixed (`1e48cb2`) |

## Residual risks

| Risk | Severity | Owner |
|---|---|---|
| Unverified or lapsed custom domains reach nginx's default server | medium (confusion, mis-served content on a stranger's domain) | operator: catch-all `default_server` (docs/launch.md step 0) |
| Cookie bomb across tenants and the dashboard (no PSL) | low (per-visitor nuisance; takedown exists) | owner decision (§5) |
| No abuse mailbox/owner | medium (process, not code) | owner |
| Objects not backed up | medium for tenants (alpha, documented) | follow-up: add the object store to the backup run |
| `gunzipSync` blocks the event loop per upload | low (bounded) | follow-up if uploads grow |
| Takedown routes not in released `openvibe-contracts` `host.site.manage.implementedBy` | none at runtime (the contract check passes) | Contracts: next release (docs/launch.md) |
