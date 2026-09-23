'use strict';
const assert = require('assert');
const { scenario, test, runTests, SECRET } = require('./helpers');
const envfile = require('../lib/envfile');

function noSecrets(text) {
    assert.ok(!text.includes(SECRET), 'output contains a secret value');
    assert.ok(!text.includes('4f9a2c'), 'output contains part of a secret value');
}

runTests([
    test('a release-layout service is checked by its current release, not as a git checkout, and is never managed', async () => {
        const host = scenario();
        const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
        raw.services.rel = { repo: '/opt/rel.stream', layout: 'release', units: [] };
        host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640 });
        host.put('/opt/rel.stream/releases/655b98a10aaa/package.json', '{}');
        await host.exec.symlink('/opt/rel.stream/releases/655b98a10aaa', '/opt/rel.stream/current');
        let res = JSON.parse((await host.cli('validate', 'rel', '--json')).out);
        assert.deepStrictEqual(res.findings.filter((f) => f.level === 'error'), []);
        assert.ok(res.findings.some((f) => f.area === 'checkout' && /current -> \/opt\/rel\.stream\/releases\/655b98a10aaa/.test(f.message)));
        const st = await host.cli('status', '--json');
        assert.match(st.out, /655b98a10aaa/);
        assert.match(st.out, /"managed":\s*false/);
        // current must name a release under releases/, owned by root or the checkout owner.
        host.put('/opt/elsewhere/package.json', '{}');
        host.files.delete('/opt/rel.stream/current');
        await host.exec.symlink('/opt/elsewhere', '/opt/rel.stream/current');
        res = JSON.parse((await host.cli('validate', 'rel', '--json')).out);
        assert.ok(res.findings.some((f) => f.level === 'error' && /points outside/.test(f.message)));
        host.put('/opt/rel.stream/releases/odd/package.json', '{}', { owner: 'nobody' });
        host.files.get('/opt/rel.stream/releases/odd').owner = 'nobody';
        host.files.delete('/opt/rel.stream/current');
        await host.exec.symlink('/opt/rel.stream/releases/odd', '/opt/rel.stream/current');
        res = JSON.parse((await host.cli('validate', 'rel', '--json')).out);
        assert.ok(res.findings.some((f) => f.level === 'error' && /owned by nobody/.test(f.message)));
    }),

    test('env validation reports names only — never a value — in text and JSON output', async () => {
        const host = scenario();
        host.put('/etc/openvibe/live.env', `JWT_SECRET=${SECRET}\nBASE_URL=\nPAYPAL_CLIENT_SECRET=""\n`, { mode: 0o644 });
        for (const args of [['validate', 'live'], ['validate', 'live', '--json']]) {
            const r = await host.cli(...args);
            assert.strictEqual(r.code, 2, r.out);
            noSecrets(r.out);
            assert.match(r.out, /missing: OV_OAUTH_CLIENT_SECRET/);
            assert.match(r.out, /empty: BASE_URL, PAYPAL_CLIENT_SECRET/);
            assert.match(r.out, /world-readable \(mode 644\)/);
        }
    }),

    test('a correct env file passes; names from the unit Environment= lines count as present', async () => {
        const host = scenario();
        host.inv.services.live.env.required.push('NODE_ENV');
        const raw = JSON.parse(host.read('/etc/openvibe/host.json'));
        raw.services.live.env.required.push('NODE_ENV');
        host.put('/etc/openvibe/host.json', JSON.stringify(raw), { mode: 0o640 });
        host.listeners.set(3000, [{ pid: 1, process: 'systemd' }, { pid: host.units.get('openvibe-live.service').mainPid, process: 'node' }]);
        host.put('/etc/nginx/sites-available/openvibe.live.conf', 'server {}');
        await host.exec.symlink('/etc/nginx/sites-available/openvibe.live.conf', '/etc/nginx/sites-enabled/openvibe.live.conf');
        host.put('/etc/systemd/system/openvibe-live.service', host.repo('live').commits.get(host.repo('live').head).files['deploy/systemd/openvibe-live.service'].replace('\n', '\nEnvironment=NODE_ENV=production\n'));
        const r = await host.cli('validate', 'live', '--json');
        const res = JSON.parse(r.out);
        const errors = res.findings.filter((f) => f.level === 'error');
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(r.code, 0);
        assert.ok(res.findings.some((f) => f.area === 'env' && /5 required name\(s\) present/.test(f.message)));
        assert.ok(res.findings.some((f) => f.area === 'port' && /held by systemd \(openvibe-live\.socket\), node/.test(f.message)));
        assert.ok(res.findings.some((f) => f.level === 'warn' && /PartOf=openvibe-live\.service/.test(f.message)), 'PartOf propagation is pointed out');
        assert.ok(res.findings.some((f) => f.level === 'info' && /TURN_URL/.test(f.message)), 'optional names from .env.example listed');
        noSecrets(r.out);
    }),

    test('required: "from-example" takes every name the checkout .env.example declares', async () => {
        const host = scenario();
        host.put('/etc/openvibe/media.env', `PORT=4100\nMEDIA_B2_APP_KEY=${SECRET}\n`, { mode: 0o600 });
        const r = await host.cli('validate', 'media');
        assert.match(r.out, /missing: MEDIA_R2_SECRET_ACCESS_KEY/);
        noSecrets(r.out);
    }),

    test('flags a missing unit, a port held by someone else, a missing vhost and a failing nginx -t', async () => {
        const host = scenario();
        host.units.delete('openvibe-live.service');
        host.listeners.set(3000, [{ pid: 999, process: 'python3' }]);
        host.nginxTest = () => ({ code: 1, stderr: 'nginx: [emerg] unknown directive "proxy_passs"' });
        const r = await host.cli('validate', 'live');
        assert.strictEqual(r.code, 2);
        assert.match(r.out, /openvibe-live\.service is not loaded/);
        assert.match(r.out, /3000 is held by python3\(999\)/);
        assert.match(r.out, /sites-available\/openvibe\.live\.conf missing/);
        assert.match(r.out, /nginx -t failed: .*proxy_passs/);
    }),

    test('checkout owner, branch and dependency resolution are checked', async () => {
        const host = scenario();
        host.files.get('/opt/openvibe.events').owner = 'root';
        host.files.delete('/opt/openvibe.events/node_modules/express/package.json');
        const r = await host.cli('validate', 'events');
        assert.match(r.out, /owned by root, expected ubuntu/);
        assert.match(r.out, /express — node_modules\/express\/package\.json is missing/);
    }),

    test('the env parser keeps no values', () => {
        const parsed = envfile.parseNames(`A=${SECRET}\nexport B="x y"\nC=\nD=''\n# E=1\nF= # comment\n`);
        assert.deepStrictEqual(parsed, [
            { name: 'A', empty: false }, { name: 'B', empty: false }, { name: 'C', empty: true }, { name: 'D', empty: true }, { name: 'F', empty: true },
        ]);
        assert.ok(!JSON.stringify(parsed).includes(SECRET));
        assert.deepStrictEqual(envfile.parseExample('A=1\n# B=\nC=\n').declared, ['A', 'C']);
        assert.deepStrictEqual(envfile.unitEnvironmentNames('Environment=A=1 "B=two words"\nEnvironment=C=3\n'), ['A', 'B', 'C']);
    }),

    test('env-names lists .env.example names', async () => {
        const host = scenario();
        const r = await host.cli('env-names', 'live');
        assert.strictEqual(r.code, 0);
        assert.match(r.out, /JWT_SECRET/);
        assert.match(r.out, /commented out: OPTIONAL_THING/);
    }),
]);
