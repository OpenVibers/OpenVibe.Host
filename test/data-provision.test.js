'use strict';
/**
 * `ovhost data provision`: the data role (roles/data/add-service.sh) run from the ovhost install, driven against the fake host. The scripts are
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
    for (const f of ['add-service.sh']) host.put(`${DIR}/roles/data/${f}`, '#!/usr/bin/env bash\n', { mode: 0o755, owner: 'root' });
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

]);
