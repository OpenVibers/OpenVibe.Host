# Shared-host outage test (roadmap WS-P task 5)

Every OpenVibe site must still render its content, its navigation and its theme when openvibe.network
(and every *.openvibe.network host) does not answer: the OpenVibe Frame (navbar, footer, "shipped"
widget) and the theme loader load from there, so a site has to degrade, never go blank.

`scripts/shared-host-outage.js` loads each public site's home page in headless Chrome with the Network
domain blocked, and checks:
- **content:** at least 200 characters of text;
- **navigation:** at least 3 visible links in a nav or header;
- **theme:** a styled page;
- **dependency:** that requests to openvibe.network really were blocked.

The site list comes from the registry. Run it after a Frame or theme change:

```sh
node scripts/shared-host-outage.js --out docs/shared-host-outage.md
```

## Findings

**2026-09-26, first run:** 16 of 18 sites passed.
- `openvibe.games` had no navigation without openvibe.network: its navbar mounted only from there and it had no server-rendered footer.
  - Games `ef3b2cf` added a plain navigation that shows until the shared navbar mounts, and deferred its theme loader.
- `openvibe.media` was reported without a theme, but a screenshot showed it fully themed: it inlines its own colours, not the token names. The check now also accepts a page's own text colour on a styled background.

### Run 2026-09-26T01:25:24.760Z

| Site | Result | Text (chars) | Nav links | Theme | Blocked requests |
|---|---|---|---|---|---|
| https://openre.stream | pass | 2710 | 7 | yes | 5 |
| https://openvibe.blog | pass | 2366 | 7 | yes | 6 |
| https://openvibe.chat | pass | 2831 | 8 | yes | 4 |
| https://openvibe.codes | pass | 1801 | 10 | yes | 6 |
| https://openvibe.community | pass | 3058 | 9 | yes | 6 |
| https://openvibe.coupons | pass | 2409 | 7 | yes | 5 |
| https://openvibe.deals | pass | 2392 | 7 | yes | 5 |
| https://openvibe.games | pass | 1372 | 7 | yes | 3 |
| https://openvibe.host | pass | 3163 | 7 | yes | 5 |
| https://openvibe.live | pass | 12031 | 12 | yes | 6 |
| https://openvibe.media | pass | 7813 | 9 | yes | 5 |
| https://openvibe.news | pass | 2517 | 7 | yes | 5 |
| https://openvibe.reviews | pass | 2481 | 7 | yes | 5 |
| https://openvibe.tips | pass | 2527 | 7 | yes | 5 |
| https://openvibe.tools | pass | 13843 | 8 | yes | 5 |
| https://openvibe.trade | pass | 2419 | 7 | yes | 5 |
| https://openvibe.vip | pass | 2478 | 7 | yes | 5 |
| https://openvibe.wiki | pass | 1298 | 7 | yes | 6 |
