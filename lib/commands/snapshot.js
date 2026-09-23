'use strict';
/**
 * ovhost snapshot <service>: the service's configuration as a .tar.gz WITHOUT secret values —
 *
 *   snapshot.json            sha, branch, remote (credentials stripped), inventory entry, service
 *                            manifest, env file mode + variable NAMES, unit paths, lockfile hashes
 *   units/<unit>             installed unit files and drop-ins; Environment= values whose name looks
 *                            secret (KEY, TOKEN, SECRET, PASSWORD, …) are replaced by <redacted>
 *   nginx/<vhost>            the installed vhost
 *   env/<file>.names         the env file's variable names, one per line — never values
 *
 * Written to <stateDir>/snapshots/<service>-<stamp>-<sha>.tar.gz (or --out), mode 0640.
 */
const path = require('path');
const crypto = require('crypto');
const { service } = require('../inventory');
const envfile = require('../envfile');
const systemd = require('../systemd');
const deps = require('../deps');
const { git } = require('../git');
const { createTarGz } = require('../tar');
const { stamp } = require('./backup');

/** Inventory entries may carry request headers for probes; keep the names, drop the values. */
function withoutHeaderValues(svc) {
    const copy = JSON.parse(JSON.stringify(svc));
    for (const k of ['ready', 'protected']) {
        if (copy[k] && copy[k].headers) copy[k].headers = Object.fromEntries(Object.keys(copy[k].headers).map((h) => [h, '<redacted>']));
    }
    return copy;
}

async function snapshot(ctx, id, { out } = {}) {
    const { exec, inv } = ctx;
    const svc = service(inv, id);
    const files = [];
    const meta = { service: id, takenAt: new Date(exec.now()).toISOString(), host: await exec.hostname(), inventory: withoutHeaderValues(svc) };

    const g = git(exec, svc);
    try {
        meta.sha = await g.head();
        meta.branch = await g.branch();
        meta.remote = await g.remoteUrl();
    } catch (err) { meta.gitError = err.message.split('\n')[0]; }

    try {
        const contracts = require('openvibe-contracts');
        meta.manifest = contracts.services.get(svc.manifest) || null;
        meta.contractsVersion = require('openvibe-contracts/package.json').version;
    } catch { meta.manifest = null; }

    if (svc.envFile) {
        const st = await exec.stat(svc.envFile);
        const text = st ? await exec.readFile(svc.envFile, { privileged: true }) : null;
        const names = text == null ? [] : envfile.parseNames(text);
        meta.env = { file: svc.envFile, exists: !!st, mode: st ? (st.mode & 0o777).toString(8) : null, names: names.map((n) => n.name), empty: names.filter((n) => n.empty).map((n) => n.name) };
        files.push({ name: `env/${path.basename(svc.envFile)}.names`, content: `${names.map((n) => n.name).join('\n')}\n` });
    }

    meta.units = [];
    for (const u of [...svc.units, ...(svc.socketUnit ? [svc.socketUnit] : [])]) {
        const st = await systemd.show(exec, u);
        meta.units.push({ unit: u, fragmentPath: st.fragmentPath, dropIns: st.dropIns, active: st.active });
        if (st.fragmentPath) {
            const text = await exec.readFile(st.fragmentPath, { privileged: true });
            if (text != null) files.push({ name: `units/${u}`, content: envfile.redactUnit(text) });
        }
        for (const d of st.dropIns) {
            const text = await exec.readFile(d, { privileged: true });
            if (text != null) files.push({ name: `units/${u}.d/${path.basename(d)}`, content: envfile.redactUnit(text) });
        }
    }

    if (svc.nginx && svc.nginx.vhost) {
        const text = await exec.readFile(path.join(inv.nginx.sitesAvailable, svc.nginx.vhost), { privileged: true });
        if (text != null) files.push({ name: `nginx/${svc.nginx.vhost}`, content: text });
        meta.vhost = { name: svc.nginx.vhost, present: text != null };
    }

    meta.lockfiles = {};
    for (const pkg of await deps.expandPackages(exec, svc)) {
        const lockText = await exec.readFile(path.join(svc.repo, pkg, 'package-lock.json'));
        if (lockText != null) meta.lockfiles[pkg] = crypto.createHash('sha256').update(lockText).digest('hex');
    }

    files.unshift({ name: 'snapshot.json', content: `${JSON.stringify(meta, null, 2)}\n` });
    const dest = out || path.join(inv.stateDir, 'snapshots', `${id}-${stamp(exec.now())}-${(meta.sha || 'nosha').slice(0, 12)}.tar.gz`);
    await exec.mkdir(path.dirname(dest), { mode: 0o750 });
    await exec.writeFile(dest, createTarGz(files, exec.now()), { mode: 0o640 });
    return { service: id, file: dest, entries: files.map((f) => f.name), sha: meta.sha || null };
}

module.exports = { snapshot };
