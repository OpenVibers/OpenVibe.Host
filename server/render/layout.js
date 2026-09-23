'use strict';

/**
 * Dashboard page shell. Every page is server-rendered and complete without JavaScript (all actions
 * are plain forms); the shared chrome (navbar.js + theme-loader.js from the Network) is progressive.
 * Dashboard pages are private: noindex, private caching.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const chrome = require('openvibe-shared/chrome-ssr');

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
        loginUrl: `/auth/login?next=${loginNext}`,
    };
    const who = signedIn ? esc((viewer.user && (viewer.user.display_name || viewer.user.username)) || viewer.subject) : '';
    const account = signedIn
        ? `Signed in as ${who} · <a href="/auth/logout?next=%2F">Sign out</a>`
        : `<a href="/auth/login?next=${loginNext}">Sign in with OpenVibe</a>`;
    const notice = o.notice ? `<p class="notice notice-${esc(o.notice.kind || 'info')}" role="status">${esc(o.notice.text)}</p>` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title ? `${o.title} · ${SITE_NAME}` : SITE_NAME)}</title>
<meta name="robots" content="${o.indexable ? 'index, follow' : 'noindex, nofollow'}">
${o.indexable ? `<link rel="canonical" href="${esc(`${o.config.baseUrl}${o.path && o.path.split('?')[0] !== '/' ? o.path.split('?')[0] : '/'}`)}">` : ''}
<meta name="description" content="OpenVibe.Host: static site hosting for OpenVibe projects (alpha).">
${appIcon.headTags({ site: 'host' })}
<link rel="stylesheet" href="${asset('css/host.css')}">
<script src="${NETWORK_URL}/shared/theme-loader.js" defer></script>
<script src="${NETWORK_URL}/shared/navbar.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
${chrome.noscriptNav({ name: SITE_NAME, home: '/', links: [{ label: 'Projects', href: '/' }] })}
<div class="account-bar" role="navigation" aria-label="Account">${account}</div>
<main id="main" class="page">
${notice}
${o.body || ''}
</main>
${chrome.footer({ service: 'host', variant: 'full' })}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the chrome is optional */ }
});
</script>
</body>
</html>`;
}

module.exports = { renderPage, esc, asset, assetVersion, SITE_NAME, NETWORK_URL };
