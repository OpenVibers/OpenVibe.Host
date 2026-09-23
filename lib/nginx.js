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
 * -> { changed: [names], reloaded }
 */
async function install(exec, inv, files, { log = () => {} } = {}) {
    const undo = [];
    const changed = [];
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
    if (!changed.length) return { changed, reloaded: false };
    const t = await test(exec, inv);
    if (!t.ok) {
        for (const u of undo.reverse()) await u();
        const err = new Error(`nginx -t failed; the previous vhost files were restored:\n${t.output}`);
        err.nginxOutput = t.output;
        throw err;
    }
    await systemd.reloadNginx(exec);
    log(`nginx: installed ${changed.join(', ')}; nginx -t clean; reloaded`);
    return { changed, reloaded: true };
}

module.exports = { render, test, install, defaultCertName, fill };
