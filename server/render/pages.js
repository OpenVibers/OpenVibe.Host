'use strict';
/**
 * Dashboard page bodies. Every value is escaped; every action is a POST form carrying the form
 * token, so the dashboard works without JavaScript.
 */
const showcase = require('openvibe-shared/showcase');
const { esc } = require('./layout');

const bytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GiB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
const when = (ms) => (ms ? `<time datetime="${new Date(ms).toISOString()}">${esc(new Date(ms).toISOString().replace('T', ' ').slice(0, 16))} UTC</time>` : '');
const short = (id) => esc(String(id || '').slice(0, 12));

function form(action, csrf, inner, { cls = '', confirm = null, enctype = null } = {}) {
    return `<form method="post" action="${esc(action)}"${cls ? ` class="${cls}"` : ''}${enctype ? ` enctype="${enctype}"` : ''}>`
        + `<input type="hidden" name="csrf" value="${esc(csrf)}">${inner}`
        + `${confirm ? `<label class="confirm"><input type="checkbox" name="confirm" value="yes" required> ${esc(confirm)}</label>` : ''}</form>`;
}

/** A limit as the front page prints it: bytes in binary units, 0 as "none" (the environment allows none). */
const limitValue = (n, unit) => (n === 0 ? 'none' : unit === 'bytes' ? bytes(n) : Number(n).toLocaleString('en-US'));

/**
 * The signed-out front page: the public page of openvibe.host, built with openvibe-shared/showcase. The limits table
 * is limitsOf(config), the same object /limits.json serves, so the page never promises more than Host enforces.
 */
function signedOut({ limits, limitsUrl } = {}) {
    return showcase.hero({
        eyebrow: 'OpenVibe.Host · alpha',
        title: 'Publish a static site.', accent: 'Roll back in one step.',
        lede: 'Upload a folder or a .tar.gz of HTML, CSS, JavaScript, images and fonts. Every deploy is kept as an immutable, content-addressed artifact; the active one is served at <site>.openvibe.host and on custom domains you verify.',
        actions: [{ label: 'Sign in with OpenVibe', href: '/auth/login?next=%2F', primary: true }, { label: 'See the limits', href: '#limits' }],
        note: 'Alpha. Static files only: there is no build step and no server-side code, and nothing you upload is ever executed. Hosted bots, mods and apps are not available.',
    }) + showcase.features({
        title: 'What you get',
        items: [
            { icon: 'ov:upload', title: 'Upload from the browser or the API', text: 'A folder or an archive from the dashboard, or POST it to /api/v1. Archives are checked in memory and never extracted.' },
            { icon: 'ov:history', title: 'Every deploy kept', text: 'Deploys never change once made. Activate an earlier one to roll back, from the dashboard or the API.' },
            { icon: 'ov:dns', title: 'Your own domain', text: 'Add a domain and prove it with a DNS TXT record. It is served once verified and re-checked every day.' },
            { icon: 'ov:account', title: 'Projects for a team', text: 'Owners add maintainers and members per project. Sandbox projects have smaller quotas and stay out of search.' },
        ],
    }) + showcase.steps({
        title: 'Get a site online',
        items: [
            { title: 'Sign in', text: 'With your OpenVibe account.' },
            { title: 'Create a project', text: 'Production, or a sandbox to try things out.' },
            { title: 'Add a site', text: 'It gets its own name under openvibe.host.' },
            { title: 'Upload a deploy', text: 'Activate it, and roll back to any earlier deploy whenever you need to.' },
        ],
    }) + (limits ? showcase.limits({
        id: 'limits',
        title: 'Limits',
        lede: 'The defaults a new project starts with, by environment (the first row counts the projects one person owns).',
        columns: ['Production', 'Sandbox'],
        rows: limits.limits.map((l) => ({ label: l.label, values: [limitValue(l.production, l.unit), limitValue(l.sandbox, l.unit)] })),
        source: limitsUrl,
    }) : '');
}

function home({ projects, csrf }) {
    const rows = projects.map((p) => `<tr><td><a href="/projects/${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(p.environment)}</td><td>${esc(p.role || '')}</td><td>${when(p.created_at)}</td></tr>`).join('');
    return `<h1>Your projects</h1>
${projects.length ? `<table><thead><tr><th>Project</th><th>Environment</th><th>Your role</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>You have no projects yet.</p>'}
<h2>New project</h2>
${form('/projects', csrf, `<label>Name <input name="name" required maxlength="80"></label>
<label>Environment <select name="environment"><option value="production">production</option><option value="sandbox">sandbox (smaller quotas, noindex, no custom domains)</option></select></label>
<button type="submit">Create project</button>`)}`;
}

function quotaTable(quota, usage) {
    const row = (label, used, limit, fmt = (x) => esc(x)) => `<tr><th scope="row">${label}</th><td>${fmt(used)}</td><td>${fmt(limit)}</td></tr>`;
    return `<table class="quota"><thead><tr><th></th><th>Used</th><th>Limit</th></tr></thead><tbody>
${row('Storage', usage.storageBytes, quota.storageBytes, bytes)}
${row('Deploys in the last 24 h', usage.deploysLast24h, quota.deploysPerDay)}
${row('Sites', usage.sites, quota.sites)}
${row('Custom domains', usage.customDomains, quota.customDomains)}
<tr><th scope="row">Files per deploy</th><td></td><td>${esc(quota.maxFiles)}</td></tr>
<tr><th scope="row">Largest file</th><td></td><td>${bytes(quota.maxFileBytes)}</td></tr>
</tbody></table>`;
}

function project({ project: p, role, sites, quota, usage, members, csrf, siteUrl }) {
    const siteRows = sites.map((s) => `<tr><td><a href="/sites/${esc(s.id)}">${esc(s.name)}</a></td><td><a href="${esc(siteUrl(s))}" rel="noopener">${esc(siteUrl(s))}</a></td><td>${s.active_deploy_id ? `<code>${short(s.active_deploy_id)}</code>` : '<em>nothing published</em>'}</td></tr>`).join('');
    const memberRows = members.map((m) => `<tr><td><code>${esc(m.principal)}</code></td><td>${esc(m.role)}</td><td>${role === 'owner' && m.principal !== p.owner_subject
        ? form(`/projects/${p.id}/members/remove`, csrf, `<input type="hidden" name="principal" value="${esc(m.principal)}"><button type="submit" class="link">Remove</button>`, { cls: 'inline' }) : ''}</td></tr>`).join('');
    const canMaintain = role === 'owner' || role === 'maintainer' || role === 'staff';
    return `<p class="crumbs"><a href="/">Projects</a> ›</p>
<h1>${esc(p.name)}</h1>
<p class="meta"><code>${esc(p.id)}</code> · ${esc(p.environment)} · your role: ${esc(role)}${p.network_project_id ? ` · Network project <code>${esc(p.network_project_id)}</code>` : ''}</p>
<h2>Sites</h2>
${sites.length ? `<table><thead><tr><th>Site</th><th>Address</th><th>Active deploy</th></tr></thead><tbody>${siteRows}</tbody></table>` : '<p>No sites yet.</p>'}
${canMaintain ? form(`/projects/${p.id}/sites`, csrf, `<label>New site name <input name="name" required pattern="[a-z0-9-]{3,40}" maxlength="40" placeholder="my-site"></label><button type="submit">Create site</button>`) : ''}
<h2>Quotas</h2>
${quotaTable(quota, usage)}
<h2>Members</h2>
<table><thead><tr><th>Principal</th><th>Role</th><th></th></tr></thead><tbody>${memberRows}</tbody></table>
${role === 'owner' ? form(`/projects/${p.id}/members`, csrf, `<label>Principal <input name="principal" required placeholder="usr_… or app:app_…"></label>
<label>Role <select name="role"><option value="deployer">deployer</option><option value="maintainer">maintainer</option></select></label><button type="submit">Add or change</button>`) : ''}
${role === 'owner' || role === 'staff' ? `<h2>Delete project</h2>${form(`/projects/${p.id}/delete`, csrf, '<button type="submit" class="danger">Delete this project, its sites and every deploy</button>', { confirm: 'I understand every site stops at once' })}` : ''}`;
}

function domainBlock(d, instructions, csrf) {
    const status = d.status === 'verified' ? '<span class="ok">verified: served</span>' : `<span class="warn">${esc(d.status)}: not served</span>`;
    let body = `<li><strong>${esc(d.hostname)}</strong> · ${esc(d.kind)} · ${status}${d.last_error ? ` · <span class="muted">${esc(d.last_error)}</span>` : ''}`;
    if (instructions) {
        body += `<details${d.status === 'verified' ? '' : ' open'}><summary>DNS records</summary><table class="dns"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th></th></tr></thead><tbody>`
            + `<tr><td>${esc(instructions.verification.type)}</td><td><code>${esc(instructions.verification.name)}</code></td><td><code>${esc(instructions.verification.value)}</code></td><td>${esc(instructions.verification.note)}</td></tr>`
            + instructions.routing.map((r) => `<tr><td>${esc(r.type)}</td><td><code>${esc(r.name)}</code></td><td><code>${esc(r.value)}</code></td><td>${esc(r.note)}</td></tr>`).join('')
            + `</tbody></table><p class="muted">${esc(instructions.tls)}</p></details>`;
        if (d.status !== 'verified') body += form(`/domains/${d.id}/verify`, csrf, '<button type="submit">Check DNS now</button>', { cls: 'inline' });
        body += form(`/domains/${d.id}/delete`, csrf, '<button type="submit" class="link danger">Remove</button>', { cls: 'inline' });
    }
    return `${body}</li>`;
}

function site({ site: s, project: p, role, deploys, activations, domains, siteConfig, csrf, url, now = Date.now() }) {
    const canMaintain = role === 'owner' || role === 'maintainer' || role === 'staff';
    const canDeploy = role !== 'staff';
    // The site's one live preview (plan T12 J4): served to project members on this dashboard until it expires.
    const previewId = s.preview_deploy_id && Number(s.preview_expires_at) > now ? s.preview_deploy_id : null;
    const previewHref = (id) => `/preview/${encodeURIComponent(id)}/`;
    const rows = deploys.map((d) => {
        const active = d.id === s.active_deploy_id;
        const previewing = d.id === previewId;
        const actions = [];
        if (previewing && d.state === 'ready') actions.push(`<a href="${esc(previewHref(d.id))}" target="_blank" rel="noopener">Open preview</a>`);
        if (canDeploy && d.state === 'ready' && !active) actions.push(form(`/deploys/${d.id}/activate`, csrf, `<input type="hidden" name="expected_active" value="${esc(s.active_deploy_id || '')}"><button type="submit">Activate</button>`, { cls: 'inline' }));
        if (canMaintain && !active) actions.push(form(`/deploys/${d.id}/delete`, csrf, '<button type="submit" class="link danger">Delete</button>', { cls: 'inline' }));
        return `<tr${active ? ' class="active"' : ''}><td><a href="/deploys/${esc(d.id)}"><code>${short(d.id)}</code></a>${active ? ' <strong>active</strong>' : ''}${previewing ? ' <strong class="preview">preview</strong>' : ''}</td><td>${esc(d.state)}${d.failure_code ? ` (<code>${esc(d.failure_code)}</code>)` : ''}</td><td>${esc(d.file_count)}</td><td>${bytes(d.total_bytes)}</td><td>${when(d.created_at)}</td><td>${actions.join(' ')}</td></tr>`;
    }).join('');
    const history = activations.slice(0, 10).map((a) => `<li>${when(a.created_at)} ${esc(a.kind)} → <code>${short(a.deploy_id)}</code>${a.previous_deploy_id ? ` (was <code>${short(a.previous_deploy_id)}</code>)` : ''} by <code>${esc(a.actor)}</code></li>`).join('');
    return `<p class="crumbs"><a href="/">Projects</a> › <a href="/projects/${esc(p.id)}">${esc(p.name)}</a> ›</p>
<h1>${esc(s.name)}</h1>
<p class="meta"><a href="${esc(url)}" rel="noopener">${esc(url)}</a> · <code>${esc(s.id)}</code></p>
${canDeploy ? `<h2>Upload a deploy</h2>
<p class="muted">Static files only: HTML, CSS, JavaScript, JSON, images, fonts, audio, video, PDF, WebAssembly. No build runs and nothing is executed. Hidden files (except <code>.well-known/</code>), links and server-side code are refused.</p>
${form(`/sites/${s.id}/deploys`, csrf, `<fieldset><legend>A folder</legend><input type="file" name="files" multiple webkitdirectory><input type="hidden" name="strip" value="folder"></fieldset>
<fieldset><legend>…or an archive (.tar.gz / .tar)</legend><input type="file" name="archive" accept=".tar,.tgz,.gz,application/gzip,application/x-tar"></fieldset>
<label>Deploy from subfolder (optional) <input name="root" placeholder="dist"></label>
<fieldset class="choice"><legend>When it is ready</legend>
<label class="confirm"><input type="radio" name="mode" value="activate" checked> Activate it</label>
<label class="confirm"><input type="radio" name="mode" value="ready"> Keep it ready (activate later)</label>
<label class="confirm"><input type="radio" name="mode" value="preview"> Preview only: a private address for members of this project, for one hour</label>
</fieldset>
<button type="submit">Upload</button>`, { enctype: 'multipart/form-data' })}` : ''}
<h2>Deploys</h2>
${previewId ? `<p class="notice">A preview of <code>${short(previewId)}</code> is open to members of this project at <a href="${esc(previewHref(previewId))}" target="_blank" rel="noopener">${esc(previewHref(previewId))}</a> until ${when(Number(s.preview_expires_at))}. It is never indexed, and activating or rolling back ends it.</p>` : ''}
${deploys.length ? `<table><thead><tr><th>Deploy</th><th>State</th><th>Files</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No deploys yet.</p>'}
${canDeploy && s.active_deploy_id ? form(`/sites/${s.id}/rollback`, csrf, `<input type="hidden" name="expected_active" value="${esc(s.active_deploy_id)}"><button type="submit">Roll back to the previous deploy</button>`) : ''}
${history ? `<h3>Activation history</h3><ul class="history">${history}</ul>` : ''}
<h2>Domains</h2>
<ul class="domains">${domains.map((d) => domainBlock(d.domain, d.instructions, csrf)).join('')}</ul>
${canMaintain && p.environment !== 'sandbox' ? form(`/sites/${s.id}/domains`, csrf, '<label>Custom domain <input name="hostname" required placeholder="www.example.org"></label><button type="submit">Add domain</button>') : ''}
${canMaintain ? `<h2>Per-site configuration</h2>
<p class="muted">Headers, redirects and an SPA fallback, applied to every response of this site. Platform headers (Content-Security-Policy, Strict-Transport-Security, Set-Cookie, X-Forwarded-*, caching) cannot be set here, and a redirect target must be a local path.</p>
${form(`/sites/${s.id}/config`, csrf, `<label>Headers (one per line: <code>Name: value</code>)<textarea name="headers" rows="4" spellcheck="false" placeholder="X-Frame-Options: SAMEORIGIN">${esc(siteConfig.headersText)}</textarea></label>
<label>Redirects (one per line: <code>from -&gt; to [status]</code>)<textarea name="redirects" rows="4" spellcheck="false" placeholder="/old -&gt; /new 301">${esc(siteConfig.redirectsText)}</textarea></label>
<label class="confirm"><input type="checkbox" name="spa" value="1"${siteConfig.spa ? ' checked' : ''}> Serve index.html for extensionless paths (single-page app)</label>
<button type="submit">Save configuration</button>`)}` : ''}
${canMaintain ? `<h2>Delete site</h2>${form(`/sites/${s.id}/delete`, csrf, '<button type="submit" class="danger">Delete this site</button>', { confirm: `${s.name} stops being served at once` })}` : ''}`;
}

function deploy({ deploy: d, site: s, project: p, files, log, active }) {
    const logLines = log.map((l) => `<li class="log-${esc(l.level)}"><span class="level">${esc(l.level)}</span> ${esc(l.message)}</li>`).join('');
    const fileRows = files.slice(0, 2000).map((f) => `<tr><td><code>${esc(f.path)}</code></td><td>${esc(f.content_type)}</td><td>${bytes(f.size)}</td><td><code title="${esc(f.sha256)}">${esc(f.sha256.slice(0, 12))}</code></td></tr>`).join('');
    return `<p class="crumbs"><a href="/">Projects</a> › <a href="/projects/${esc(p.id)}">${esc(p.name)}</a> › <a href="/sites/${esc(s.id)}">${esc(s.name)}</a> ›</p>
<h1>Deploy <code>${short(d.id)}</code></h1>
<p class="meta">${esc(d.state)}${active ? ' · <strong>active</strong>' : ''} · ${esc(d.file_count)} files · ${bytes(d.total_bytes)} · ${when(d.created_at)} · by <code>${esc(d.created_by)}</code>${d.manifest_sha256 ? ` · manifest <code>${esc(d.manifest_sha256.slice(0, 16))}</code>` : ''}</p>
<h2>Upload log</h2>
<ul class="log">${logLines}</ul>
${files.length ? `<h2>Files</h2><table><thead><tr><th>Path</th><th>Type</th><th>Size</th><th>sha256</th></tr></thead><tbody>${fileRows}</tbody></table>${files.length > 2000 ? `<p>…and ${files.length - 2000} more.</p>` : ''}` : ''}`;
}

function errorPage({ status, message }) {
    return `<h1>${status === 404 ? 'Not found' : status === 403 ? 'Not allowed' : status === 401 ? 'Sign in first' : 'Something went wrong'}</h1><p>${esc(message)}</p><p><a href="/">Back to your projects</a></p>`;
}

module.exports = { signedOut, home, project, site, deploy, errorPage, bytes };
