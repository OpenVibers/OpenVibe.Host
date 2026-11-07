'use strict';
/**
 * OpenVibe.Mail in the host inventory: the Node API on 5250, Stalwart as an auxiliary unit that a
 * normal Mail deploy never restarts, and the message blobs archived with the database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createFakeHost } = require('./fake-host');
const { main } = require('../lib/cli');
const { normalise } = require('../lib/inventory');

const STATE = '/var/lib/openvibe-host';

const MAIL_FILES = {
    'package.json': JSON.stringify({ name: 'openvibe-mail', version: '0.1.0', dependencies: { express: '^4.21.2' } }, null, 2),
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'server/index.js': 'console.log(1);',
    '.env.example': 'DATABASE_URL=\nDATABASE_DIRECT_URL=\n',
    'deploy/systemd/openvibe-mail.service': '[Service]\nExecStart=/usr/bin/node server/index.js\nTimeoutStopSec=20\n',
    'deploy/systemd/openvibe-stalwart.service': '[Service]\nExecStart=/opt/openvibe.stalwart/stalwart --config /etc/openvibe/stalwart/config.json\n',
    'deploy/systemd/openvibe-stalwart.slice': '[Slice]\nMemoryMax=1G\n',
    'deploy/stalwart/config.toml': '# Stalwart configuration\n',
    'deploy/nginx/openvibe.email.conf': 'server { listen 443; }\n',
};

function mailHost() {
    const host = createFakeHost();
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.example.json'), 'utf8'));
    const doc = {
        host: 'fake-host',
        stateDir: STATE,
        backupDir: '/var/backups/openvibe',
        defaults: { owner: 'ubuntu', branch: 'main' },
        services: { mail: example.services.mail },
    };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.inv = normalise(doc);
    const svc = host.inv.services.mail;
    for (const db of svc.databases) host.pgDatabases.add(db.database);
    host.pgBackups = [{ type: 'diff', timestamp: { stop: Math.floor(host.exec.now() / 1000) - 3600 } }];
    host.ensureDir('/etc/nginx/sites-available');
    host.ensureDir('/etc/nginx/sites-enabled');
    host.badShas = new Set();
    host.cli = async (...argv) => {
        const lines = [];
        const code = await main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {} });
        return { code, out: lines.join('\n') };
    };

    const repo = host.createRepo(svc.repo, { owner: 'ubuntu' });
    const sha = repo.commit(MAIL_FILES, { message: 'initial' });
    repo.publish(sha);
    repo.checkout(sha);
    for (const dep of Object.keys(JSON.parse(MAIL_FILES['package.json']).dependencies)) {
        host.put(path.join(svc.repo, 'node_modules', dep, 'package.json'), JSON.stringify({ name: dep }), { owner: 'ubuntu' });
    }
    for (const u of [...svc.units, ...svc.auxiliaryUnits.map((a) => a.unit)]) host.addUnit(u);
    for (const [unit, src] of Object.entries(svc.unitSources)) host.put(path.join('/etc/systemd/system', unit), MAIL_FILES[src]);
    host.put(svc.envFile, svc.env.required.map((n) => `${n}=test`).join('\n'), { mode: 0o600 });
    host.http.set(svc.ready.url, () => ({ status: 200, body: { status: 'ok' } }));
    host.push = (changes, message = 'change') => { const s = repo.commit(changes, { message }); repo.publish(s); return s; };
    return host;
}

function lastRecord(host, id) {
    const lines = host.read(`${STATE}/backups/${id}.jsonl`).trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
}

(async () => {
    let failed = 0;
    const atest = async (name, fn) => {
        try { await fn(); console.log(`  ✓ ${name}`); } catch (err) { failed += 1; console.log(`  ✗ ${name}\n${err.stack || err}`); }
    };

    await atest('plan names the Mail unit, Stalwart auxiliary unit, env, database and vhost', async () => {
        const host = mailHost();
        host.push({ 'server/index.js': 'console.log(2);' }, 'server change');
        const r = await host.cli('plan', 'mail');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /^  repo\s+\/opt\/openvibe\.mail$/m);
        assert.match(r.out, /^  env\s+\/etc\/openvibe\/mail\.env$/m);
        assert.match(r.out, /^  databases\s+ov_mail$/m);
        assert.match(r.out, /^  restart\s+yes: openvibe-mail\.service$/m);
        assert.match(r.out, /^  auxiliary\s+openvibe-stalwart\.service \(installed with the service; not restarted unless its config changes\)$/m);
        assert.match(r.out, /^  nginx\s+openvibe\.email\.conf from deploy\/nginx\/openvibe\.email\.conf installed \(nginx -t, reload\) on deploy$/m);
        assert.doesNotMatch(r.out, /^  restart\s+yes:.*openvibe-stalwart/m);
    });

    await atest('a Mail code deploy restarts openvibe-mail.service and never Stalwart', async () => {
        const host = mailHost();
        host.push({ 'server/index.js': 'console.log(2);' }, 'server change');
        const r = await host.cli('deploy', 'mail');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.restarts(), ['openvibe-mail.service']);
        assert.strictEqual(host.units.get('openvibe-stalwart.service').restarts, 0);
        assert.ok(host.read('/etc/nginx/sites-available/openvibe.email.conf'), 'the repo vhost was installed');
        assert.ok(host.files.has('/etc/nginx/sites-enabled/openvibe.email.conf'), 'the vhost was linked into sites-enabled');
    });

    await atest('a Stalwart config change restarts only the auxiliary unit', async () => {
        const host = mailHost();
        host.push({ 'deploy/stalwart/config.toml': '# Stalwart configuration, changed\n' }, 'mail server change');
        const r = await host.cli('deploy', 'mail');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.restarts(), ['openvibe-stalwart.service']);
        assert.strictEqual(host.units.get('openvibe-mail.service').restarts, 0);
        assert.match(r.out, /restarting auxiliary openvibe-stalwart\.service/);
        const [rec] = (host.read(`${STATE}/releases/mail.jsonl`) || '').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual(rec.auxRestarted, ['openvibe-stalwart.service']);
        assert.strictEqual(rec.restarted, false);
    });

    await atest('a docs-only change restarts nothing', async () => {
        const host = mailHost();
        host.push({ 'docs/INSTALL.md': 'changed\n' }, 'docs change');
        const r = await host.cli('deploy', 'mail');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(host.restarts(), []);
    });

    await atest('backup archives ov_mail and the Stalwart blob directory together', async () => {
        const host = mailHost();
        host.put('/var/lib/openvibe-stalwart/blobs/aa/bb/0123456789abcdef', 'compressed message bytes', { owner: 'openvibe', mode: 0o600 });
        const r = await host.cli('backup', 'mail', '--logical');
        assert.strictEqual(r.code, 0, r.out);
        const rec = lastRecord(host, 'mail');
        assert.strictEqual(rec.ok, true);
        assert.strictEqual(host.dumps[0].database, 'ov_mail');
        const names = rec.files.map((f) => f.file).sort();
        assert.deepStrictEqual(names, ['mail.dump', 'stalwart-blobs.tar.gz']);
        assert.ok(host.files.has(`${rec.dir}/stalwart-blobs.tar.gz`));
    });

    await atest('a non-content-addressed object store must say verify:false', () => {
        const host = mailHost();
        assert.strictEqual(normalise({ services: { mail: host.inv.services.mail } }).services.mail.objects[0].verify, false);
        assert.throws(() => normalise({ services: { x: { repo: '/opt/x', owner: 'ubuntu', objects: [{ name: 'b', path: '/var/lib/b', verify: 'yes' }] } } }), /verify must be true or false/);
    });

    if (failed) { console.error(`${failed} failed`); process.exit(1); }
    console.log('all mail inventory tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
