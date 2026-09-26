# Browser check (roadmap WS-Q task 3; WS-T tasks 3 and 4)

`scripts/browser-check.js` loads every public OpenVibe product in headless Chrome and checks what a visitor,
a crawler and a screen reader get. It uses `openvibe-shared/browser-harness` (Shared 1.16.0), which grew out of
Live's `test/browser/smoke.js`. It needs Node 22 or later and Chrome, and has no npm dependency: it drives Chrome
over the DevTools protocol with Node's own WebSocket.

```sh
node scripts/browser-check.js                                  # every public product, summary per site
node scripts/browser-check.js --sites live,wiki --json         # some sites, the full reports as JSON
node scripts/browser-check.js --out docs/browser-check.md      # append a dated run (table + details) here
node scripts/browser-check.js --remote runner@other-host       # run it on another machine over ssh
ovhost deploy wiki --browser-check                             # after a deploy: that site only, report only
```

Other options: `--routes-file <json>`, `--max-routes <n>` (default 7), `--widths 390,768,1280`, `--no-axe`,
`--no-nav`, `--laps <n>` (default 5), `--strict-errors` and `--harness <path>`. The exit code is 0 when every
site passes, 1 when one fails and 2 when the run itself broke.

## What it loads

- **Sites.** Every service in OpenVibe.Network's registry (`/api/v1/registry/services`) with a public origin
  whose home page answers HTML. API roots that answer `text/plain` (Events) are skipped.
- **Routes per site.** The home page and a few known routes (`KNOWN_ROUTES` in the script). Then one URL per
  section of the site's `sitemap.xml`, detail pages first, up to `--max-routes`; a sitemap index is followed
  one level. Last comes `/__ovcheck-404`, which must answer 404. Billing is checked on `/policy` only.
- **Load.** Only GETs, one page at a time, one Chrome for the whole run. Each route gets a fresh browser
  context with its cache in memory. The user agent ends in `OpenVibe-BrowserCheck/1`. A full run of 23 sites
  takes about 20 minutes. Chrome's profile goes to `$TMPDIR`: point it at a roomy disk.

## What it checks

Per route, at 390, 768 and 1280 px:

| Check | Fails when |
|---|---|
| status | the document's HTTP status is not the expected one (200, or the route's `status`) |
| errors | an uncaught exception, `console.error`, or a browser error entry (a failed load, a CSP block) |
| overflow | the page can be scrolled sideways; the report names the widest offending elements |
| scripts | a script URL (origin + path) is requested twice |

Once per route, with JavaScript off (the initial HTML, what a crawler reads):

| Check | Fails when |
|---|---|
| nojs | fewer than 200 characters of visible text |
| canonical | there is not exactly one absolute `<link rel=canonical>`. A noindex page may have none. Another origin, or a different URL once JavaScript runs, is a warning. |
| jsonld | a JSON-LD block does not parse, or an entity's headline or name is in no visible text. An ItemList needs 80% of its item names visible. Visible only with JavaScript is a warning. |

At the widest width, **axe-core 4.13.0** runs the WCAG 2.0/2.1 A and AA rules. Serious and critical violations
fail; moderate and minor are reported. axe-core is not vendored. An installed `axe-core` is used when there is
one; otherwise the pinned file comes from jsDelivr, is checked against its sha384 (the same bytes as the npm
tarball) and is cached in `~/.cache/openvibe-shared`.

A document that is not HTML, such as an API's JSON 404, is judged on its status only.

Once per site, **navigation growth** (a D46 scenario) runs home ↔ the second route five times. It clicks a link
when there is one, so a single-page app navigates in place; the back/forward cache is off. After a forced GC at
the end of each lap it samples the JS heap, DOM nodes, event listeners and documents (`Performance.getMetrics`).
It also samples live intervals, pending timeouts and open WebSockets, counted by a probe installed before any
page script. A measure fails when it grows from lap 2 to the last lap by more than its budget **and** is still
growing over the second half:

| heap | nodes | listeners | documents | intervals | timeouts | sockets |
|---|---|---|---|---|---|---|
| 3 MB | 300 | 30 | 1 | 1 | 10 | 1 |

Then **idle** work: for 5 seconds after the page settles, the report gives CPU busy time (script, style,
layout), requests (with their URLs) and running animations. Idle work is reported, never failed.

**Known noise** is counted per label in the report, not failed; `--strict-errors` fails it too. There are two
kinds:
- Cloudflare's Web Analytics beacon, which Cloudflare injects at the edge and the sites' CSP blocks.
- A signed-out visitor's session probe answering 401 (`/auth/me`, `/api/auth/refresh`).

## Remote runner

`--remote <ssh-host>` exists because the workstation's disk is nearly full (hazard H7). It streams the script and
the harness file over one ssh connection into `mktemp -d` on the other machine and runs them there with `--json`.
It then removes the directory and writes the report here. The remote needs **Node 22+ and Chrome**
(`CHROME_BIN` or `/usr/bin/google-chrome`) and must reach the sites itself. `--routes-file` travels inline.
`OVHOST_SSH` replaces the ssh command, for example `ssh -p 2222 -i key`. The default is `ssh -o BatchMode=yes`,
which never prompts.

## After a deploy

`ovhost deploy <service> --browser-check` runs the check for that one site after a deploy that went through,
and prints the result. It never changes the exit code or the release record, and it says so when Chrome is
missing on the host. Until Host's `openvibe-shared` pin reaches 1.16.0, the script finds the harness with
`--harness` or in a sibling `OpenVibe.Shared` checkout.

## Findings, 2026-09-26

The production run recorded below covered 23 sites and 75 routes (two calibration runs before it found the same product issues). Everything with a small, clear fix is fixed and
committed in its repository. **Nothing here is deployed** except Network's two commits, which went out with an
unrelated push. The run table shows production as it was.

| Site | Found | Fix (commit) |
|---|---|---|
| every site's `/updates` | the pressed filter chip of the shared update log was white on `--accent`, 3.67:1 (axe serious) | Shared `f4877e0` (1.16.0). Each site needs a pin bump after the tag. |
| openvibe.network | `/login`: unnamed password toggles (axe critical); the tabs and muted text below AA; no canonical; 117 characters without JS. `/updates`: current chip 3.67:1. Home: JSON-LD list named by no visible text | Network `6665245`, `dae6ab2` (deployed) |
| openvibe.live | `/chat` and `/search` had no canonical (the `/search` meta existed but was never routed). The home JSON-LD list name was not visible. VOD/clip/channel volume sliders were unnamed (axe critical). Guests requested `/api/coins/channel-balance` and got 401 on every channel/VOD/clip. Docs: `/assets/favicon.ico` 404, no canonical, scrolling code not reachable by keyboard | Live `934156b`, `fcfc0d5` (branch `seadragon`) |
| openvibe.tools | `/developers` 858 px wide at 768 px; the family pages' `.cta` at 3.67:1; the tool pages' "Primary" tag at 3.16:1 | Tools `2140ef5`, `f0307c0`, `858845c` |
| openvibe.community | breadcrumb links told apart by colour alone (axe serious) | Community `4072708` |
| openvibe.blog | buttons and `.button` links at 3.67:1 (the 404 page) | Blog `b5b49d3` |
| openvibe.games | no icon link, so `/favicon.ico` 404 on every visit | Games `0f29769` |
| billing.openvibe.network | `/policy`: no canonical, `/favicon.ico` 404. nginx sent `X-Robots-Tag: noindex` on the policy that robots.txt and the app call indexable | Billing `f7ff3cd`, `5fa5546` |
| search.openvibe.network | indexable front page without a canonical | Search `99f1e76` |
| codes, community, wiki, blog, chat | `/auth/me` answered **503** after about ten quick page loads. The navbar's session probe shared the 10-per-minute sign-in rate limit, and nginx answers 503 by default. A signed-in visitor reading quickly looks signed out. | Codes `f1ddee9`, Community `eb68e9e`, Wiki `a8362b9`, Blog `6555217`, Chat `d461fd4` (vhosts; `nginx -t` not run here) |

Repeated navigation: nothing grows on any site. Early calibration runs showed +0.9 MB and +1,300 nodes per three
laps on multi-page sites. That was Chrome's back/forward cache holding the previous pages (3 → 5 → 7 documents,
then flat), not a leak; the harness now turns that cache off.

### Left to do

- **Releases.** Tag Shared 1.16.0, then bump the `openvibe-shared` pin on every site so the update-log chip fix
  reaches them, and on Host so `scripts/browser-check.js` and `deploy --browser-check` find the harness without
  `--harness`. Deploy the commits above; the vhost changes need `nginx -t` and a reload.
- **Cloudflare Web Analytics beacon** (161 blocked loads on Blog, Codes, Community, Media, Network, Search,
  Sources and Wiki). Cloudflare injects it at the edge and each site's CSP blocks it. Either turn off Web
  Analytics' automatic setup for those zones (the network has its own analytics), or allow
  `static.cloudflareinsights.com` and `cloudflareinsights.com` in each CSP. That is a decision, so it is
  counted as known here, not fixed.
- **401 from signed-out session probes** (`/auth/me`, Live's `/api/auth/refresh`) on 7 sites. Every guest
  page view logs one red console line. Answering 200 `{ user: null }`, or skipping the probe when there is no
  session cookie, would remove it; this changes each site's auth contract, so it is counted as known.
- **Idle work.** Every page with the shared navbar keeps the main thread 12–29% busy while nothing happens.
  The OV mark's infinite SVG animations (`ovmFloat`, `ovmGlow`, `ovmComet`, `ovmDot`) restyle and re-lay-out
  every frame. Placeholder pages add `drift` (19 infinite animations), and Live's home runs 41. Stopping the
  mark after its intro, animating only a composited HTML wrapper, or pausing when out of view would bring idle
  CPU near 0. That is Shared `ov-mark.js` and a design call. Live's home also makes 15 requests (159 KB) in
  5 idle seconds.
- **Live `/clip/369`.** It asks `/api/vods/5541/context`, which answers 404 because the clip's source VOD
  has no context, and logs a console error. The client could skip the call when the VOD is gone.
- **openvibe.chat** answers unknown paths with JSON, not an HTML 404 page. The harness judges such an answer
  on its status only.
- **Coverage.** Coupons, News, Tips and VIP have the same `/auth/` rate limit in their repositories' vhosts
  (their domains still serve the Sites placeholder). Live's own `test/browser/smoke.js` keeps its Live-only
  checks (SPA routes, chat pinning, the broadcast gate); its generic checks could move to the harness. Signed-in
  pages are not checked. Neither are the other tool subdomains (`*.openvibe.tools`) or the placeholder sites'
  other routes.

## Runs

The first two runs used earlier harness builds, with the back/forward cache on and ItemLists judged by name.
They are not recorded here. The run below is the first with the harness as committed.

### Run 2026-09-26T04:11:56.295Z (local; Chrome/150.0.7843.0)

11/23 sites pass. Widths 390, 768, 1280; axe axe-core 4.13.0, WCAG 2.1 A/AA; navigation 5 laps. Cells: ✓ all pass, **n✗** routes failing, n! warnings, - not run.

| Site | Routes | Status | Errors | Overflow | Scripts | No-JS | Canonical | JSON-LD | axe | Nav | axe serious/critical (moderate) | Growth lap 2→last | Idle 5 s: CPU · requests · infinite animations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ai.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 28.2% · 2 req · 19 anim |
| billing.openvibe.network | 1 | ✓ | **1✗** | ✓ | ✓ | ✓ | - | - | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.blog | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **2✗** | ✓ | 2/0 (0) | 0 KB · 0 nodes · 0 lst | 13.9% · 2 req · 8 anim |
| openvibe.chat | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | **1✗** | ✓ | 1/0 (0) | 0 KB · 0 nodes · 0 lst | 14.1% · 2 req · 8 anim |
| openvibe.codes | 7 | ✓ | **1✗** | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 12.3% · 2 req · 9 anim |
| openvibe.community | 6 | ✓ | **2✗** | ✓ | ✓ | ✓ | ✓ | ✓ | **3✗** | ✓ | 3/0 (0) | 0 KB · 0 nodes · 0 lst | 24.9% · 2 req · 8 anim |
| openvibe.coupons | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · +2 lst | 23% · 2 req · 19 anim |
| openvibe.deals | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 22.5% · 2 req · 19 anim |
| openvibe.games | 2 | ✓ | **1✗** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 20.8% · 2 req · 9 anim |
| openvibe.host | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 21.1% · 2 req · 16 anim |
| openvibe.live | 8 | ✓ | **2✗** | ✓ | ✓ | ✓ | **2✗** | ✓ | **2✗** | ✓ | 0/2 (0) | +111 KB · 0 nodes · +3 lst | 23.7% · 15 req · 41 anim |
| openvibe.media | 3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | **1✗** | ✓ | 1/0 (0) | +1 KB · 0 nodes · 0 lst | 21.8% · 2 req · 8 anim |
| openvibe.network | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **1✗** | ✓ | 1/0 (0) | 0 KB · 0 nodes · 0 lst | 25.7% · 2 req · 19 anim |
| openvibe.news | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 19.5% · 2 req · 19 anim |
| openre.stream | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 23.3% · 2 req · 19 anim |
| openvibe.reviews | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · -2 lst | 22.4% · 2 req · 19 anim |
| search.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | **1✗** | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 12.2% · 2 req · 8 anim |
| sources.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | - | - | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.tips | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 22.5% · 2 req · 19 anim |
| openvibe.tools | 8 | ✓ | ✓ | **1✗** | ✓ | ✓ | ✓ | ✓ | **4✗** | ✓ | 4/0 (0) | 0 KB · 0 nodes · 0 lst | 28.7% · 2 req · 8 anim |
| openvibe.trade | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 21.2% · 2 req · 19 anim |
| openvibe.vip | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · +2 lst | 21.4% · 2 req · 19 anim |
| openvibe.wiki | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **1✗** | ✓ | 1/0 (0) | 0 KB · 0 nodes · 0 lst | 13% · 2 req · 8 anim |

Known errors, counted and not failed (`--strict-errors` fails them):
- Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP: 161× on openvibe.blog, openvibe.codes, openvibe.community, openvibe.media, openvibe.network, search.openvibe.network, sources.openvibe.network, openvibe.wiki
- signed-out session probe answered 401: 142× on openvibe.blog, openvibe.chat, openvibe.codes, openvibe.community, openvibe.live, openvibe.media, openvibe.wiki

<details><summary>Details: routes and findings per site</summary>

**https://ai.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 28.2% (script 2 ms, style 172 ms, layout 204 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://ai.openvibe.network/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://billing.openvibe.network**: FAIL (1 route(s), Chrome/150.0.7843.0)
- `/policy`: errors fail
    - error: network: Failed to load resource: the server responded with a status of 404 () (https://billing.openvibe.network/favicon.ico)
    - canonical: noindex page: no canonical needed
- navigation `/policy` ↔ `/policy` ×5 (load): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.blog**: FAIL (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: axe fail
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×3: signed-out session probe answered 401
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.ov-shipped-chip:nth-child(1)`
- `/@openvibe/patch-notes-object-first-writes`: pass
- `/__ovcheck-404`: axe fail
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×3: signed-out session probe answered 401
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.button`
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 13.9% (script 2 ms, style 74 ms, layout 92 ms), 2 request(s), 4 KB (`https://openvibe.blog/shared/release-watch.js`, `https://openvibe.blog/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`
    - error during navigation: network: Failed to load resource: the server responded with a status of 503 ()

**https://openvibe.chat**: FAIL (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/rooms`: pass
- `/updates`: axe fail
    - ignored ×3: signed-out session probe answered 401
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.ov-shipped-chip:nth-child(1)`
- `/__ovcheck-404`: pass (application/json: only the status is checked)
- navigation `/` ↔ `/rooms` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 14.1% (script 2 ms, style 72 ms, layout 97 ms), 2 request(s), 4 KB (`https://openvibe.chat/shared/release-watch.js`, `https://openvibe.chat/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`
    - error during navigation: network: Failed to load resource: the server responded with a status of 503 ()

**https://openvibe.codes**: FAIL (7 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/tools/webhooks`: pass
- `/manifests/validate`: pass
- `/docs`: pass
- `/oauth`: pass
- `/policy`: pass
- `/__ovcheck-404`: errors fail
    - error: network: Failed to load resource: the server responded with a status of 503 () (https://openvibe.codes/auth/me)
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×1: signed-out session probe answered 401
- navigation `/` ↔ `/tools/webhooks` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 12.3% (script 2 ms, style 62 ms, layout 79 ms), 2 request(s), 4 KB (`https://openvibe.codes/shared/release-watch.js`, `https://openvibe.codes/release.json`); 9 running animation(s), 9 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDraw on path`
    - error during navigation: network: Failed to load resource: the server responded with a status of 503 ()

**https://openvibe.community**: FAIL (6 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/pastes`: pass
- `/pulse`: axe fail
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×3: signed-out session probe answered 401
    - axe serious: link-in-text-block (1 node) Links must be distinguishable without relying on color: `.crumbs > a[href="/"]`
- `/p/rogue-frame-5292`: axe fail
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×3: signed-out session probe answered 401
    - axe serious: link-in-text-block (2 nodes) Links must be distinguishable without relying on color: `.crumbs > a[href="/"]`, `.crumbs > a[href$="pastes"]`
- `/s`: errors fail, axe fail
    - error: network: Failed to load resource: the server responded with a status of 503 () (https://openvibe.community/auth/me)
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×2: signed-out session probe answered 401
    - axe serious: link-in-text-block (1 node) Links must be distinguishable without relying on color: `.crumbs > a[href="/"]`
- `/__ovcheck-404`: errors fail
    - error: network: Failed to load resource: the server responded with a status of 503 () (https://openvibe.community/auth/me)
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×1: signed-out session probe answered 401
- navigation `/` ↔ `/pastes` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 24.9% (script 2 ms, style 79 ms, layout 90 ms), 2 request(s), 4 KB (`https://openvibe.community/shared/release-watch.js`, `https://openvibe.community/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`
    - error during navigation: network: Failed to load resource: the server responded with a status of 503 ()

**https://openvibe.coupons**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners +2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 23% (script 2 ms, style 138 ms, layout 155 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.coupons/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.deals**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 22.5% (script 2 ms, style 126 ms, layout 157 ms), 2 request(s), 4.1 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.deals/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.games**: FAIL (2 route(s), Chrome/150.0.7843.0)
- `/`: errors fail
    - error: network: Failed to load resource: the server responded with a status of 404 () (https://openvibe.games/favicon.ico)
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 20.8% (script 2 ms, style 89 ms, layout 91 ms), 2 request(s), 0.3 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.games/release.json`); 9 running animation(s), 9 infinite: `ovmBounce on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`

**https://openvibe.host**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 21.1% (script 2 ms, style 135 ms, layout 146 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.host/release.json`); 16 running animation(s), 16 infinite: `drift on i`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`

**https://openvibe.live**: FAIL (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/content`: pass
- `/chat`: canonical fail
    - ignored ×3: signed-out session probe answered 401
    - canonical: no canonical link
- `/search?q=minecraft`: canonical fail
    - ignored ×3: signed-out session probe answered 401
    - canonical: no canonical link
- `/vod/5627`: errors fail, axe fail
    - error: network: Failed to load resource: the server responded with a status of 401 () (https://openvibe.live/api/coins/channel-balance?streamerId=327)
    - ignored ×6: signed-out session probe answered 401
    - axe critical: label (1 node) Form elements must have labels: `#vp-vol-slider`
- `/clip/369`: errors fail, axe fail
    - error: network: Failed to load resource: the server responded with a status of 404 () (https://openvibe.live/api/vods/5541/context)
    - error: network: Failed to load resource: the server responded with a status of 401 () (https://openvibe.live/api/coins/channel-balance?streamerId=80)
    - ignored ×6: signed-out session probe answered 401
    - axe critical: label (1 node) Form elements must have labels: `#clp-vol-slider`
- `/@JapaneseOldGuy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/content` ×5 (in-page+link): pass; growth lap 2→5: heap +111 KB, nodes 0, listeners +3, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 23.7% (script 44 ms, style 197 ms, layout 55 ms), 15 request(s), 158.8 KB; 44 running animation(s), 41 infinite: `opacity on div.hero-float-inner`, `transform on div.hero-float-inner`, `ovmFloat on svg`, `ovmGlow on circle`

**https://openvibe.media**: FAIL (3 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: axe fail
    - ignored ×3: signed-out session probe answered 401
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.ov-shipped-chip:nth-child(1)`
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 21.8% (script 2 ms, style 57 ms, layout 77 ms), 2 request(s), 4.2 KB (`https://openvibe.media/shared/release-watch.js`, `https://openvibe.media/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`

**https://openvibe.network**: FAIL (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: axe fail
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.ov-shipped-chip:nth-child(1)`
- `/login`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 25.7% (script 2 ms, style 105 ms, layout 138 ms), 2 request(s), 4.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.network/release.json`); 19 running animation(s), 19 infinite: `orb-drift on div.orb`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.news**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 19.5% (script 2 ms, style 104 ms, layout 139 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.news/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openre.stream**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 23.3% (script 2 ms, style 132 ms, layout 172 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openre.stream/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.reviews**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 22.4% (script 3 ms, style 133 ms, layout 149 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.reviews/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://search.openvibe.network**: FAIL (2 route(s), Chrome/150.0.7843.0)
- `/`: canonical fail
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - canonical: no canonical link
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 12.2% (script 2 ms, style 89 ms, layout 126 ms), 2 request(s), 4.2 KB (`https://search.openvibe.network/shared/release-watch.js`, `https://search.openvibe.network/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`

**https://sources.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (load): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.tips**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 22.5% (script 2 ms, style 130 ms, layout 145 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.tips/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.tools**: FAIL (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/developers`: overflow fail
    - overflow at 768px: page 858px wide; code (right 858px), code (right 762px)
- `/updates`: axe fail
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.ov-shipped-chip:nth-child(1)`
- `/tool/yaml`: axe fail
    - axe serious: color-contrast (2 nodes) Elements must meet minimum color contrast ratio thresholds: `.cta`, `.tag`
- `/all-tools`: pass
- `/network-tools`: axe fail
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.cta`
- `/developer-tools`: axe fail
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.cta`
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/developers` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 28.7% (script 2 ms, style 64 ms, layout 88 ms), 2 request(s), 4.2 KB (`https://openvibe.tools/shared/release-watch.js`, `https://openvibe.tools/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`

**https://openvibe.trade**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 21.2% (script 2 ms, style 121 ms, layout 142 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.trade/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.vip**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners +2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 21.4% (script 2 ms, style 121 ms, layout 171 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.vip/release.json`); 19 running animation(s), 19 infinite: `drift on i`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.wiki**: FAIL (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: axe fail
    - ignored ×3: Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP
    - ignored ×3: signed-out session probe answered 401
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.ov-shipped-chip[type="button"]:nth-child(1)`
- `/s/openvibe`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 13% (script 1 ms, style 70 ms, layout 87 ms), 2 request(s), 4 KB (`https://openvibe.wiki/shared/release-watch.js`, `https://openvibe.wiki/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`
    - error during navigation: network: Failed to load resource: the server responded with a status of 503 ()

</details>

### Run 2026-09-26T05:46:52.481Z (local; Chrome/150.0.7843.0)

21/23 sites pass. Widths 390, 768, 1280; axe axe-core 4.13.0, WCAG 2.1 A/AA; navigation 5 laps. Cells: ✓ all pass, **n✗** routes failing, n! warnings, - not run.

| Site | Routes | Status | Errors | Overflow | Scripts | No-JS | Canonical | JSON-LD | axe | Nav | axe serious/critical (moderate) | Growth lap 2→last | Idle 5 s: CPU · requests · infinite animations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ai.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| billing.openvibe.network | 1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.blog | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -2 KB · 0 nodes · 0 lst | 0.1% · 2 req |
| openvibe.chat | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +4 KB · 0 nodes · 0 lst | 0.1% · 2 req |
| openvibe.codes | 7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | -3 KB · 0 nodes · -2 lst | 0.1% · 2 req |
| openvibe.community | 6 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.1% · 2 req |
| openvibe.coupons | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| openvibe.deals | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| openvibe.games | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -3 KB · 0 nodes · -2 lst | 12.7% · 2 req · 1 anim |
| openvibe.host | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| openvibe.live | 8 | ✓ | ✓ | ✓ | **8✗** | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +22 KB · +34 nodes · +4 lst | 20.2% · 15 req · 33 anim |
| openvibe.media | 3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.1% · 2 req |
| openvibe.network | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +3 KB · 0 nodes · +2 lst | 28% · 2 req · 19 anim |
| openvibe.news | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| openre.stream | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -2 KB · 0 nodes · 0 lst | 0.1% · 2 req · 3 anim |
| openvibe.reviews | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| search.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +3 KB · 0 nodes · 0 lst | 0.1% · 2 req |
| sources.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | - | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.tips | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| openvibe.tools | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **1✗** | ✓ | 1/0 (0) | +1 KB · 0 nodes · 0 lst | 26.5% · 2 req · 8 anim |
| openvibe.trade | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| openvibe.vip | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.2% · 2 req · 3 anim |
| openvibe.wiki | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +3 KB · 0 nodes · 0 lst | 0.1% · 2 req |

Known errors, counted and not failed (`--strict-errors` fails them):
- Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP: 17× on openvibe.media, sources.openvibe.network

<details><summary>Details: routes and findings per site</summary>

**https://ai.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://ai.openvibe.network/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://billing.openvibe.network**: pass (1 route(s), Chrome/150.0.7843.0)
- `/policy`: pass
- navigation `/policy` ↔ `/policy` ×5 (load): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.blog**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/@openvibe/patch-notes-staged-tables-move-to-chat-one-table-at-a-time`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap -2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 4 KB (`https://openvibe.blog/shared/release-watch.js`, `https://openvibe.blog/release.json`)

**https://openvibe.chat**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/rooms`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/rooms` ×5 (link): pass; growth lap 2→5: heap +4 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 4 KB (`https://openvibe.chat/shared/release-watch.js`, `https://openvibe.chat/release.json`)

**https://openvibe.codes**: pass (7 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/tools/webhooks`: pass
- `/manifests/validate`: pass
- `/docs`: pass
- `/oauth`: pass
- `/policy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/tools/webhooks` ×5 (link): pass; growth lap 2→5: heap -3 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 4 KB (`https://openvibe.codes/shared/release-watch.js`, `https://openvibe.codes/release.json`)

**https://openvibe.community**: pass (6 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/pastes`: pass
- `/pulse`: pass
- `/p/rogue-frame-5292`: pass
- `/s`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/pastes` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 4 KB (`https://openvibe.community/shared/release-watch.js`, `https://openvibe.community/release.json`)

**https://openvibe.coupons**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.coupons/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.deals**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.deals/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.games**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -3 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 12.7% (script 7 ms, style 43 ms, layout 0 ms), 2 request(s), 0.3 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.games/release.json`); 1 running animation(s), 1 infinite: `pulse on a.play-cta`

**https://openvibe.host**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.host/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.live**: FAIL (8 route(s), Chrome/150.0.7843.0)
- `/`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- `/content`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- `/chat`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- `/search?q=minecraft`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- `/vod/5627`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- `/clip/369`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- `/@JapaneseOldGuy`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- `/__ovcheck-404`: scripts fail
    - scripts requested twice at 390px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 768px: https://openvibe.live/shared/ov-mark.js ×2
    - scripts requested twice at 1280px: https://openvibe.live/shared/ov-mark.js ×2
- navigation `/` ↔ `/content` ×5 (in-page+link): pass; growth lap 2→5: heap +22 KB, nodes +34, listeners +4, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 20.2% (script 44 ms, style 166 ms, layout 18 ms), 15 request(s), 158.8 KB; 36 running animation(s), 33 infinite: `opacity on div.hero-float-inner`, `transform on div.hero-float-inner`, `heroBgKenBurns on div.hero-bg-layer`, `heroFloat3d on a.hero-float`

**https://openvibe.media**: pass (3 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 4.2 KB (`https://openvibe.media/shared/release-watch.js`, `https://openvibe.media/release.json`)

**https://openvibe.network**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/login`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +3 KB, nodes 0, listeners +2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 28% (script 2 ms, style 114 ms, layout 156 ms), 2 request(s), 4.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.network/release.json`); 19 running animation(s), 19 infinite: `orb-drift on div.orb`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.news**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.news/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openre.stream**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openre.stream/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.reviews**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.reviews/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://search.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +3 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -2, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 4.2 KB (`https://search.openvibe.network/shared/release-watch.js`, `https://search.openvibe.network/release.json`)

**https://sources.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (load): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.tips**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.tips/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.tools**: FAIL (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/developers`: pass
- `/updates`: axe fail
    - axe serious: color-contrast (1 node) Elements must meet minimum color contrast ratio thresholds: `.ov-shipped-chip:nth-child(1)`
- `/tool/yaml`: pass
- `/all-tools`: pass
- `/network-tools`: pass
- `/developer-tools`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/developers` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 26.5% (script 2 ms, style 57 ms, layout 81 ms), 2 request(s), 4.2 KB (`https://openvibe.tools/shared/release-watch.js`, `https://openvibe.tools/release.json`); 8 running animation(s), 8 infinite: `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`, `ovmDot on circle`

**https://openvibe.trade**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.trade/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.vip**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.vip/release.json`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.wiki**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/s/openvibe`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +3 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 2 request(s), 4 KB (`https://openvibe.wiki/shared/release-watch.js`, `https://openvibe.wiki/release.json`)

</details>

### Run 2026-09-26T06:06:44.728Z (local; Chrome/150.0.7843.0)

2/2 sites pass. Widths 390, 768, 1280; axe axe-core 4.13.0, WCAG 2.1 A/AA; navigation 5 laps. Cells: ✓ all pass, **n✗** routes failing, n! warnings, - not run.

| Site | Routes | Status | Errors | Overflow | Scripts | No-JS | Canonical | JSON-LD | axe | Nav | axe serious/critical (moderate) | Growth lap 2→last | Idle 5 s: CPU · requests · infinite animations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| openvibe.live | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -18 KB · -5 nodes · -1 lst | 22.7% · 15 req · 33 anim |
| openvibe.tools | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · -2 lst | 0.1% · 2 req |

<details><summary>Details: routes and findings per site</summary>

**https://openvibe.live**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/content`: pass
- `/chat`: pass
- `/search?q=minecraft`: pass
- `/vod/5627`: pass
- `/clip/369`: pass
- `/@JapaneseOldGuy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/content` ×5 (in-page+link): pass; growth lap 2→5: heap -18 KB, nodes -5, listeners -1, documents 0, intervals 0, timeouts +1, sockets 0
    - idle 5s after settle: CPU 22.7% (script 76 ms, style 186 ms, layout 22 ms), 15 request(s), 158.8 KB; 36 running animation(s), 33 infinite: `opacity on div.hero-float-inner`, `transform on div.hero-float-inner`, `heroBgKenBurns on div.hero-bg-layer`, `heroFloat3d on a.hero-float`

**https://openvibe.tools**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/developers`: pass
- `/updates`: pass
- `/tool/yaml`: pass
- `/all-tools`: pass
- `/network-tools`: pass
- `/developer-tools`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/developers` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 3 ms, style 0 ms, layout 0 ms), 2 request(s), 4.2 KB (`https://openvibe.tools/shared/release-watch.js`, `https://openvibe.tools/release.json`)

</details>

### Run 2026-09-26T08:38:16.818Z (local; Chrome/150.0.7843.0)

23/23 sites pass. Widths 390, 768, 1280; axe axe-core 4.13.0, WCAG 2.1 A/AA; navigation 5 laps. Cells: ✓ all pass, **n✗** routes failing, n! warnings, - not run.

| Site | Routes | Status | Errors | Overflow | Scripts | No-JS | Canonical | JSON-LD | axe | Nav | axe serious/critical (moderate) | Growth lap 2→last | Idle 5 s: CPU · requests · infinite animations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ai.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -3 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| billing.openvibe.network | 1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.blog | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -2 KB · 0 nodes · 0 lst | 0.2% · 3 req |
| openvibe.chat | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.1% · 3 req |
| openvibe.codes | 7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.1% · 3 req |
| openvibe.community | 6 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -3 KB · 0 nodes · -2 lst | 0.1% · 3 req |
| openvibe.coupons | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.deals | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.games | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -25 KB · 0 nodes · 0 lst | 13% · 3 req · 1 anim |
| openvibe.host | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.live | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +36 KB · +10 nodes · +1 lst | 21.6% · 16 req · 33 anim |
| openvibe.media | 3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.1% · 3 req |
| openvibe.network | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -4 KB · 0 nodes · -1 lst | 29.6% · 3 req · 19 anim |
| openvibe.news | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -2 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| openre.stream | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -7 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.reviews | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| search.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 3 req |
| sources.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | - | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.tips | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.tools | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · -2 lst | 0.4% · 3 req |
| openvibe.trade | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| openvibe.vip | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -2 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.wiki | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.1% · 3 req |

Known errors, counted and not failed (`--strict-errors` fails them):
- Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP: 17× on openvibe.media, sources.openvibe.network

<details><summary>Details: routes and findings per site</summary>

**https://ai.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -3 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://ai.openvibe.network/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://billing.openvibe.network**: pass (1 route(s), Chrome/150.0.7843.0)
- `/policy`: pass
- navigation `/policy` ↔ `/policy` ×5 (load): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.blog**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/@openvibe/patch-notes-staged-tables-move-to-chat-one-table-at-a-time`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap -2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.2% (script 4 ms, style 0 ms, layout 0 ms), 3 request(s), 5.9 KB (`https://openvibe.blog/shared/release-watch.js`, `https://openvibe.blog/release.json`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.chat**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/rooms`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/rooms` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 6 KB (`https://openvibe.chat/shared/release-watch.js`, `https://openvibe.chat/release.json`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.codes**: pass (7 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/tools/webhooks`: pass
- `/manifests/validate`: pass
- `/docs`: pass
- `/oauth`: pass
- `/policy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/tools/webhooks` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 5.9 KB (`https://openvibe.codes/shared/release-watch.js`, `https://openvibe.codes/release.json`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.community**: pass (6 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/pastes`: pass
- `/pulse`: pass
- `/p/rogue-frame-5292`: pass
- `/s`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/pastes` ×5 (link): pass; growth lap 2→5: heap -3 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 6 KB (`https://openvibe.community/shared/release-watch.js`, `https://openvibe.community/release.json`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.coupons**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.coupons/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.deals**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.deals/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.games**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -25 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 13% (script 3 ms, style 36 ms, layout 0 ms), 3 request(s), 0.3 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.games/release.json`, `https://events.openvibe.network/realtime/stream`); 1 running animation(s), 1 infinite: `pulse on a.play-cta`

**https://openvibe.host**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.host/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.live**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/content`: pass
- `/chat`: pass
- `/search?q=minecraft`: pass
- `/vod/5627`: pass
- `/clip/369`: pass
- `/@JapaneseOldGuy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/content` ×5 (in-page+link): pass; growth lap 2→5: heap +36 KB, nodes +10, listeners +1, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 21.6% (script 41 ms, style 180 ms, layout 17 ms), 16 request(s), 158.9 KB; 36 running animation(s), 33 infinite: `opacity on div.hero-float-inner`, `transform on div.hero-float-inner`, `heroBgKenBurns on div.hero-bg-layer`, `heroFloat3d on a.hero-float`

**https://openvibe.media**: pass (3 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 6.3 KB (`https://openvibe.media/shared/release-watch.js`, `https://openvibe.media/release.json`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.network**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/login`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap -4 KB, nodes 0, listeners -1, documents 0, intervals -1, timeouts 0, sockets 0
    - idle 5s after settle: CPU 29.6% (script 2 ms, style 115 ms, layout 149 ms), 3 request(s), 6.3 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.network/release.json`, `https://events.openvibe.network/realtime/stream`); 19 running animation(s), 19 infinite: `orb-drift on div.orb`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.news**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 4 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.news/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openre.stream**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -7 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 5 ms, style 0 ms, layout 0 ms), 3 request(s), 6.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openre.stream/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`
    - error during navigation: javascript: Access to resource at 'https://events.openvibe.network/realtime/stream?topics=host.release.published' from origin 'https://openre.stream' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
    - error during navigation: network: Failed to load resource: net::ERR_FAILED

**https://openvibe.reviews**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.reviews/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://search.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -2, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 6.2 KB (`https://search.openvibe.network/shared/release-watch.js`, `https://search.openvibe.network/release.json`, `https://events.openvibe.network/realtime/stream`)

**https://sources.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (load): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.tips**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.tips/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.tools**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/developers`: pass
- `/updates`: pass
- `/tool/yaml`: pass
- `/all-tools`: pass
- `/network-tools`: pass
- `/developer-tools`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/developers` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.4% (script 8 ms, style 0 ms, layout 0 ms), 3 request(s), 6.3 KB (`https://openvibe.tools/shared/release-watch.js`, `https://openvibe.tools/release.json`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.trade**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 7 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.trade/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.vip**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.vip/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.wiki**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/s/openvibe`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 6 KB (`https://openvibe.wiki/shared/release-watch.js`, `https://openvibe.wiki/release.json`, `https://events.openvibe.network/realtime/stream`)

</details>

### Run 2026-09-26T10:30:41.088Z (local; Chrome/150.0.7843.0)

23/23 sites pass. Widths 390, 768, 1280; axe axe-core 4.13.0, WCAG 2.1 A/AA; navigation 5 laps. Cells: ✓ all pass, **n✗** routes failing, n! warnings, - not run.

| Site | Routes | Status | Errors | Overflow | Scripts | No-JS | Canonical | JSON-LD | axe | Nav | axe serious/critical (moderate) | Growth lap 2→last | Idle 5 s: CPU · requests · infinite animations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ai.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| billing.openvibe.network | 1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.blog | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +5 KB · 0 nodes · 0 lst | 0.1% · 4 req |
| openvibe.chat | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +4 KB · 0 nodes · 0 lst | 0.3% · 4 req |
| openvibe.codes | 7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.1% · 4 req |
| openvibe.community | 6 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 4 req |
| openvibe.coupons | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.deals | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -6 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.games | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +26 KB · 0 nodes · +2 lst | 15.4% · 3 req · 1 anim |
| openvibe.host | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| openvibe.live | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -77 KB · 0 nodes · 0 lst | 24.8% · 17 req · 33 anim |
| openvibe.media | 3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · -2 lst | 0.1% · 4 req |
| openvibe.network | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 30.3% · 4 req · 19 anim |
| openvibe.news | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -7 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openre.stream | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| openvibe.reviews | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| search.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.4% · 4 req |
| sources.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | - | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.tips | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0.5% · 3 req · 3 anim |
| openvibe.tools | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -3 KB · 0 nodes · -2 lst | 0.1% · 4 req |
| openvibe.trade | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| openvibe.vip | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.4% · 3 req · 3 anim |
| openvibe.wiki | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -6 KB · 0 nodes · -2 lst | 0.2% · 4 req |

Known errors, counted and not failed (`--strict-errors` fails them):
- Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP: 17× on openvibe.media, sources.openvibe.network

<details><summary>Details: routes and findings per site</summary>

**https://ai.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://ai.openvibe.network/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://billing.openvibe.network**: pass (1 route(s), Chrome/150.0.7843.0)
- `/policy`: pass
- navigation `/policy` ↔ `/policy` ×5 (load): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.blog**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/@openvibe/patch-notes-chat-parity-script`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +5 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.blog/shared/release-watch.js`, `https://openvibe.blog/release.json`, `https://openvibe.blog/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.chat**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/rooms`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/rooms` ×5 (link): pass; growth lap 2→5: heap +4 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.chat/shared/release-watch.js`, `https://openvibe.chat/release.json`, `https://openvibe.chat/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.codes**: pass (7 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/tools/webhooks`: pass
- `/manifests/validate`: pass
- `/docs`: pass
- `/oauth`: pass
- `/policy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/tools/webhooks` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.codes/shared/release-watch.js`, `https://openvibe.codes/release.json`, `https://openvibe.codes/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.community**: pass (6 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/pastes`: pass
- `/pulse`: pass
- `/p/rogue-frame-5292`: pass
- `/s`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/pastes` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.community/shared/release-watch.js`, `https://openvibe.community/release.json`, `https://openvibe.community/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.coupons**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.coupons/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.deals**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -6 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.deals/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.games**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +26 KB, nodes 0, listeners +2, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 15.4% (script 5 ms, style 42 ms, layout 0 ms), 3 request(s), 0.3 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.games/release.json`, `https://events.openvibe.network/realtime/stream`); 1 running animation(s), 1 infinite: `pulse on a.play-cta`

**https://openvibe.host**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 6 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.host/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.live**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/content`: pass
- `/chat`: pass
- `/search?q=minecraft`: pass
- `/vod/5627`: pass
- `/clip/369`: pass
- `/@JapaneseOldGuy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/content` ×5 (in-page+link): pass; growth lap 2→5: heap -77 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 24.8% (script 55 ms, style 182 ms, layout 22 ms), 17 request(s), 158.8 KB; 36 running animation(s), 33 infinite: `opacity on div.hero-float-inner`, `transform on div.hero-float-inner`, `heroBgKenBurns on div.hero-bg-layer`, `heroFloat3d on a.hero-float`

**https://openvibe.media**: pass (3 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 4 request(s), 6.4 KB (`https://openvibe.media/shared/release-watch.js`, `https://openvibe.media/release.json`, `https://openvibe.media/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.network**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/login`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 30.3% (script 3 ms, style 123 ms, layout 164 ms), 4 request(s), 6.4 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.network/release.json`, `https://openvibe.network/release-metrics`, `https://events.openvibe.network/realtime/stream`); 19 running animation(s), 19 infinite: `orb-drift on div.orb`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.news**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -7 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 4 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.news/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openre.stream**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.3 KB (`https://openvibe.network/shared/release-watch.js`, `https://openre.stream/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.reviews**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.reviews/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://search.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.4% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.7 KB (`https://search.openvibe.network/shared/release-watch.js`, `https://search.openvibe.network/release.json`, `https://search.openvibe.network/release-metrics`, `https://events.openvibe.network/realtime/stream`)
    - error during navigation: network: Failed to load resource: the server responded with a status of 404 ()

**https://sources.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (load): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.tips**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.5% (script 7 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.tips/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.tools**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/developers`: pass
- `/updates`: pass
- `/tool/yaml`: pass
- `/all-tools`: pass
- `/network-tools`: pass
- `/developer-tools`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/developers` ×5 (link): pass; growth lap 2→5: heap -3 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.4 KB (`https://openvibe.tools/shared/release-watch.js`, `https://openvibe.tools/release.json`, `https://openvibe.tools/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.trade**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.trade/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.vip**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.4% (script 7 ms, style 0 ms, layout 0 ms), 3 request(s), 6.4 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.vip/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.wiki**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/s/openvibe`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap -6 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 7 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.wiki/shared/release-watch.js`, `https://openvibe.wiki/release.json`, `https://openvibe.wiki/release-metrics`, `https://events.openvibe.network/realtime/stream`)

</details>

### Run 2026-09-26T10:46:24.226Z (local; Chrome/150.0.7843.0)

23/23 sites pass. Widths 390, 768, 1280; axe axe-core 4.13.0, WCAG 2.1 A/AA; navigation 5 laps. Cells: ✓ all pass, **n✗** routes failing, n! warnings, - not run.

| Site | Routes | Status | Errors | Overflow | Scripts | No-JS | Canonical | JSON-LD | axe | Nav | axe serious/critical (moderate) | Growth lap 2→last | Idle 5 s: CPU · requests · infinite animations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ai.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +3 KB · 0 nodes · +2 lst | 0.3% · 3 req · 3 anim |
| billing.openvibe.network | 1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.blog | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.2% · 4 req |
| openvibe.chat | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.1% · 4 req |
| openvibe.codes | 7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.1% · 4 req |
| openvibe.community | 6 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 4 req |
| openvibe.coupons | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -16 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.deals | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.games | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -1 KB · 0 nodes · 0 lst | 12.9% · 3 req · 1 anim |
| openvibe.host | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.live | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +34 KB · +10 nodes · +1 lst | 22% · 17 req · 33 anim |
| openvibe.media | 3 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | +3 KB · 0 nodes · 0 lst | 0.3% · 4 req |
| openvibe.network | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -3 KB · 0 nodes · +1 lst | 28.4% · 4 req · 19 anim |
| openvibe.news | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +1 KB · 0 nodes · 0 lst | 0.6% · 3 req · 3 anim |
| openre.stream | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +3 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.reviews | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | -2 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| search.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.3% · 4 req |
| sources.openvibe.network | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | - | - | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0% · 0 req |
| openvibe.tips | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.3% · 3 req · 3 anim |
| openvibe.tools | 8 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · -2 lst | 0.2% · 4 req |
| openvibe.trade | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.vip | 2 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | +2 KB · 0 nodes · 0 lst | 0.2% · 3 req · 3 anim |
| openvibe.wiki | 4 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0/0 (0) | 0 KB · 0 nodes · 0 lst | 0.1% · 4 req |

Known errors, counted and not failed (`--strict-errors` fails them):
- Cloudflare Web Analytics beacon, injected at the edge, blocked by the site CSP: 17× on openvibe.media, sources.openvibe.network

<details><summary>Details: routes and findings per site</summary>

**https://ai.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +3 KB, nodes 0, listeners +2, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://ai.openvibe.network/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://billing.openvibe.network**: pass (1 route(s), Chrome/150.0.7843.0)
- `/policy`: pass
- navigation `/policy` ↔ `/policy` ×5 (load): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.blog**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/@openvibe/patch-notes-chat-parity-script`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.blog/shared/release-watch.js`, `https://openvibe.blog/release.json`, `https://openvibe.blog/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.chat**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/rooms`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/rooms` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.1% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.chat/shared/release-watch.js`, `https://openvibe.chat/release.json`, `https://openvibe.chat/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.codes**: pass (7 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/tools/webhooks`: pass
- `/manifests/validate`: pass
- `/docs`: pass
- `/oauth`: pass
- `/policy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/tools/webhooks` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 2 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.codes/shared/release-watch.js`, `https://openvibe.codes/release.json`, `https://openvibe.codes/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.community**: pass (6 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/pastes`: pass
- `/pulse`: pass
- `/p/rogue-frame-5292`: pass
- `/s`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/pastes` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.community/shared/release-watch.js`, `https://openvibe.community/release.json`, `https://openvibe.community/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.coupons**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -16 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.coupons/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.deals**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.deals/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.games**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 12.9% (script 3 ms, style 35 ms, layout 0 ms), 3 request(s), 0.3 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.games/release.json`, `https://events.openvibe.network/realtime/stream`); 1 running animation(s), 1 infinite: `pulse on a.play-cta`

**https://openvibe.host**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.host/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.live**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/content`: pass
- `/chat`: pass
- `/search?q=minecraft`: pass
- `/vod/5627`: pass
- `/clip/369`: pass
- `/@JapaneseOldGuy`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/content` ×5 (in-page+link): pass; growth lap 2→5: heap +34 KB, nodes +10, listeners +1, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 22% (script 46 ms, style 182 ms, layout 20 ms), 17 request(s), 158.8 KB; 36 running animation(s), 33 infinite: `opacity on div.hero-float-inner`, `transform on div.hero-float-inner`, `heroBgKenBurns on div.hero-bg-layer`, `heroFloat3d on a.hero-float`

**https://openvibe.media**: pass (3 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap +3 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.4 KB (`https://openvibe.media/shared/release-watch.js`, `https://openvibe.media/release.json`, `https://openvibe.media/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.network**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/login`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap -3 KB, nodes 0, listeners +1, documents 0, intervals -1, timeouts 0, sockets 0
    - idle 5s after settle: CPU 28.4% (script 3 ms, style 130 ms, layout 155 ms), 4 request(s), 6.4 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.network/release.json`, `https://openvibe.network/release-metrics`, `https://events.openvibe.network/realtime/stream`); 19 running animation(s), 19 infinite: `orb-drift on div.orb`, `ovmFloat on svg`, `ovmGlow on circle`, `ovmComet on circle`

**https://openvibe.news**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +1 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.6% (script 7 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.news/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openre.stream**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +3 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openre.stream/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.reviews**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap -2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.reviews/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://search.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts -2, sockets 0
    - idle 5s after settle: CPU 0.3% (script 5 ms, style 0 ms, layout 0 ms), 4 request(s), 6.6 KB (`https://search.openvibe.network/shared/release-watch.js`, `https://search.openvibe.network/release.json`, `https://search.openvibe.network/release-metrics`, `https://events.openvibe.network/realtime/stream`)
    - error during navigation: network: Failed to load resource: the server responded with a status of 404 ()

**https://sources.openvibe.network**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass (application/problem+json: only the status is checked)
- navigation `/` ↔ `/` ×5 (load): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0% (script 0 ms, style 0 ms, layout 0 ms), 0 request(s), 0 KB

**https://openvibe.tips**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.3% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.tips/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.tools**: pass (8 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/developers`: pass
- `/updates`: pass
- `/tool/yaml`: pass
- `/all-tools`: pass
- `/network-tools`: pass
- `/developer-tools`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/developers` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners -2, documents 0, intervals 0, timeouts -1, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 4 request(s), 6.4 KB (`https://openvibe.tools/shared/release-watch.js`, `https://openvibe.tools/release.json`, `https://openvibe.tools/release-metrics`, `https://events.openvibe.network/realtime/stream`)

**https://openvibe.trade**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 2 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.trade/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.vip**: pass (2 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/` ×5 (link): pass; growth lap 2→5: heap +2 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.2% (script 3 ms, style 0 ms, layout 0 ms), 3 request(s), 0.2 KB (`https://openvibe.network/shared/release-watch.js`, `https://openvibe.vip/release.json`, `https://events.openvibe.network/realtime/stream`); 3 running animation(s), 3 infinite: `drift on i`

**https://openvibe.wiki**: pass (4 route(s), Chrome/150.0.7843.0)
- `/`: pass
- `/updates`: pass
- `/s/openvibe`: pass
- `/__ovcheck-404`: pass
- navigation `/` ↔ `/updates` ×5 (link): pass; growth lap 2→5: heap 0 KB, nodes 0, listeners 0, documents 0, intervals 0, timeouts 0, sockets 0
    - idle 5s after settle: CPU 0.1% (script 3 ms, style 0 ms, layout 0 ms), 4 request(s), 6.1 KB (`https://openvibe.wiki/shared/release-watch.js`, `https://openvibe.wiki/release.json`, `https://openvibe.wiki/release-metrics`, `https://events.openvibe.network/realtime/stream`)

</details>

### Network-down run 2026-09-26T11:03:32.079Z (ADR-024)

20/22 sites paint with openvibe.network unreachable (every request to it fails). Checked at 390 and 1280 px: status 200, settled, at least 200 characters of text, a `--accent` theme token and a background.

| Site | 390 | 1280 | --accent | Note |
|---|---|---|---|---|
| ai.openvibe.network | ✓ | ✓ | #3b82f6 |  |
| billing.openvibe.network | **✗** 200 188 chars | ✓ | #7aa7ff |  |
| openvibe.blog | ✓ | ✓ | #3b82f6 |  |
| openvibe.chat | ✓ | ✓ | #3b82f6 |  |
| openvibe.codes | ✓ | ✓ | #3b82f6 |  |
| openvibe.community | ✓ | ✓ | #3b82f6 |  |
| openvibe.coupons | ✓ | ✓ | #3b82f6 |  |
| openvibe.deals | ✓ | ✓ | #3b82f6 |  |
| openvibe.games | ✓ | ✓ | #3b82f6 |  |
| openvibe.host | ✓ | ✓ | #3b82f6 |  |
| openvibe.live | ✓ | ✓ | #3b82f6 |  |
| openvibe.media | **✗** 200 no theme | **✗** 200 no theme | — |  |
| openvibe.news | ✓ | ✓ | #3b82f6 |  |
| openre.stream | ✓ | ✓ | #3b82f6 |  |
| openvibe.reviews | ✓ | ✓ | #3b82f6 |  |
| search.openvibe.network | ✓ | ✓ | #3b82f6 |  |
| sources.openvibe.network | ✓ | ✓ | #7aa2ff |  |
| openvibe.tips | ✓ | ✓ | #3b82f6 |  |
| openvibe.tools | ✓ | ✓ | #3b82f6 |  |
| openvibe.trade | ✓ | ✓ | #3b82f6 |  |
| openvibe.vip | ✓ | ✓ | #3b82f6 |  |
| openvibe.wiki | ✓ | ✓ | #3b82f6 |  |

### Network-down run 2026-09-26T11:09:21.983Z (ADR-024)

22/22 sites paint with openvibe.network unreachable (every request to it fails). Checked at 390 and 1280 px: status 200, settled, at least 120 characters of text, a `--accent` theme token and a background.

| Site | 390 | 1280 | --accent | Note |
|---|---|---|---|---|
| ai.openvibe.network | ✓ | ✓ | #3b82f6 |  |
| billing.openvibe.network | ✓ | ✓ | #7aa7ff |  |
| openvibe.blog | ✓ | ✓ | #3b82f6 |  |
| openvibe.chat | ✓ | ✓ | #3b82f6 |  |
| openvibe.codes | ✓ | ✓ | #3b82f6 |  |
| openvibe.community | ✓ | ✓ | #3b82f6 |  |
| openvibe.coupons | ✓ | ✓ | #3b82f6 |  |
| openvibe.deals | ✓ | ✓ | #3b82f6 |  |
| openvibe.games | ✓ | ✓ | #3b82f6 |  |
| openvibe.host | ✓ | ✓ | #3b82f6 |  |
| openvibe.live | ✓ | ✓ | #3b82f6 |  |
| openvibe.media | ✓ | ✓ | #3b82f6 |  |
| openvibe.news | ✓ | ✓ | #3b82f6 |  |
| openre.stream | ✓ | ✓ | #3b82f6 |  |
| openvibe.reviews | ✓ | ✓ | #3b82f6 |  |
| search.openvibe.network | ✓ | ✓ | #3b82f6 |  |
| sources.openvibe.network | ✓ | ✓ | #7aa2ff |  |
| openvibe.tips | ✓ | ✓ | #3b82f6 |  |
| openvibe.tools | ✓ | ✓ | #3b82f6 |  |
| openvibe.trade | ✓ | ✓ | #3b82f6 |  |
| openvibe.vip | ✓ | ✓ | #3b82f6 |  |
| openvibe.wiki | ✓ | ✓ | #3b82f6 |  |
