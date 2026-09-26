'use strict';
// Protected probes that add up parts (kind "sum", WS-P task 2): Tools' running jobs sit in each
// satellite's jobs.db, so the probe is the total of one sqlite-count per satellite. Unknown when any part
// cannot answer (never read as zero); validation checks every part and refuses a sum inside a sum.
const assert = require('assert');
const { countProtected } = require('../lib/probes');
const { normalise } = require('../lib/inventory');

const counts = { '/opt/t/apps/img/data/jobs.db': 2, '/opt/t/apps/audio/data/jobs.db': 0, '/opt/t/apps/docs/data/jobs.db': 1 };
const exec = {
    run: async () => ({ code: 0, stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\n', stderr: '' }),
    sqlite: async (db) => { if (!(db in counts)) throw new Error(`no such database ${db}`); return [{ n: counts[db] }]; },
    http: async () => ({ status: 200, body: JSON.stringify({ connections: 4 }) }),
};
const part = (app) => ({ kind: 'sqlite-count', db: `/opt/t/apps/${app}/data/jobs.db`, sql: "SELECT count(*) AS n FROM tool_jobs WHERE state = 'running'" });
const svc = { units: ['openvibe-tools.service'], runAs: 'ubuntu', protected: { kind: 'sum', label: 'running tool jobs', probes: [part('img'), part('audio'), part('docs')] } };

(async () => {
    assert.deepStrictEqual(await countProtected(exec, svc), { count: 3, label: 'running tool jobs' });
    const mixed = { ...svc, protected: { kind: 'sum', label: 'x', probes: [part('img'), { kind: 'http-json-count', url: 'http://127.0.0.1:4400/ready', field: 'connections' }] } };
    assert.strictEqual((await countProtected(exec, mixed)).count, 6, 'parts of different kinds add up');
    const broken = { ...svc, protected: { ...svc.protected, probes: [part('img'), part('video')] } };
    const r = await countProtected(exec, broken);
    assert.strictEqual(r.count, null, 'one part that cannot answer makes the total unknown, never a smaller number');
    assert.match(r.unknown, /^part 2: no such database/);

    // The inventory checks each part.
    const base = { owner: 'ubuntu', repo: '/opt/t', units: ['openvibe-tools.service'] };
    assert.doesNotThrow(() => normalise({ services: { tools: { ...base, protected: svc.protected } } }));
    assert.throws(() => normalise({ services: { tools: { ...base, protected: { kind: 'sum', probes: [] } } } }), /probes must be a non-empty array/);
    assert.throws(() => normalise({ services: { tools: { ...base, protected: { kind: 'sum', probes: [{ ...part('img'), sql: 'DELETE FROM tool_jobs' }] } } } }), /probes\[0\]\.sql must be a SELECT/);
    assert.throws(() => normalise({ services: { tools: { ...base, protected: { kind: 'sum', probes: [{ kind: 'sum', probes: [part('img')] }] } } } }), /probes\[0\]\.kind must be one of http-json-count, sqlite-count/);
    assert.throws(() => normalise({ services: { tools: { ...base, protected: { kind: 'sum', probes: [{ kind: 'http-json-count', url: 'https://example.com/ready', field: 'n' }] } } } }), /loopback/);
    console.log('probes sum: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
