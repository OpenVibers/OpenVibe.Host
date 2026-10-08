'use strict';
/**
 * `ovhost data provision|switch`: the data role's scripts (roles/data/add-service.sh,
 * switch-service.sh) run from the ovhost install, driven against the fake host. The scripts are
 * stubbed at their install path: nothing here touches PostgreSQL, Valkey, systemd or a real
 * database, and every invocation is recorded so the tests assert the argv, the env and the exit code.
 */
const assert = require('assert');
const path = require('path');
const { scenario, test, runTests } = require('./helpers');
const { main } = require('../lib/cli');
const { redact } = require('../lib/commands/data');

const DIR = '/opt/ovhost-install';
const SELF = `${DIR}/bin/ovhost`;

function cli(host, ...argv) {
    const lines = [];
    return main(argv, { exec: host.exec, out: (s) => lines.push(s), env: {}, selfPath: SELF })
        .then((code) => ({ code, out: lines.join('\n') }));
}

/** Install both scripts at the install path and record every run of them. */
function installScripts(host, { stdout = '', stderr = '', code = 0 } = {}) {
    for (const f of ['add-service.sh', 'switch-service.sh']) host.put(`${DIR}/roles/data/${f}`, '#!/usr/bin/env bash\n', { mode: 0o755, owner: 'root' });
    const runs = [];
    const orig = host.exec.run;
    host.exec.run = async (cmd, args, opts = {}) => {
        if (cmd.startsWith(`${DIR}/roles/data/`)) {
            runs.push({ script: cmd, args, env: opts.env || {}, as: opts.as || null, privileged: !!opts.privileged });
            return { code, stdout, stderr };
        }
        return orig(cmd, args, opts);
    };
    host.scriptRuns = runs;
    return runs;
}

runTests([
    test('redact removes connection URLs and password values, and nothing else', () => {
        assert.strictEqual(redact('DATABASE_URL=postgresql://ov_live_app:pw@127.0.0.1:6432/ov_live'), 'DATABASE_URL=<redacted-url>');
        assert.strictEqual(redact('VALKEY_URL=valkey://u:p@127.0.0.1:6379/0'), 'VALKEY_URL=<redacted-url>');
        assert.strictEqual(redact('a redis://u:p@h/0 b postgres://x'), 'a <redacted-url> b <redacted-url>');
        assert.strictEqual(redact('PG_LIVE_OWNER_PASSWORD=abc123'), 'PG_LIVE_OWNER_PASSWORD=<redacted>');
        assert.match(redact('[data] live: database ov_live (owner ov_live), Valkey user ov_svc_live on ov:live:*'), /database ov_live/);
    }),

    test('provision runs add-service.sh from the install and prints its output, redacted', async () => {
        const host = scenario();
        const runs = installScripts(host, { stdout: '[data] live: database ov_live (owner ov_live, runtime ov_live_app via PgBouncer), Valkey user ov_svc_live on ov:live:*; DATABASE_URL, DATABASE_DIRECT_URL, VALKEY_URL, VALKEY_PREFIX set in /etc/openvibe/live.env (values not shown)\nDATABASE_URL=postgresql://ov_live_app:s3cr3t@127.0.0.1:6432/ov_live\nVALKEY_URL=redis://ov_svc_live:s3cr3t@127.0.0.1:6379/0\n' });

        const r = await cli(host, 'data', 'provision', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0].script, `${DIR}/roles/data/add-service.sh`);
        assert.deepStrictEqual(runs[0].args, ['live']);
        assert.strictEqual(runs[0].privileged, true);
        assert.match(r.out, /database ov_live/);
        assert.doesNotMatch(r.out, /postgres(ql)?:\/\//i);
        assert.doesNotMatch(r.out, /(valkey|redis):\/\//i);
        assert.doesNotMatch(r.out, /s3cr3t/);
    }),

    test('provision refuses a service missing from the inventory and runs nothing', async () => {
        const host = scenario();
        const runs = installScripts(host);
        const r = await cli(host, 'data', 'provision', 'nope');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /unknown service "nope"/);
        assert.deepStrictEqual(runs, []);
    }),

    test('a script missing from the install is refused before anything runs', async () => {
        const host = scenario();
        const r = await cli(host, 'data', 'provision', 'live');
        assert.strictEqual(r.code, 1, r.out);
        assert.match(r.out, /add-service\.sh is not in the ovhost install/);
    }),

    test('switch passes the inventory units (worker templates as a glob) and dir, plus --sqlite, and passes the exit code through', async () => {
        const host = scenario();
        const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
        raw.services.media.workerUnits = ['openvibe-media-clip@.service'];
        host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640 });
        const runs = installScripts(host, { code: 3, stderr: '[switch] still busy after 12 hours: not switching\n' });

        const r = await cli(host, 'data', 'switch', 'media', '--sqlite', '/var/lib/openvibe-media/media.db');
        assert.strictEqual(r.code, 3, r.out);
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0].script, `${DIR}/roles/data/switch-service.sh`);
        assert.deepStrictEqual(runs[0].args, ['media', '/var/lib/openvibe-media/media.db']);
        assert.strictEqual(runs[0].env.SWITCH_DIR, '/opt/openvibe.media');
        assert.strictEqual(runs[0].env.SWITCH_UNITS, 'openvibe-media.service openvibe-media-clip@*.service');
        assert.match(r.out, /still busy after 12 hours/);
    }),

    test('switch without --sqlite passes no file and uses the entries for a default service', async () => {
        const host = scenario();
        const runs = installScripts(host);
        const r = await cli(host, 'data', 'switch', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual(runs[0].args, ['live']);
        assert.strictEqual(runs[0].env.SWITCH_DIR, '/opt/openvibe.live');
        // Live is socket-activated: its socket is stopped too (after the service), or the next request starts the old
        // release again while the import runs.
        assert.strictEqual(runs[0].env.SWITCH_UNITS, 'openvibe-live.service openvibe-live.socket');
    }),

    test('switch also stops the units matching unitsMatch', async () => {
        const host = scenario();
        const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
        raw.services.live.unitsMatch = 'openvibe-live*.service';
        host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640 });
        const runs = installScripts(host);
        const r = await cli(host, 'data', 'switch', 'live');
        assert.strictEqual(r.code, 0, r.out);
        assert.strictEqual(runs[0].env.SWITCH_UNITS, 'openvibe-live.service openvibe-live*.service openvibe-live.socket');
    }),

    test('without root both are refused and nothing runs (sudo would drop SWITCH_UNITS/SWITCH_DIR)', async () => {
        const host = scenario();
        const runs = installScripts(host);
        host.exec.isRoot = async () => false;
        for (const action of ['provision', 'switch']) {
            const r = await cli(host, 'data', action, 'live');
            assert.strictEqual(r.code, 1, r.out);
            assert.match(r.out, new RegExp(`data ${action} must run as root`));
        }
        assert.deepStrictEqual(runs, []);
        const dry = await cli(host, 'data', 'switch', 'live', '--dry-run');
        assert.strictEqual(dry.code, 0, dry.out);
    }),

    test('--dry-run prints the command and runs nothing', async () => {
        const host = scenario();
        const runs = installScripts(host);

        const p = await cli(host, 'data', 'provision', 'live', '--dry-run');
        assert.strictEqual(p.code, 0, p.out);
        assert.match(p.out, /^would run: \/opt\/ovhost-install\/roles\/data\/add-service\.sh "live"$/m);

        const s = await cli(host, 'data', 'switch', 'live', '--sqlite', '/var/lib/openvibe-live/live.db', '--dry-run');
        assert.strictEqual(s.code, 0, s.out);
        assert.match(s.out, /would run: SWITCH_UNITS="openvibe-live\.service openvibe-live\.socket" SWITCH_DIR="\/opt\/openvibe\.live" \/opt\/ovhost-install\/roles\/data\/switch-service\.sh "live" "\/var\/lib\/openvibe-live\/live\.db"/);
        assert.deepStrictEqual(runs, []);
    }),

    test('--json reports the run and still carries no URL or password', async () => {
        const host = scenario();
        installScripts(host, { stdout: 'DATABASE_URL=postgresql://ov_live_app:pw@127.0.0.1:6432/ov_live\n' });
        const r = await cli(host, 'data', 'provision', 'live', '--json');
        assert.strictEqual(r.code, 0, r.out);
        const doc = JSON.parse(r.out);
        assert.strictEqual(doc.service, 'live');
        assert.strictEqual(doc.action, 'provision');
        assert.strictEqual(doc.ok, true);
        assert.strictEqual(doc.code, 0);
        assert.strictEqual(doc.stdout, 'DATABASE_URL=<redacted-url>\n');
        assert.doesNotMatch(r.out, /postgres(ql)?:\/\//i);
        assert.doesNotMatch(r.out, /ov_live_app:pw/);
    }),

    test('usage: data needs a known subcommand and a service', async () => {
        const host = scenario();
        const bad = await cli(host, 'data', 'migrate', 'live');
        assert.strictEqual(bad.code, 1, bad.out);
        assert.match(bad.out, /usage: ovhost data provision/);
        const missing = await cli(host, 'data', 'switch');
        assert.strictEqual(missing.code, 1, missing.out);
        assert.match(missing.out, /data switch needs a <service>/);
    }),
]);
