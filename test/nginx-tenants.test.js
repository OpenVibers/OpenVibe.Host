'use strict';
/**
 * `ovhost nginx tenants host`: the dashboard + *.openvibe.host vhost with the wildcard certificate
 * path as a parameter, and a vhost for VERIFIED custom domains only (read-only query as the service
 * user), HTTPS only where a certificate exists, hostile database values refused, transactional
 * install, and never a key file read.
 */
const assert = require('assert');
const { scenario, test, runTests } = require('./helpers');

function withHost(host, rows) {
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
    host.sqliteHandler = (db, sql, as) => {
        assert.strictEqual(db, '/var/lib/openvibe-host-api/host.db');
        assert.match(sql, /^SELECT hostname FROM host_domains WHERE kind = 'custom' AND status = 'verified'/);
        assert.strictEqual(as, 'ubuntu', 'queried as the service user');
        return rows;
    };
    host.put('/etc/letsencrypt/live/www.tenant-a.org/fullchain.pem', 'CERT', { mode: 0o644 });
    host.put('/etc/letsencrypt/live/www.tenant-a.org/privkey.pem', '-----BEGIN PRIVATE KEY-----\nNOPE\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
    return host;
}

runTests([
    test('renders the wildcard vhost (dashboard + tenants) and verified custom domains; certificates never read', async () => {
        const host = withHost(scenario(), [{ hostname: 'www.tenant-a.org' }, { hostname: 'docs.tenant-b.net' }]);
        const r = await host.cli('nginx', 'tenants', 'host', '--wildcard-cert', '/etc/letsencrypt/live/openvibe.host-wild');
        assert.strictEqual(r.code, 0, r.out);
        assert.match(r.out, /server_name openvibe\.host \*\.openvibe\.host;/, 'port 80 for both');
        assert.match(r.out, /server_name \*\.openvibe\.host;[\s\S]*ssl_certificate +\/etc\/letsencrypt\/live\/openvibe\.host-wild\/fullchain\.pem;/, 'the wildcard certificate path parameter');
        assert.match(r.out, /limit_except GET HEAD \{ deny all; \}/);
        assert.match(r.out, /proxy_set_header Cookie "";/);
        assert.match(r.out, /proxy_hide_header Set-Cookie;/);
        assert.match(r.out, /location ~ \^\/\(api\/v1\/\)\?sites\/\[A-Za-z0-9_\]\+\/deploys\$ \{[\s\S]*client_max_body_size 110m;/);
        assert.match(r.out, /location = \/metrics \{ return 404; \}/);
        assert.match(r.out, /server_name www\.tenant-a\.org;\n\n    ssl_certificate +\/etc\/letsencrypt\/live\/www\.tenant-a\.org\/fullchain\.pem;/, 'HTTPS where a certificate exists');
        assert.ok(!/server_name docs\.tenant-b\.net;\n\n    ssl_certificate/.test(r.out), 'no HTTPS block without a certificate');
        assert.match(r.out, /server_name docs\.tenant-b\.net;[\s\S]*?location \/ \{ return 404; \}/, 'ACME only until the certificate exists');
        assert.match(r.out, /needs a certificate: certbot certonly --webroot -w \/var\/www\/certbot -d docs\.tenant-b\.net/);
        assert.ok(!/\{\{/.test(r.out));
        assert.ok(!r.out.includes('BEGIN PRIVATE KEY'));
        assert.ok(!host.reads.some((f) => /privkey/.test(f)), 'no key file read');
        assert.strictEqual(host.read('/etc/nginx/sites-available/openvibe.host.conf'), null, 'render alone writes nothing');
    }),

    test('hostile or misplaced values from the database never reach nginx config', async () => {
        const host = withHost(scenario(), [
            { hostname: 'ok.example.org' }, { hostname: 'evil.org; } server { listen 80; root /; }' }, { hostname: 'x.openvibe.host' },
            { hostname: 'openvibe.host' }, { hostname: '../../etc' }, { hostname: 'with space.org' }, { hostname: 'ok.example.org' },
        ]);
        const r = await host.cli('nginx', 'tenants', 'host');
        assert.strictEqual(r.code, 0, r.out);
        const custom = r.out.split('# ---- openvibe.host-custom-domains.conf ----')[1];
        assert.match(custom, /server_name ok\.example\.org;/);
        assert.ok(!/evil\.org|x\.openvibe\.host|\.\.\/|with space/.test(custom.replace(/^##.*$/gm, '')));
        assert.strictEqual((custom.match(/server_name ok\.example\.org;/g) || []).length, 1, 'duplicates collapse');
        assert.match(r.out, /refused a custom domain value that is not a plain host name: "evil\.org; \} server/);
        assert.match(r.out, /ssl_certificate +\/etc\/letsencrypt\/live\/openvibe\.host\/fullchain\.pem;/, 'default wildcard certificate name');
    }),

    test('--install writes both vhosts, runs nginx -t and reloads; a failed test restores everything', async () => {
        const host = withHost(scenario(), [{ hostname: 'www.tenant-a.org' }]);
        const ok = await host.cli('nginx', 'tenants', 'host', '--install');
        assert.strictEqual(ok.code, 0, ok.out);
        assert.match(host.read('/etc/nginx/sites-available/openvibe.host.conf'), /server_name \*\.openvibe\.host;/);
        assert.match(host.read('/etc/nginx/sites-available/openvibe.host-custom-domains.conf'), /server_name www\.tenant-a\.org;/);
        assert.ok(host.files.get('/etc/nginx/sites-enabled/openvibe.host-custom-domains.conf'));
        assert.ok(host.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'reload'));

        const fresh = withHost(scenario(), []);
        fresh.nginxTest = () => ({ code: 1, stderr: 'nginx: [emerg] cannot load certificate' });
        const bad = await fresh.cli('nginx', 'tenants', 'host', '--install');
        assert.strictEqual(bad.code, 2);
        assert.strictEqual(fresh.read('/etc/nginx/sites-available/openvibe.host.conf'), null);
        assert.strictEqual(fresh.read('/etc/nginx/sites-available/openvibe.host-custom-domains.conf'), null);
    }),

    test('launch: --install removes the interim tenants-pending vhost in the same nginx -t and reload; a failed test brings it back', async () => {
        const PENDING = '# *.openvibe.host before Host Stage B tenant hosting launches\nserver { server_name *.openvibe.host; return 404; }\n';
        const SITES = '# openvibe.host — static front page (OpenVibe.Sites)\nserver { server_name openvibe.host; root /opt/openvibe.sites/dist/openvibe.host; }\n';
        const prepare = (host) => {
            host.put('/etc/nginx/sites-available/openvibe.host-tenants-pending.conf', PENDING);
            host.files.set('/etc/nginx/sites-enabled/openvibe.host-tenants-pending.conf', { type: 'symlink', target: '/etc/nginx/sites-available/openvibe.host-tenants-pending.conf', owner: 'root', mode: 0o777 });
            host.put('/etc/nginx/sites-available/openvibe.host.conf', SITES);
            host.files.set('/etc/nginx/sites-enabled/openvibe.host.conf', { type: 'symlink', target: '/etc/nginx/sites-available/openvibe.host.conf', owner: 'root', mode: 0o777 });
            return host;
        };
        const review = await prepare(withHost(scenario(), [])).cli('nginx', 'tenants', 'host');
        assert.match(review.out, /--install also removes, in the same nginx -t and reload: openvibe\.host-tenants-pending\.conf/);

        const host = prepare(withHost(scenario(), []));
        let seenAtTest = null;
        host.nginxTest = () => {
            seenAtTest = { pending: host.files.has('/etc/nginx/sites-enabled/openvibe.host-tenants-pending.conf'), main: host.read('/etc/nginx/sites-available/openvibe.host.conf') };
            return { code: 0, stderr: 'ok' };
        };
        const r = await host.cli('nginx', 'tenants', 'host', '--install');
        assert.strictEqual(r.code, 0, r.out);
        assert.deepStrictEqual([seenAtTest.pending, /server_name \*\.openvibe\.host;/.test(seenAtTest.main)], [false, true], 'one nginx -t sees the tenant vhost and no pending vhost');
        assert.ok(!host.files.has('/etc/nginx/sites-enabled/openvibe.host-tenants-pending.conf'));
        assert.ok(!host.files.has('/etc/nginx/sites-available/openvibe.host-tenants-pending.conf'));
        assert.match(r.out, /removed openvibe\.host-tenants-pending\.conf/);
        assert.strictEqual(host.calls.filter((c) => c.cmd === 'systemctl' && c.args[0] === 'reload').length, 1, 'one reload');
        const again = await host.cli('nginx', 'tenants', 'host', '--install');
        assert.match(again.out, /already installed; nothing changed/);

        const bad = prepare(withHost(scenario(), []));
        bad.nginxTest = () => ({ code: 1, stderr: 'nginx: [emerg] cannot load certificate' });
        const f = await bad.cli('nginx', 'tenants', 'host', '--install');
        assert.strictEqual(f.code, 2);
        assert.strictEqual(bad.read('/etc/nginx/sites-available/openvibe.host-tenants-pending.conf'), PENDING, 'pending vhost restored');
        assert.strictEqual(bad.files.get('/etc/nginx/sites-enabled/openvibe.host-tenants-pending.conf').target, '/etc/nginx/sites-available/openvibe.host-tenants-pending.conf');
        assert.strictEqual(bad.read('/etc/nginx/sites-available/openvibe.host.conf'), SITES, 'the Sites placeholder vhost restored');
        assert.ok(!bad.calls.some((c) => c.cmd === 'systemctl' && c.args[0] === 'reload'), 'not reloaded');
    }),

    test('client address headers come from $remote_addr only (realip), in every template ovhost renders', async () => {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', 'templates', 'nginx');
        for (const f of fs.readdirSync(dir)) {
            const t = fs.readFileSync(path.join(dir, f), 'utf8');
            assert.ok(!/\$proxy_add_x_forwarded_for|\$http_x_forwarded_for|\$http_cf_connecting_ip/.test(t), `${f} passes a client-supplied address on`);
            if (/X-Forwarded-For/.test(t)) assert.match(t, /X-Forwarded-For \$remote_addr;/, f);
        }
        const r = await withHost(scenario(), []).cli('nginx', 'tenants', 'host');
        assert.ok(!/proxy_add_x_forwarded_for/.test(r.out));
        assert.match(r.out, /proxy_set_header CF-Connecting-IP \$remote_addr;/);
    }),

    test('www.openvibe.host redirects to the dashboard over the wildcard certificate', async () => {
        const r = await withHost(scenario(), []).cli('nginx', 'tenants', 'host');
        assert.match(r.out, /server_name www\.openvibe\.host;\n\n    ssl_certificate +\/etc\/letsencrypt\/live\/openvibe\.host\/fullchain\.pem;[\s\S]*?return 301 https:\/\/openvibe\.host\$request_uri;/);
    }),

    test('refuses a service without a tenants block, a bad certificate path, and sites under a first-party domain', async () => {
        const host = withHost(scenario(), []);
        assert.notStrictEqual((await host.cli('nginx', 'tenants', 'media')).code, 0);
        const r = await host.cli('nginx', 'tenants', 'host', '--wildcard-cert', '../../etc/ssl');
        assert.notStrictEqual(r.code, 0);
        assert.match(r.out, /not a plain name/);
        const nginx = require('../lib/nginx');
        assert.throws(() => nginx.renderTenants({ nginx: { sitesAvailable: '/x' } }, { id: 'host', port: 4910, nginx: { tenants: { sitesDomain: 'sites.openvibe.network' } } }), /cookies would reach tenant pages/);
    }),
]);
