'use strict';

/**
 * Dashboard page shell. Every page is server-rendered and complete without JavaScript (all actions
 * are plain forms); the OpenVibe Frame (navbar.js + theme-loader.js from the Network) is progressive.
 * Dashboard pages are private: noindex, private caching.
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const frame = require('openvibe-shared/frame');
const shell = require('openvibe-shared/shell');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Host';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

/** o: title, body (HTML), viewer, config, path, notice { kind, text } */
function renderPage(o) {
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const loginNext = encodeURIComponent(o.path || '/');
    const nav = {
        service: 'host',
        apiBase: NETWORK_URL,
        links: [{ label: 'Projects', href: '/' }],
        history: { type: 'page', title: o.title || SITE_NAME },
        silentLogin: `${o.config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',   // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,   // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
    };
    const who = signedIn ? esc((viewer.user && (viewer.user.display_name || viewer.user.username)) || viewer.subject) : '';
    // This site's own account links live in the shared navbar's account menu (the page's account
    // bar below is only for visitors without JavaScript).
    if (signedIn) nav.menu = { before: [] };
    const footer = { service: 'host', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };
    const account = signedIn
        ? `Signed in as ${who} · <a href="/auth/logout?next=%2F">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const notice = o.notice ? `<p class="notice notice-${esc(o.notice.kind || 'info')}" role="status">${esc(o.notice.text)}</p>` : '';
    // shell.page (openvibe-shared/shell) writes the document, the SEO head, the theme-loader, navbar.js and
    // footer.js with the navbar init, the noscript nav and the SSR footer; the rest of the head and the body
    // are this site's own. Only Host's own pages come through here, never a tenant site (http/tenant.js).
    const canonical = o.indexable ? `${o.config.baseUrl}${o.path && o.path.split('?')[0] !== '/' ? o.path.split('?')[0] : '/'}` : undefined;
    return shell.page({
        name: SITE_NAME, service: 'host', lang: 'en',
        title: o.title || SITE_NAME,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : undefined,
        siteName: SITE_NAME,
        description: 'OpenVibe.Host: static site hosting for OpenVibe projects (alpha).',
        canonical,
        robots: o.indexable ? 'index, follow' : 'noindex, nofollow',
        navbar: nav, footer, home: '/', navLinks: [{ label: 'Projects', href: '/' }],
        head: [
            appIcon.headTags({ site: 'host' }),
            `<link rel="stylesheet" href="${asset('css/host.css')}">`,
            // openvibe-shared stylesheets a page asks for by name (the front page's showcase.css)
            ...(o.styles || []).map((name) => `<link rel="stylesheet" href="${esc(ovServe.url(name))}">`),
            `<meta name="ov-boost" content="host@${esc(RELEASE)}">`,
            `<script src="${ovServe.url('boost.js')}" data-main="#main" defer></script>`,
        ].join('\n'),
        body: `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${account}</div></noscript>
<main id="main" class="page">
${notice}
${o.body || ''}
${o.path === '/' ? frame.shipped({ service: 'host', title: `Recently shipped on ${SITE_NAME}` }) : ''}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the SSR footer stays */ }
});
</script>`,
    });
}

module.exports = { renderPage, esc, asset, assetVersion, setRelease, SITE_NAME, NETWORK_URL };
