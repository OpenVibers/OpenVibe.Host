'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { scenario, test, runTests } = require('./helpers');
const { SHORT, LONG } = require('./fixtures/certs');

const KEY_BLOCK = '-----BEGIN PRIVATE KEY-----\nTESTKEYMATERIALMUSTNOTBEPRINTED\n-----END PRIVATE KEY-----\n';

function withCerts(host) {
    host.put('/etc/letsencrypt/live/test10.example/fullchain.pem', SHORT, { mode: 0o644 });
    host.put('/etc/letsencrypt/live/test10.example/privkey.pem', KEY_BLOCK, { mode: 0o600 });
    host.put('/etc/letsencrypt/live/test400.example/combined.pem', `${KEY_BLOCK}${LONG}`, { mode: 0o600 });
    host.put('/etc/nginx/sites-available/a.conf', [
        'server {',
        '    ssl_certificate     /etc/letsencrypt/live/test10.example/fullchain.pem;',
        '    ssl_certificate_key /etc/letsencrypt/live/test10.example/privkey.pem;',
        '    # ssl_certificate /etc/letsencrypt/live/commented/fullchain.pem;',
        '}',
    ].join('\n'));
    host.put('/etc/nginx/sites-available/b.conf', 'server {\n  ssl_certificate /etc/letsencrypt/live/test400.example/combined.pem;\n  ssl_certificate /etc/letsencrypt/live/gone.example/fullchain.pem;\n  ssl_certificate /etc/ssl/private/site.key;\n}\n');
    host.exec.symlink('/etc/nginx/sites-available/a.conf', '/etc/nginx/sites-enabled/a.conf');
    host.exec.symlink('/etc/nginx/sites-available/b.conf', '/etc/nginx/sites-enabled/b.conf');
    // Put the clock five days before the short certificate expires.
    host.advance(new crypto.X509Certificate(SHORT).validToDate.getTime() - 5 * 86400000 - host.exec.now());
}

runTests([
    test('certs: every certificate referenced by an enabled vhost, with expiry; never key material', async () => {
        const host = scenario();
        withCerts(host);
        const r = await host.cli('certs', '--json');
        const list = JSON.parse(r.out);
        const by = Object.fromEntries(list.map((c) => [c.path, c]));
        assert.strictEqual(by['/etc/letsencrypt/live/test10.example/fullchain.pem'].status, 'expiring');
        assert.ok(by['/etc/letsencrypt/live/test10.example/fullchain.pem'].daysLeft <= 5);
        assert.deepStrictEqual(by['/etc/letsencrypt/live/test10.example/fullchain.pem'].names, ['test10.example', '*.test10.example']);
        assert.strictEqual(by['/etc/letsencrypt/live/test400.example/combined.pem'].status, 'ok');
        assert.strictEqual(by['/etc/letsencrypt/live/test400.example/combined.pem'].subject, 'test400.example');
        assert.strictEqual(by['/etc/letsencrypt/live/gone.example/fullchain.pem'].status, 'missing');
        assert.strictEqual(by['/etc/ssl/private/site.key'].status, 'refused');
        assert.ok(!by['/etc/letsencrypt/live/commented/fullchain.pem'], 'commented-out lines are ignored');
        assert.ok(!list.some((c) => /privkey/.test(c.path)), 'ssl_certificate_key is never followed');
        assert.strictEqual(r.code, 2, 'a missing certificate fails the command');
        const text = await host.cli('certs');
        for (const out of [r.out, text.out]) {
            assert.ok(!out.includes('TESTKEYMATERIAL'));
            assert.ok(!out.includes('BEGIN PRIVATE KEY'));
        }
        assert.ok(!host.reads.some((f) => /privkey|\.key$/.test(f)), 'no key file was read');
        assert.ok(!host.calls.some((c) => c.args.some((a) => /privkey/.test(String(a)))), 'no command touched a key path');
        assert.match(text.out, /EXPIRING .*test10\.example\/fullchain\.pem/);
    }),

    test('nginx render: vhost from the manifest domains + inventory port; SSE and WebSocket variants; stdout only', async () => {
        const host = scenario();
        const ev = await host.cli('nginx', 'render', 'events');
        assert.strictEqual(ev.code, 0, ev.out);
        assert.match(ev.out, /server_name events\.openvibe\.network;/);
        assert.match(ev.out, /ssl_certificate +\/etc\/letsencrypt\/live\/openvibe\.network\/fullchain\.pem;/, 'wildcard certificate of the registrable domain');
        assert.match(ev.out, /location = \/realtime\/stream \{[\s\S]*proxy_buffering off;[\s\S]*proxy_read_timeout 1h;/);
        assert.match(ev.out, /proxy_pass http:\/\/127\.0\.0\.1:4300;/);
        const live = await host.cli('nginx', 'render', 'live');
        assert.match(live.out, /server_name openvibe\.live ingest\.openvibe\.live;/);
        assert.match(live.out, /map \$http_upgrade \$ovlive_connection/);
        assert.match(live.out, /location \/ws\/ \{[\s\S]*proxy_set_header Upgrade \$http_upgrade;[\s\S]*proxy_set_header Connection \$ovlive_connection;/);
        assert.ok(!/\{\{/.test(live.out), 'no unfilled template variables');
        const plain = await host.cli('nginx', 'render', 'media', '--variant', 'http');
        assert.match(plain.out, /server_name openvibe\.media;/);
        assert.ok(!/proxy_buffering off/.test(plain.out));
        assert.strictEqual(host.read('/etc/nginx/sites-available/events.openvibe.network.conf'), null, 'render alone writes nothing');
        assert.ok(!host.calls.some((c) => c.cmd === 'nginx' || (c.cmd === 'systemctl' && c.args[0] === 'reload')));
    }),

    test('nginx render --install: writes, links, tests, reloads; a failed nginx -t restores the previous state', async () => {
        const host = scenario();
        const ok = await host.cli('nginx', 'render', 'events', '--install');
        assert.strictEqual(ok.code, 0, ok.out);
        const installed = host.read('/etc/nginx/sites-available/events.openvibe.network.conf');
        assert.match(installed, /events\.openvibe\.network/);
        assert.ok(host.files.get('/etc/nginx/sites-enabled/events.openvibe.network.conf'));
        assert.ok(host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'reload' && c.args[1] === 'nginx.service'));

        host.put('/etc/nginx/sites-available/events.openvibe.network.conf', '# hand-edited previous version\n');
        host.nginxTest = () => ({ code: 1, stderr: 'nginx: [emerg] duplicate zone' });
        const reloadsBefore = host.calls.filter((c) => c.cmd === 'systemctl' && c.args[0] === 'reload').length;
        const bad = await host.cli('nginx', 'render', 'events', '--install');
        assert.strictEqual(bad.code, 2, bad.out);
        assert.match(bad.out, /nginx -t failed; the previous vhost files were restored/);
        assert.strictEqual(host.read('/etc/nginx/sites-available/events.openvibe.network.conf'), '# hand-edited previous version\n');
        assert.strictEqual(host.calls.filter((c) => c.cmd === 'systemctl' && c.args[0] === 'reload').length, reloadsBefore, 'no reload after a failed test');

        // A brand-new vhost that fails the test is removed again, link included.
        const fresh = scenario();
        fresh.nginxTest = () => ({ code: 1, stderr: 'nginx: [emerg] x' });
        const r = await fresh.cli('nginx', 'render', 'media', '--install');
        assert.strictEqual(r.code, 2);
        assert.strictEqual(fresh.read('/etc/nginx/sites-available/openvibe.media.conf'), null);
        assert.strictEqual(fresh.files.get('/etc/nginx/sites-enabled/openvibe.media.conf'), undefined);
    }),

    test('nginx render refuses a service with no domains', async () => {
        const host = scenario();
        const r = await host.cli('nginx', 'render', 'sites');
        assert.notStrictEqual(r.code, 0);
        assert.match(r.out, /no domains|has no port/);
    }),
]);
