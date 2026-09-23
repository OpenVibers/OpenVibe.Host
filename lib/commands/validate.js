'use strict';
/**
 * ovhost validate <service>: is the host set up the way the inventory says?
 *
 *   env      the env file exists, is not world-readable, and every required NAME is present and
 *            non-empty (names from the unit's Environment= lines count as present). Values are
 *            never read into the result — only { name, empty }.
 *   units    every unit is loaded from a unit file; the socket unit is active; repo unit files that
 *            differ from the installed ones are reported.
 *   port     free (service down) or held by the service / its socket — nothing else.
 *   nginx    the vhost is in sites-available and linked in sites-enabled; `nginx -t` is clean.
 *   checkout owned by the declared owner, on the declared branch, no tracked changes.
 *   deps     every dependency resolves (the Tools rule).
 *
 * Every finding is { level: error|warn|ok|info, area, message }. Exit 2 if any error.
 */
const path = require('path');
const { service } = require('../inventory');
const envfile = require('../envfile');
const systemd = require('../systemd');
const nginx = require('../nginx');
const deps = require('../deps');
const { git } = require('../git');

async function validate(ctx, id) {
    const { exec, inv } = ctx;
    const svc = service(inv, id);
    const findings = [];
    const add = (level, area, message) => findings.push({ level, area, message });

    // ── checkout ──
    const repoStat = await exec.stat(svc.repo);
    if (!repoStat || !repoStat.isDir) add('error', 'checkout', `${svc.repo} does not exist`);
    else {
        if (repoStat.owner !== svc.owner) add('error', 'checkout', `${svc.repo} is owned by ${repoStat.owner}, expected ${svc.owner}`);
        else add('ok', 'checkout', `${svc.repo} owned by ${svc.owner}`);
        try {
            const g = git(exec, svc);
            const [branch, head, dirty] = [await g.branch(), await g.head(), await g.dirty()];
            if (branch !== svc.branch) add('error', 'checkout', `on branch "${branch}", expected "${svc.branch}"`);
            add(dirty.length ? 'error' : 'ok', 'checkout', dirty.length ? `tracked local changes: ${dirty.slice(0, 8).join(', ')}` : `clean at ${head.slice(0, 12)}`);
        } catch (err) {
            add('error', 'checkout', err.message);
        }
    }

    // ── env ──
    let unitEnvNames = [];
    for (const u of svc.units) {
        const st = await systemd.show(exec, u);
        if (st.fragmentPath) unitEnvNames = unitEnvNames.concat(envfile.unitEnvironmentNames(await exec.readFile(st.fragmentPath, { privileged: true })));
        for (const d of st.dropIns) unitEnvNames = unitEnvNames.concat(envfile.unitEnvironmentNames(await exec.readFile(d, { privileged: true })));
    }
    if (svc.envFile) {
        const st = await exec.stat(svc.envFile);
        if (!st) add('error', 'env', `${svc.envFile} does not exist`);
        else {
            if (st.mode & 0o004) add('error', 'env', `${svc.envFile} is world-readable (mode ${(st.mode & 0o777).toString(8)}); chmod 600`);
            else if (st.mode & 0o040) add('warn', 'env', `${svc.envFile} is group-readable (mode ${(st.mode & 0o777).toString(8)})`);
            else add('ok', 'env', `${svc.envFile} mode ${(st.mode & 0o777).toString(8)}`);
            if (st.mode & 0o002) add('error', 'env', `${svc.envFile} is world-writable`);
            const present = new Map(envfile.parseNames(await exec.readFile(svc.envFile, { privileged: true })).map((e) => [e.name, e]));
            for (const n of unitEnvNames) if (!present.has(n)) present.set(n, { name: n, empty: false, fromUnit: true });
            const example = await exec.readFile(path.join(svc.repo, svc.env.example));
            const exampleNames = example ? envfile.parseExample(example).declared : [];
            let required = svc.env.required;
            if (required === 'from-example') {
                required = exampleNames;
                if (!example) add('warn', 'env', `${svc.env.example} not found in the checkout; no required names`);
            }
            if (!required.length) add('info', 'env', 'no required names declared (env.required)');
            const missing = required.filter((n) => !present.has(n));
            const empty = required.filter((n) => present.has(n) && present.get(n).empty);
            if (missing.length) add('error', 'env', `missing: ${missing.join(', ')}`);
            if (empty.length) add('error', 'env', `empty: ${empty.join(', ')}`);
            if (required.length && !missing.length && !empty.length) add('ok', 'env', `${required.length} required name(s) present and non-empty`);
            const notSet = exampleNames.filter((n) => !present.has(n) && !required.includes(n));
            if (notSet.length) add('info', 'env', `in ${svc.env.example} but not set (optional unless declared required): ${notSet.join(', ')}`);
        }
    } else add('info', 'env', 'no env file declared');

    // ── units ──
    const pids = new Set();
    for (const u of svc.units) {
        const st = await systemd.show(exec, u);
        if (st.load !== 'loaded' || !st.fragmentPath) add('error', 'units', `${u} is not loaded (${st.load})`);
        else add(st.active === 'active' ? 'ok' : 'warn', 'units', `${u} ${st.active}/${st.sub} from ${st.fragmentPath}`);
        if (st.mainPid) pids.add(st.mainPid);
    }
    if (svc.socketUnit) {
        const st = await systemd.show(exec, svc.socketUnit);
        if (st.load !== 'loaded') add('error', 'units', `${svc.socketUnit} is not loaded (${st.load})`);
        else add(st.active === 'active' ? 'ok' : 'error', 'units', `${svc.socketUnit} ${st.active}/${st.sub}${st.active === 'active' ? '' : ' — without it a restart refuses connections'}`);
        if (st.partOf.some((u) => svc.units.includes(u))) {
            add('warn', 'units', `${svc.socketUnit} has PartOf=${st.partOf.join(' ')}: systemd propagates a restart of that service to the socket (ovhost itself never stops or restarts it)`);
        }
    }
    for (const [unit, src] of Object.entries(svc.unitSources)) {
        const want = await exec.readFile(path.join(svc.repo, src));
        if (want == null) { add('warn', 'units', `unit source ${src} not in the checkout`); continue; }
        const have = await exec.readFile(path.join('/etc/systemd/system', unit), { privileged: true });
        if (have !== want) add('warn', 'units', `${unit} differs from ${src} (deploy --install-units installs it)`);
    }

    // ── port ──
    if (svc.port) {
        try {
            const holders = await exec.listeners(svc.port);
            if (!holders.length) {
                const anyActive = [...pids].length > 0;
                add(anyActive ? 'error' : 'ok', 'port', anyActive ? `${svc.port} has no listener although ${svc.units.join(', ')} is running` : `${svc.port} is free`);
            } else {
                const foreign = holders.filter((h) => !(h.pid && pids.has(h.pid)) && !(svc.socketUnit && h.pid === 1));
                if (foreign.length) add('error', 'port', `${svc.port} is held by ${foreign.map((h) => `${h.process || '?'}(${h.pid || '?'})`).join(', ')}, not by ${svc.units.join(', ') || svc.id}`);
                else add('ok', 'port', `${svc.port} held by ${holders.map((h) => (h.pid === 1 ? `systemd (${svc.socketUnit})` : `${h.process}(${h.pid})`)).join(', ')}`);
            }
        } catch (err) {
            add('warn', 'port', `could not list listeners: ${err.message}`);
        }
    }

    // ── nginx ──
    if (svc.nginx && svc.nginx.vhost) {
        const available = path.join(inv.nginx.sitesAvailable, svc.nginx.vhost);
        const enabled = path.join(inv.nginx.sitesEnabled, svc.nginx.vhost);
        const a = await exec.stat(available);
        const e = await exec.stat(enabled);
        add(a ? 'ok' : 'error', 'nginx', a ? `${available} present` : `${available} missing`);
        add(e ? 'ok' : 'error', 'nginx', e ? `${enabled} enabled` : `${enabled} missing (not enabled)`);
        if (a && svc.nginx.repoVhost) {
            const repoText = await exec.readFile(path.join(svc.repo, svc.nginx.repoVhost));
            const live = await exec.readFile(available, { privileged: true });
            if (repoText != null && repoText !== live) add('warn', 'nginx', `${svc.nginx.vhost} differs from ${svc.nginx.repoVhost} in the checkout`);
        }
    }
    if (svc.nginx) {
        const t = await nginx.test(exec, inv);
        add(t.ok ? 'ok' : 'error', 'nginx', t.ok ? 'nginx -t clean' : `nginx -t failed: ${t.output.split('\n').slice(-3).join(' / ')}`);
    }

    // ── deps ──
    if (repoStat && repoStat.isDir && svc.managed) {
        const pkgDirs = await deps.expandPackages(exec, svc);
        const problems = await deps.verify(exec, svc, pkgDirs);
        if (problems.length) for (const p of problems) add('error', 'deps', `${p.pkg}: ${p.dep} — ${p.reason}`);
        else add('ok', 'deps', `every dependency resolves (${pkgDirs.join(', ') || 'no packages'})`);
    }

    const errors = findings.filter((f) => f.level === 'error').length;
    return { service: id, ok: errors === 0, errors, warnings: findings.filter((f) => f.level === 'warn').length, findings };
}

/** Names declared in the checkout's .env.example — to help write env.required. Names only. */
async function envNames(ctx, id) {
    const svc = service(ctx.inv, id);
    const text = await ctx.exec.readFile(path.join(svc.repo, svc.env.example));
    if (text == null) return { service: id, file: path.join(svc.repo, svc.env.example), found: false, declared: [], commented: [] };
    return { service: id, file: path.join(svc.repo, svc.env.example), found: true, ...envfile.parseExample(text) };
}

module.exports = { validate, envNames };
