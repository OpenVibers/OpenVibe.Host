'use strict';
/** First-time service setup. The example inventory is read from this CLI install. */
const path = require('path');
const { normalise } = require('../inventory');
const { OpError, EXIT } = require('../release-ops');
const { installDirFor } = require('./self-update');
const data = require('./data');
const { parseExample, parseNames } = require('../envfile');

function refuse(message) { throw new OpError(message, EXIT.USAGE); }
function checkedUrl(raw, id) {
    const url = raw.cloneUrl || `https://github.com/OpenVibers/OpenVibe.${id[0].toUpperCase()}${id.slice(1)}.git`;
    let u;
    try { u = new URL(url); } catch { refuse(`services.${id}.cloneUrl must be a GitHub HTTPS repository URL`); }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || u.search || u.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(u.pathname)) refuse(`services.${id}.cloneUrl must be a GitHub HTTPS repository URL without credentials`);
    return u.href;
}
function baseUrl(svc, example) {
    const vhost = svc.nginx && svc.nginx.vhost;
    if (vhost && /^[a-z0-9.-]+\.conf$/i.test(vhost)) return `https://${vhost.slice(0, -5)}`;
    const match = String(example).match(/^\s*BASE_URL\s*=\s*['"]?(https:\/\/[^\s'"/]+)[^\r\n]*$/m);
    if (match) return match[1];
    refuse(`services.${svc.id} needs an nginx vhost domain or BASE_URL host in .env.example`);
}
function productionEnv(example, svc) {
    const values = { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(svc.port), BASE_URL: baseUrl(svc, example) };
    const found = new Set();
    const lines = String(example).split(/\r?\n/).map((line) => {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!m || !(m[1] in values)) return line;
        found.add(m[1]);
        return `${m[1]}=${values[m[1]]}`;
    });
    for (const [name, value] of Object.entries(values)) if (!found.has(name)) lines.push(`${name}=${value}`);
    return lines.join('\n').replace(/\n*$/, '\n');
}
const OVERRIDES = ['NODE_ENV', 'HOST', 'PORT', 'BASE_URL'];
const PROVISIONED = ['DATABASE_URL', 'DATABASE_DIRECT_URL', 'VALKEY_URL', 'VALKEY_PREFIX'];
/** Names still empty in the new env file, and the commands that finish the setup. Never values. */
function remainingSetup(id, envFile, envText, provisioned) {
    const skip = new Set([...OVERRIDES, ...(provisioned ? PROVISIONED : [])]);
    const names = parseNames(envText);
    const unset = names.filter((n) => n.empty && !skip.has(n.name)).map((n) => n.name);
    const remaining = [];
    if (names.some((n) => n.name === 'OV_OAUTH_CLIENT_SECRET' || n.name === 'OV_OAUTH_CLIENT_ID')) {
        remaining.push(`in the Network checkout: node server/setup/service-principal.js create ${id} --env-file ${envFile}   # secret never printed`);
    }
    remaining.push(`then: ovhost validate ${id}; ovhost deploy ${id} --restart`);
    return { unset, remaining };
}
async function add(ctx, id, { selfPath, dryRun = false } = {}) {
    const { exec, inv } = ctx;
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id || '')) refuse('service add needs a valid <id> (lowercase letters, digits, hyphens; max 31)');
    if (inv.file !== '/etc/openvibe/host.json') refuse('service add requires /etc/openvibe/host.json (no --inventory override)');
    const examplePath = path.join(installDirFor(selfPath).dir, 'host.example.json');
    const exampleText = await exec.readFile(examplePath);
    if (exampleText == null) refuse(`${examplePath} is missing from the ovhost install`);
    let example, current;
    try { example = JSON.parse(exampleText); } catch { refuse(`${examplePath} is not valid JSON`); }
    const currentText = await exec.readFile(inv.file, { privileged: true });
    try { current = JSON.parse(currentText); } catch { refuse(`${inv.file} is not valid JSON`); }
    if (Object.hasOwn(current.services || {}, id)) refuse(`services.${id} already exists in ${inv.file}`);
    const source = example.services && example.services[id];
    if (!source) refuse(`services.${id} is absent from ${examplePath}`);
    const { _note, ...entry } = source;
    const candidate = { ...current, services: { ...current.services, [id]: entry } };
    const svc = normalise(candidate).services[id];
    if (svc.layout !== 'git') refuse(`services.${id} uses a release layout; first setup needs a plain checkout`);
    if (!svc.envFile || !svc.port || !svc.owner) refuse(`services.${id} needs envFile, port and owner`);
    if (svc.envFile !== `/etc/openvibe/${id}.env` && entry.envFile !== `/etc/openvibe/${id}.env`) refuse(`services.${id}.envFile must be /etc/openvibe/${id}.env for data provision`);
    const url = checkedUrl(entry, id);
    const checkout = await exec.stat(svc.repo);
    if (checkout && (checkout.isSymlink || !checkout.isDir || (await exec.readdir(svc.repo) || []).length)) refuse(`${svc.repo} is not an empty directory`);
    if (await exec.stat(svc.envFile)) refuse(`${svc.envFile} already exists`);
    const inventoryStat = await exec.stat(inv.file);
    if (!inventoryStat || !inventoryStat.isFile || inventoryStat.isSymlink) refuse(`${inv.file} must be a regular file`);
    const backup = `${inv.file}.bak.${new Date(exec.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
    if (await exec.stat(backup)) refuse(`${backup} already exists`);
    if (dryRun) return { service: id, dryRun: true, plan: [`back up ${inv.file} to ${backup} and add services.${id} without _note`, `clone ${url} into ${svc.repo} as ${svc.owner}`, `create ${svc.envFile} (0600) from checkout ${svc.env.example}; set NODE_ENV, HOST, PORT, BASE_URL`, `data provision ${id} if ${svc.env.example} declares DATABASE_URL`, `list the env names still empty; when ${svc.env.example} declares OV_OAUTH_CLIENT_ID/SECRET, give the Network service-principal command; then validate and deploy`] };
    if (!(await exec.isRoot())) refuse('service add must run as root');
    const copy = await exec.run('cp', ['-p', '--', inv.file, backup], { privileged: true });
    if (copy.code !== 0) refuse(`could not back up ${inv.file}`);
    try {
        await exec.writeFile(inv.file, `${JSON.stringify(candidate, null, 2)}\n`, { privileged: true, mode: inventoryStat.mode });
        // writeFile replaces bytes in place. Restore ownership/mode if an executor used a new inode.
        const owner = await exec.run('chown', [`${inventoryStat.uid}:${inventoryStat.gid}`, inv.file], { privileged: true });
        if (owner.code !== 0) throw new Error(`could not restore ownership of ${inv.file}`);
        if (!checkout) await exec.mkdir(svc.repo, { owner: svc.owner, mode: 0o750 });
        else {
            const own = await exec.run('chown', [`${svc.owner}:${svc.owner}`, svc.repo], { privileged: true });
            if (own.code !== 0) throw new Error(`could not give ${svc.owner} the empty checkout directory`);
        }
        const cloned = await exec.run('git', ['clone', '--branch', svc.branch, '--', url, svc.repo], { as: svc.owner, timeoutMs: 600000 });
        if (cloned.code !== 0) throw new Error(`git clone failed for ${id}`);
        const envExample = await exec.readFile(path.join(svc.repo, svc.env.example));
        if (envExample == null) throw new Error(`${svc.env.example} is missing in ${svc.repo}`);
        const envText = productionEnv(envExample, svc);
        await exec.writeFile(svc.envFile, envText, { privileged: true, mode: 0o600 });
        const provisionDatabase = parseExample(envExample).declared.includes('DATABASE_URL');
        if (provisionDatabase) {
            const r = await data.provision({ ...ctx, inv: { ...inv, services: { ...inv.services, [id]: svc } } }, id, { selfPath });
            if (!r.ok) throw new Error(`data provision ${id} failed (exit ${r.code})`);
        }
        return { service: id, dryRun: false, backup, repo: svc.repo, envFile: svc.envFile, envNames: OVERRIDES, provisioned: provisionDatabase, ...remainingSetup(id, svc.envFile, envText, provisionDatabase) };
    } catch (err) {
        throw new Error(`${err.message}; setup is incomplete; inventory backup: ${backup}`);
    }
}

module.exports = { add, productionEnv };
