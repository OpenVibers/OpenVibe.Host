'use strict';
/**
 * Dashboard page bodies. Every value is escaped; every action is a POST form carrying the form
 * token, so the dashboard works without JavaScript.
 */
const { esc } = require('./layout');

const bytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GiB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
const when = (ms) => (ms ? `<time datetime="${new Date(ms).toISOString()}">${esc(new Date(ms).toISOString().replace('T', ' ').slice(0, 16))} UTC</time>` : '');
const short = (id) => esc(String(id || '').slice(0, 12));

function form(action, csrf, inner, { cls = '', confirm = null, enctype = null } = {}) {
    return `<form method="post" action="${esc(action)}"${cls ? ` class="${cls}"` : ''}${enctype ? ` enctype="${enctype}"` : ''}>`
        + `<input type="hidden" name="csrf" value="${esc(csrf)}">${inner}`
        + `${confirm ? `<label class="confirm"><input type="checkbox" name="confirm" value="yes" required> ${esc(confirm)}</label>` : ''}</form>`;
}

function signedOut() {
    return `<section class="intro">
<h1>OpenVibe.Host</h1>
<p>Static site hosting for OpenVibe projects. Upload a folder or a <code>.tar.gz</code> of HTML, CSS, JavaScript, images and fonts;
Host keeps every deploy as an immutable, content-addressed artifact, serves the active one at
<code>&lt;site&gt;.openvibe.host</code> (and on custom domains you verify), and lets you roll back to any earlier deploy in one step.</p>
<p><strong>Alpha.</strong> Static files only: there is no build step and no server-side code, and nothing you upload is ever executed.
Hosted bots, mods and apps (Stage C) are not available.</p>
<p><a class="button" href="/auth/login?next=%2F">Sign in with OpenVibe</a></p>
</section>`;
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

function site({ site: s, project: p, role, deploys, activations, domains, csrf, url }) {
    const canMaintain = role === 'owner' || role === 'maintainer' || role === 'staff';
    const canDeploy = role !== 'staff';
    const rows = deploys.map((d) => {
        const active = d.id === s.active_deploy_id;
        const actions = [];
        if (canDeploy && d.state === 'ready' && !active) actions.push(form(`/deploys/${d.id}/activate`, csrf, `<input type="hidden" name="expected_active" value="${esc(s.active_deploy_id || '')}"><button type="submit">Activate</button>`, { cls: 'inline' }));
        if (canMaintain && !active) actions.push(form(`/deploys/${d.id}/delete`, csrf, '<button type="submit" class="link danger">Delete</button>', { cls: 'inline' }));
        return `<tr${active ? ' class="active"' : ''}><td><a href="/deploys/${esc(d.id)}"><code>${short(d.id)}</code></a>${active ? ' <strong>active</strong>' : ''}</td><td>${esc(d.state)}${d.failure_code ? ` (<code>${esc(d.failure_code)}</code>)` : ''}</td><td>${esc(d.file_count)}</td><td>${bytes(d.total_bytes)}</td><td>${when(d.created_at)}</td><td>${actions.join(' ')}</td></tr>`;
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
<label><input type="checkbox" name="activate" value="1" checked> Activate when it is ready</label>
<button type="submit">Upload</button>`, { enctype: 'multipart/form-data' })}` : ''}
<h2>Deploys</h2>
${deploys.length ? `<table><thead><tr><th>Deploy</th><th>State</th><th>Files</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No deploys yet.</p>'}
${canDeploy && s.active_deploy_id ? form(`/sites/${s.id}/rollback`, csrf, `<input type="hidden" name="expected_active" value="${esc(s.active_deploy_id)}"><button type="submit">Roll back to the previous deploy</button>`) : ''}
${history ? `<h3>Activation history</h3><ul class="history">${history}</ul>` : ''}
<h2>Domains</h2>
<ul class="domains">${domains.map((d) => domainBlock(d.domain, d.instructions, csrf)).join('')}</ul>
${canMaintain && p.environment !== 'sandbox' ? form(`/sites/${s.id}/domains`, csrf, '<label>Custom domain <input name="hostname" required placeholder="www.example.org"></label><button type="submit">Add domain</button>') : ''}
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
