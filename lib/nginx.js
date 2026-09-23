'use strict';
/**
 * nginx: render a vhost from a service manifest + template, install vhosts safely, and run nginx -t.
 *
 * Installing is always transactional: write the new files, `nginx -t`, and on failure put back
 * exactly what was there before (previous content, or no file / no link) — nginx is only reloaded
 * after a clean test. Nothing under /etc is written unless the caller asked to install.
 */
const fs = require('fs');
const path = require('path');
const systemd = require('./systemd');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates', 'nginx');

function fill(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        if (!(k in vars)) throw new Error(`template variable {{${k}}} has no value`);
        return String(vars[k]);
    });
}

function readTemplate(name) {
    return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
}

/** openvibe.network for events.openvibe.network: the host's certificates are per registrable domain (wildcards). */
function defaultCertName(domain) {
    return domain.split('.').slice(-2).join('.');
}

function loadManifest(id, manifestFile) {
    if (manifestFile) return { manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')), contractsVersion: `file ${path.basename(manifestFile)}` };
    const contracts = require('openvibe-contracts');
    const version = require('openvibe-contracts/package.json').version;
    return { manifest: contracts.services.get(id) || null, contractsVersion: `v${version}` };
}

/**
 * -> { name, text } for svc. Domains come from the manifest (inventory nginx.domains overrides);
 * the port from the inventory; the variant from --variant or the inventory.
 */
function render(inv, svc, { variant, manifestFile } = {}) {
    const n = svc.nginx || {};
    const { manifest, contractsVersion } = loadManifest(svc.manifest, manifestFile);
    const domains = n.domains || (manifest && manifest.domains) || [];
    if (!domains.length) throw new Error(`no domains for ${svc.id}: the "${svc.manifest}" manifest lists none and the inventory sets no nginx.domains`);
    if (!svc.port) throw new Error(`${svc.id} has no port in the inventory`);
    const v = variant || n.variant || 'http';
    if (!['http', 'sse', 'websocket'].includes(v)) throw new Error(`unknown variant ${v} (http, sse, websocket)`);
    for (const d of domains) if (!/^[a-z0-9.-]+$/i.test(d)) throw new Error(`domain "${d}" is not a host name`);
    const zone = `ov${svc.id.replace(/[^a-z0-9]/g, '')}`;
    const primary = domains[0];
    const base = { port: svc.port, zone };
    let locations = '';
    let httpContext = '';
    if (v === 'sse') {
        const paths = n.ssePaths || ['/realtime/stream'];
        locations = paths.map((p) => fill(readTemplate('location-sse.tmpl'), { ...base, path: safePath(p) })).join('');
    } else if (v === 'websocket') {
        const paths = n.wsPaths || ['/ws/'];
        httpContext = `\n${fill(readTemplate('http-websocket.tmpl'), base)}`;
        locations = paths.map((p) => fill(readTemplate('location-websocket.tmpl'), { ...base, path: safePath(p) })).join('');
    }
    const name = n.vhost || `${primary}.conf`;
    const text = fill(readTemplate('vhost.conf.tmpl'), {
        ...base,
        primary,
        service: svc.id,
        manifestId: svc.manifest,
        contractsVersion,
        variant: v,
        vhost: name,
        sitesAvailable: inv.nginx.sitesAvailable,
        serverNames: domains.join(' '),
        certName: n.certName || defaultCertName(primary),
        maxBody: n.maxBody || '2m',
        locations,
        httpContext,
    });
    return { name, text };
}

function safePath(p) {
    if (!/^\/[A-Za-z0-9/._-]*$/.test(p)) throw new Error(`location path "${p}" is not a plain path`);
    return p;
}

async function test(exec, inv) {
    const r = await exec.run(inv.nginx.bin, ['-t'], { privileged: true });
    return { ok: r.code === 0, output: `${r.stderr}${r.stdout}`.trim() };
}

/**
 * files: [{ name, text }]. Writes changed files to sites-available, links them into sites-enabled,
 * runs nginx -t; restores the previous state on failure; reloads nginx on success.
 * remove: vhost file names to take out of sites-enabled and sites-available IN THE SAME CHANGE (an
 * interim vhost the new one replaces); they come back too if nginx -t fails.
 * -> { changed: [names], removed: [names], reloaded }
 */
async function install(exec, inv, files, { log = () => {}, remove = [] } = {}) {
    const undo = [];
    const changed = [];
    const removed = [];
    for (const name of remove) {
        if (!/^[A-Za-z0-9._-]+$/.test(name) || files.some((f) => f.name === name)) throw new Error(`cannot remove vhost "${name}"`);
        const available = path.join(inv.nginx.sitesAvailable, name);
        const enabled = path.join(inv.nginx.sitesEnabled, name);
        const prevText = await exec.readFile(available, { privileged: true });
        // Usually a link to sites-available (possibly dangling); a plain copy is put back as a copy.
        const target = await exec.readlink(enabled);
        const link = target || await exec.stat(enabled);
        if (link) {
            const copy = target ? null : await exec.readFile(enabled, { privileged: true });
            await exec.removeFile(enabled, { privileged: true });
            undo.push(target ? () => exec.symlink(target, enabled, { privileged: true }) : () => exec.writeFile(enabled, copy == null ? '' : copy, { privileged: true, mode: 0o644 }));
        }
        if (prevText != null) {
            await exec.removeFile(available, { privileged: true });
            undo.push(() => exec.writeFile(available, prevText, { privileged: true, mode: 0o644 }));
        }
        if (link || prevText != null) removed.push(name);
    }
    for (const f of files) {
        if (!/^[A-Za-z0-9._-]+$/.test(f.name)) throw new Error(`vhost name "${f.name}" is not a file name`);
        const available = path.join(inv.nginx.sitesAvailable, f.name);
        const enabled = path.join(inv.nginx.sitesEnabled, f.name);
        const prev = await exec.readFile(available, { privileged: true });
        if (prev !== f.text) {
            undo.push(prev == null ? () => exec.removeFile(available, { privileged: true }) : () => exec.writeFile(available, prev, { privileged: true, mode: 0o644 }));
            await exec.writeFile(available, f.text, { privileged: true, mode: 0o644 });
            changed.push(f.name);
        }
        if (!(await exec.stat(enabled))) {
            await exec.symlink(available, enabled, { privileged: true });
            undo.push(() => exec.removeFile(enabled, { privileged: true }));
            if (!changed.includes(f.name)) changed.push(f.name);
        }
    }
    if (!changed.length && !removed.length) return { changed, removed, reloaded: false };
    const t = await test(exec, inv);
    if (!t.ok) {
        for (const u of undo.reverse()) await u();
        const err = new Error(`nginx -t failed; the previous vhost files were restored:\n${t.output}`);
        err.nginxOutput = t.output;
        throw err;
    }
    await systemd.reloadNginx(exec);
    log(`nginx: ${[changed.length && `installed ${changed.join(', ')}`, removed.length && `removed ${removed.join(', ')}`].filter(Boolean).join('; ')}; nginx -t clean; reloaded`);
    return { changed, removed, reloaded: true };
}

// ── Stage B: tenant static hosting (OpenVibe.Host's own service) ─────────────

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$`);
const VERIFIED_SQL = "SELECT hostname FROM host_domains WHERE kind = 'custom' AND status = 'verified' ORDER BY hostname";

function isHostname(h) {
    return typeof h === 'string' && h.length <= 253 && HOSTNAME_RE.test(h);
}

/** A certificate directory from a --wildcard-cert value: a Let's Encrypt name or an absolute directory. */
function certDirFor(value, base = '/etc/letsencrypt/live') {
    const v = String(value || '').replace(/\/+$/, '');
    if (!v) throw new Error('empty certificate path');
    if (path.isAbsolute(v)) {
        if (!/^\/[A-Za-z0-9/._-]+$/.test(v) || v.split('/').includes('..')) throw new Error(`certificate directory "${v}" is not a plain absolute path`);
        return /\.pem$/.test(v) ? path.dirname(v) : v;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(v) || v === '..' || v === '.') throw new Error(`certificate name "${v}" is not a plain name`);
    return path.join(base, v);
}

/** The inventory's nginx.tenants block with defaults. */
function tenantsConfig(svc) {
    const t = (svc.nginx && svc.nginx.tenants) || null;
    if (!t) throw new Error(`${svc.id} has no nginx.tenants block in the inventory (it is not a tenant-hosting service)`);
    const sitesDomain = String(t.sitesDomain || 'openvibe.host').toLowerCase();
    const dashboard = String(t.dashboardDomain || sitesDomain).toLowerCase();
    for (const d of [sitesDomain, dashboard]) if (!isHostname(d)) throw new Error(`"${d}" is not a host name`);
    if (/(^|\.)openvibe\.(network|live|media|community|tools)$/.test(sitesDomain)) throw new Error(`tenant sites must not live under ${sitesDomain}: its cookies would reach tenant pages`);
    if (!svc.port) throw new Error(`${svc.id} has no port in the inventory`);
    if (t.maxUpload && !/^\d+[km]?$/.test(String(t.maxUpload))) throw new Error('nginx.tenants.maxUpload must look like 110m');
    // The interim vhost that answered *.<sitesDomain> with a 404 before launch (deploy/nginx in this
    // repo). It sorts before <sitesDomain>.conf, so left in place it would keep winning the wildcard.
    const replaces = t.replaces || [`${sitesDomain}-tenants-pending.conf`];
    if (!Array.isArray(replaces) || replaces.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9._-]+\.conf$/.test(n))) throw new Error('nginx.tenants.replaces must list vhost file names');
    return {
        sitesDomain,
        dashboard,
        wildcardCert: t.wildcardCert || sitesDomain,
        certBase: t.certBase || '/etc/letsencrypt/live',
        database: t.database || null,
        vhost: t.vhost || `${sitesDomain}.conf`,
        customVhost: t.customVhost || `${sitesDomain}-custom-domains.conf`,
        maxUpload: t.maxUpload || '110m',
        replaces,
    };
}

/**
 * The wildcard vhost (dashboard + *.sitesDomain) and the custom-domain vhost.
 * domains: [{ hostname, hasCert }] (verified custom domains). -> { files: [{ name, text }], needCert: [hostname], refused: [value] }
 */
function renderTenants(inv, svc, { wildcardCert, domains = [] } = {}) {
    const t = tenantsConfig(svc);
    const certDir = certDirFor(wildcardCert || t.wildcardCert, t.certBase);
    const zone = `ov${svc.id.replace(/[^a-z0-9]/g, '')}`;
    const base = { port: svc.port, zone, sitesDomain: t.sitesDomain, service: svc.id };
    const tenantLocation = fill(readTemplate('tenant-location.tmpl'), base);
    // www.<dashboard> would otherwise be a tenant name (reserved, so "unknown host"): redirect it,
    // as the placeholder did. Only when the wildcard certificate covers it.
    const www = `www.${t.dashboard}`;
    const wwwRedirect = www.endsWith(`.${t.sitesDomain}`) && www.split('.').length === t.sitesDomain.split('.').length + 1
        ? fill(readTemplate('www-redirect.tmpl'), { www, dashboard: t.dashboard, certDir }) : '';
    const main = fill(readTemplate('tenants.conf.tmpl'), {
        ...base, dashboard: t.dashboard, certDir, maxUpload: t.maxUpload, sitesAvailable: inv.nginx.sitesAvailable, vhost: t.vhost, tenantLocation, wwwRedirect,
    });

    const refused = [];
    const ok = [];
    const seen = new Set();
    for (const d of domains) {
        const h = String(d.hostname || '').toLowerCase();
        // Values come from a database tenants write to: anything that is not a plain host name, or
        // that falls under the sites domain / dashboard, is refused before it can reach nginx config.
        if (!isHostname(h) || h === t.dashboard || h.endsWith(`.${t.sitesDomain}`) || h === t.sitesDomain || seen.has(h)) { refused.push(String(d.hostname)); continue; }
        seen.add(h);
        ok.push({ hostname: h, hasCert: !!d.hasCert });
    }
    const withCert = ok.filter((d) => d.hasCert);
    const withoutCert = ok.filter((d) => !d.hasCert);
    let servers = '';
    if (withCert.length) servers += fill(readTemplate('custom-http.tmpl'), { names: withCert.map((d) => d.hostname).join(' '), fallback: 'return 301 https://$host$request_uri;' });
    if (withoutCert.length) servers += fill(readTemplate('custom-http.tmpl'), { names: withoutCert.map((d) => d.hostname).join(' '), fallback: 'return 404;' });
    for (const d of withCert) servers += fill(readTemplate('custom-https.tmpl'), { ...base, hostname: d.hostname, certDir: path.join(t.certBase, d.hostname), tenantLocation });
    const custom = fill(readTemplate('custom-domains.conf.tmpl'), {
        service: svc.id, database: t.database || '(the Host database)', withCert: withCert.length, withoutCert: withoutCert.length,
        servers: servers || '\n# No verified custom domains yet.\n',
    });
    return {
        files: [{ name: t.vhost, text: main }, { name: t.customVhost, text: custom }],
        needCert: withoutCert.map((d) => d.hostname),
        refused,
        certDir,
        replaces: t.replaces,
    };
}

/** Verified custom domains from the Host database (read-only, as the service user) + certificate presence. */
async function tenantDomains(exec, svc) {
    const t = tenantsConfig(svc);
    if (!t.database) throw new Error(`${svc.id}: nginx.tenants.database is not set in the inventory`);
    const rows = await exec.sqlite(t.database, VERIFIED_SQL, { as: svc.runAs });
    const out = [];
    for (const r of rows || []) {
        const h = String(r.hostname || '').toLowerCase();
        const hasCert = isHostname(h) ? Boolean(await exec.stat(path.join(t.certBase, h, 'fullchain.pem'))) : false;
        out.push({ hostname: r.hostname, hasCert });
    }
    return out;
}

module.exports = { render, test, install, defaultCertName, fill, renderTenants, tenantDomains, tenantsConfig, certDirFor, VERIFIED_SQL };
