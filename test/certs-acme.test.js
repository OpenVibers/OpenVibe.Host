'use strict';
/**
 * `ovhost certs renew [--install]`: renew the existing certificates with certbot, issue one for every
 * VERIFIED custom domain that has none, then (with --install) re-render the tenant vhosts through the
 * transactional nginx install. A hostile database value never reaches certbot's argv, a failed
 * issuance stays HTTP-only, and no key file is ever read — nothing real is run (test/fake-host.js).
 */
const assert = require('assert');
const { scenario, test, runTests } = require('./helpers');
const { LONG } = require('./fixtures/certs');
const acme = require('../lib/acme');

function withHost(host, rows = []) {
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.host = {
        repo: '/opt/openvibe.host',
        units: ['openvibe-host.service'],
        port: 4910,
        ready: { url: 'http://127.0.0.1:4910/api/ready', timeoutSeconds: 30 },
        databases: [{ name: 'host', path: '/var/lib/openvibe-host-api/host.db' }],
        nginx: { tenants: { sitesDomain: 'openvibe.host', wildcardCert: 'openvibe.host', database: '/var/lib/openvibe-host-api/host.db', maxUpload: '110m' } },
    };
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    host.sqliteHandler = (db, sql) => {
        assert.match(sql, /^SELECT hostname FROM host_domains WHERE kind = 'custom' AND status = 'verified'/);
        return rows;
    };
    return host;
}

/** certbot that issues for real (writes the certificate) but runs nothing. */
function issuer(host) {
    host.certbot = (args) => {
        if (args[0] === 'renew') return { code: 0, stdout: 'Certificate not yet due for renewal.' };
        if (args[0] === 'certonly') {
            const h = args[args.indexOf('-d') + 1];
            host.put(`/etc/letsencrypt/live/${h}/fullchain.pem`, LONG, { mode: 0o644 });
            return { code: 0, stdout: `Successfully received certificate for ${h}.` };
        }
        return { code: 1, stderr: `unknown certbot subcommand ${args[0]}` };
    };
    return host;
}

runTests([
    test('a verified domain with no certificate is issued and then installed over HTTPS', async () => {
        const host = issuer(withHost(scenario(), [{ hostname: 'docs.tenant-b.net' }]));
        assert.strictEqual(host.read('/etc/letsencrypt/live/docs.tenant-b.net/fullchain.pem'), null, 'no certificate yet');
        const r = await host.cli('certs', 'renew', 'host', '--install');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(host.certbotCalls.some((c) => c.args[0] === 'renew'), 'the wildcard lineage is renewed first');
        const call = host.certbotCalls.find((c) => c.args[0] === 'certonly');
        assert.ok(call, 'certbot certonly ran');
        assert.deepStrictEqual(call.args.slice(0, 4), ['certonly', '--webroot', '-w', '/var/www/certbot']);
        assert.strictEqual(call.args[call.args.indexOf('-d') + 1], 'docs.tenant-b.net');
        assert.ok(call.privileged, 'certbot runs as root');
        const custom = host.read('/etc/nginx/sites-available/openvibe.host-custom-domains.conf');
        assert.match(custom, /server_name docs\.tenant-b\.net;[\s\S]*?ssl_certificate +\/etc\/letsencrypt\/live\/docs\.tenant-b\.net\/fullchain\.pem;/);
        assert.ok(host.files.get('/etc/nginx/sites-enabled/openvibe.host-custom-domains.conf'), 'installed and enabled');
        assert.ok(host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'reload'), 'nginx reloaded');
        assert.ok(!host.reads.some((f) => /privkey|\.key$/.test(f)), 'no key file was read');
        assert.ok(!host.certbotCalls.some((c) => c.args.some((a) => /privkey|\.key$/.test(String(a)))), 'no command touched a key path');
    }),

    test('issuance failure keeps the domain HTTP-only and fails the command', async () => {
        const host = withHost(scenario(), [{ hostname: 'docs.tenant-b.net' }]);
        host.certbot = (args) => (args[0] === 'certonly' ? { code: 1, stderr: 'Certbot failed to authenticate some domains: Challenge failed' } : { code: 0, stdout: '' });
        const r = await host.cli('certs', 'renew', 'host', '--install');
        assert.strictEqual(r.code, 2, r.out);
        assert.match(r.out, /failed docs\.tenant-b\.net: .*Challenge failed .* it stays HTTP-only/);
        const custom = host.read('/etc/nginx/sites-available/openvibe.host-custom-domains.conf');
        assert.ok(!/ssl_certificate +\/etc\/letsencrypt\/live\/docs\.tenant-b\.net\/fullchain\.pem;/.test(custom), 'no HTTPS block without a certificate');
        assert.match(custom, /server_name docs\.tenant-b\.net;[\s\S]*?location \/ \{ return 404; \}/, 'ACME only until it succeeds');
        assert.ok(host.files.get('/etc/nginx/sites-enabled/openvibe.host-custom-domains.conf'), 'the vhosts were still installed');
    }),

    test('hostile database values never reach certbot argv', async () => {
        const host = issuer(withHost(scenario(), [
            { hostname: 'ok.example.org' },
            { hostname: 'evil.org; } server { listen 80; root /; }' },
            { hostname: 'x.openvibe.host' },
            { hostname: '../../etc/letsencrypt' },
            { hostname: 'with space.org' },
        ]));
        const r = await host.cli('certs', 'renew', 'host');
        assert.strictEqual(r.code, 0, r.out);
        const certonly = host.certbotCalls.filter((c) => c.args[0] === 'certonly');
        assert.deepStrictEqual(certonly.map((c) => c.args[c.args.indexOf('-d') + 1]), ['ok.example.org'], 'only the plain host name was issued');
        assert.match(r.out, /refused \(not a plain host name\)/);
        assert.ok(certonly.every((c) => c.args.every((a) => !/evil|x\.openvibe\.host|\.\.\/|with space/.test(a))));
    }),

    test('without --install it writes no vhost and reports the plan; --json is the same shape', async () => {
        const host = issuer(withHost(scenario(), [{ hostname: 'docs.tenant-b.net' }]));
        const r = await host.cli('certs', 'renew', '--json', 'host');
        assert.strictEqual(r.code, 0, r.out);
        const o = JSON.parse(r.out);
        assert.strictEqual(o.renewed, true);
        assert.deepStrictEqual(o.issued, ['docs.tenant-b.net']);
        assert.deepStrictEqual(o.failed, []);
        assert.strictEqual(o.installed, null);
        assert.strictEqual(host.read('/etc/nginx/sites-available/openvibe.host-custom-domains.conf'), null, 'render alone writes nothing');
        assert.ok(!host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'reload'));
    }),

    test('the renewal unit is rendered: a root oneshot that renews and installs, on a persistent timer', async () => {
        const { service, timer } = acme.unitTexts();
        assert.match(service, /^Type=oneshot$/m);
        assert.match(service, /^User=root$/m);
        assert.match(service, /^ExecStart=\/usr\/local\/bin\/ovhost certs renew --install$/m);
        assert.match(service, /^Environment=OVHOST_INVENTORY=\/etc\/openvibe\/host\.json$/m);
        assert.match(timer, /^OnCalendar=.*UTC$/m);
        assert.match(timer, /^Persistent=true$/m);
        assert.match(timer, /^Unit=openvibe-certs\.service$/m);
        assert.match(timer, /^WantedBy=timers\.target$/m);
        assert.ok(!service.includes('{{') && !timer.includes('{{'));
    }),
]);
