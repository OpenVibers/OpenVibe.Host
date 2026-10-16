'use strict';
/**
 * /console on openvibe.host, with the person's Host session:
 *
 *   GET  /console                                       every server across the connected accounts, totals, the forms
 *   POST /console/accounts                              connect an account (provider, API token, an optional label)
 *   POST /console/accounts/:id/remove                   disconnect it (the sealed token is deleted)
 *   POST /console/accounts/:id/servers/:server/:action  start, stop or reboot a server
 *
 * Every POST is a form from this site with its form token (auth/forms.js); answers are private and never cached.
 */
const express = require('express');
const { renderPage, esc } = require('../render/layout');
const { csrfToken, checkCsrf, sameOrigin } = require('../auth/forms');
const { PROVIDERS } = require('./providers');

const money = (n, cur) => (n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n));
const ram = (mb) => (mb == null ? '—' : mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
const STATUS = { running: ['Running', 'is-ok'], stopped: ['Stopped', 'is-off'], other: ['Changing', 'is-busy'] };

function page({ viewer, config, data, csrf, notice, available }) {
    const acctCards = data.accounts.map((a) => `<li class="cs-acct">
  <div><b>${esc(PROVIDERS[a.provider].name)}</b> <span class="cs-muted">${esc(a.label)} · token …${esc(a.token_hint)}</span>
    <div class="cs-muted">${a.error ? `<span class="cs-bad">${esc(a.error)}</span>` : `${a.servers} server${a.servers === 1 ? '' : 's'}`}</div></div>
  <form method="post" action="/console/accounts/${esc(a.id)}/remove" onsubmit="return confirm('Disconnect this account? Its token is deleted from OpenVibe.Host.')"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="cs-btn cs-quiet" type="submit">Disconnect</button></form>
</li>`).join('');
    const rows = data.servers.map((s) => {
        const [label, cls] = STATUS[s.status] || STATUS.other;
        const btn = (action, text) => `<form method="post" action="/console/accounts/${esc(s.account_id)}/servers/${esc(encodeURIComponent(s.id))}/${action}"${action === 'stop' ? ` onsubmit="return confirm('Power off ${esc(String(s.name).replace(/'/g, ''))}?')"` : ''}><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="cs-btn cs-small" type="submit">${text}</button></form>`;
        return `<tr>
  <td class="cs-name"><b>${esc(s.name)}</b><div class="cs-muted">${esc(PROVIDERS[s.provider].name)} · ${esc(s.region || '—')}${s.plan ? ` · ${esc(s.plan)}` : ''}</div></td>
  <td data-label="Status"><span class="cs-status ${cls}">${label}</span></td>
  <td data-label="Size">${s.vcpu ?? '—'} vCPU · ${ram(s.ram_mb)}${s.disk_gb ? ` · ${s.disk_gb} GB` : ''}</td>
  <td data-label="IPv4" class="cs-mono">${esc(s.ipv4 || '—')}</td>
  <td data-label="Monthly" class="cs-num">${money(s.price?.monthly, s.price?.currency)}${s.cheaper ? `<div class="cs-save"><a href="/catalog/plans/${esc(s.cheaper.id)}">${esc(s.cheaper.provider)} has it for ${money(s.cheaper.monthly, 'USD')}</a></div>` : ''}</td>
  <td class="cs-act-cell"><div class="cs-actions">${s.status === 'running' ? btn('reboot', 'Reboot') + btn('stop', 'Power off') : s.status === 'stopped' ? btn('start', 'Power on') : ''}</div></td>
</tr>`;
    }).join('');
    const totals = Object.entries(data.totals).map(([cur, n]) => money(n, cur)).join(' + ') || '—';
    const body = `<section class="cs">
  <header class="cs-head">
    <div><p class="cs-eyebrow">OpenVibe.Host · console</p><h1>Your servers, every provider</h1>
      <p class="cs-lede">Connect your own hosting accounts and see and run all your servers in one place, with where the catalog has the same size for less.</p></div>
    <div class="cs-stats"><div><b>${data.servers.length}</b><span>servers</span></div><div><b>${data.running}</b><span>running</span></div><div><b>${esc(totals)}</b><span>a month</span></div></div>
  </header>
  ${data.servers.length ? `<div class="cs-table-wrap"><table class="cs-table"><thead><tr><th>Server</th><th>Status</th><th>Size</th><th>IPv4</th><th>Monthly</th><th><a class="cs-refresh" href="/console?fresh=1">Refresh</a></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="cs-empty">${data.accounts.length ? 'No servers in the connected accounts yet.' : 'Connect a hosting account below to see its servers here.'}</p>`}
  <div class="cs-grid">
    <section class="cs-card" aria-labelledby="cs-accts"><h2 id="cs-accts">Connected accounts</h2>
      ${data.accounts.length ? `<ul class="cs-accts">${acctCards}</ul>` : '<p class="cs-muted">None yet.</p>'}
    </section>
    <section class="cs-card" aria-labelledby="cs-add"><h2 id="cs-add">Connect an account</h2>
      ${available ? `<form method="post" action="/console/accounts" class="cs-form">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <label>Provider<select name="provider" required>${Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>API token<input name="token" type="password" autocomplete="off" required minlength="16" maxlength="512" placeholder="Paste the token"></label>
        <label><span>Label <span class="cs-muted">(optional)</span></span><input name="label" maxlength="60" placeholder="Work, side projects…"></label>
        <button class="cs-btn" type="submit">Connect</button>
        <details class="cs-help"><summary>Where do I get a token?</summary><ul>${Object.values(PROVIDERS).map((p) => `<li><a href="${esc(p.tokenUrl)}" rel="noopener" target="_blank">${esc(p.name)}</a>: ${esc(p.tokenHelp)}</li>`).join('')}</ul></details>
        <p class="cs-muted">The token is checked with the provider, then stored encrypted and used only to call that provider for you. Disconnecting deletes it.</p>
      </form>` : '<p class="cs-muted">Connecting accounts is not set up on this server yet.</p>'}
    </section>
  </div>
  ${data.actions.length ? `<section class="cs-card"><h2>Recent actions</h2><ul class="cs-log">${data.actions.map((a) => `<li><span class="cs-muted">${esc(new Date(Number(a.at)).toISOString().replace('T', ' ').slice(0, 16))}</span> ${esc(a.action)} <b>${esc(a.server_name)}</b> (${esc(PROVIDERS[a.provider]?.name || a.provider)}): ${esc(a.result)}</li>`).join('')}</ul></section>` : ''}
</section>`;
    return renderPage({ title: 'Console', body, viewer, config, path: '/console', notice, css: ['css/console.css'] });
}

function createConsolePages(ctx) {
    const { config, viewers, console: con, log = console } = ctx;
    const router = express.Router();
    const urlencoded = express.urlencoded({ extended: false, limit: '8kb' });
    router.use(viewers.middleware('dashboard'));
    if (ctx.actorLimits) router.use(ctx.actorLimits);
    router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user';
    const back = (res, kind, text) => res.redirect(303, `/console?${new URLSearchParams({ kind, notice: text })}`);

    router.get('/', async (req, res, next) => {
        try {
            if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fconsole');
            const data = await con.overview(req.viewer.subject, { fresh: req.query.fresh === '1' });
            const n = typeof req.query.notice === 'string' && req.query.notice.length < 300 ? { kind: req.query.kind === 'error' ? 'error' : 'info', text: req.query.notice } : null;
            res.type('html').send(page({ viewer: req.viewer, config, data, csrf: csrfToken(config, req.viewer), notice: n, available: con.available() }));
        } catch (err) { next(err); }
    });

    const action = (fn) => [urlencoded, async (req, res) => {
        if (!signedIn(req)) return res.redirect(303, '/auth/login?next=%2Fconsole');
        if (!sameOrigin(config, req) || !checkCsrf(config, req.viewer, req.body && req.body.csrf)) return back(res, 'error', 'That form expired or did not come from this page; try again.');
        try { await fn(req, res); } catch (err) {
            if (!err.status || err.status >= 500 && err.code !== 'console.action_failed' && err.code !== 'console.verify') log.error('[Host console]', err && err.stack ? err.stack : err);
            back(res, 'error', err.status && err.status < 600 && err.message ? err.message : 'Something went wrong on our side.');
        }
    }];
    router.post('/accounts', ...action(async (req, res) => {
        await con.connect(req.viewer.subject, { provider: req.body.provider, token: req.body.token, label: req.body.label });
        back(res, 'info', `${PROVIDERS[req.body.provider].name} connected.`);
    }));
    router.post('/accounts/:id/remove', ...action(async (req, res) => {
        await con.disconnect(req.viewer.subject, req.params.id);
        back(res, 'info', 'Account disconnected; its token is deleted.');
    }));
    router.post('/accounts/:id/servers/:server/:action', ...action(async (req, res) => {
        const r = await con.act(req.viewer.subject, req.params.id, req.params.server, req.params.action);
        back(res, 'info', `${{ start: 'Power on', stop: 'Power off', reboot: 'Reboot' }[r.action]} sent to ${r.server.name}.`);
    }));
    return router;
}

module.exports = { createConsolePages };
