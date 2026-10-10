'use strict';
const assert = require('assert');
const { countProtected } = require('../lib/probes');
const { normalise } = require('../lib/inventory');
const { createFakeHost } = require('./fake-host');

const counts = { ov_tools_img: 2, ov_tools_audio: 0, ov_tools_docs: 1 };
const exec = {
    run: async () => ({ code: 0, stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\n', stderr: '' }),
    psql: async (database) => { if (!(database in counts)) throw new Error(`no such database ${database}`); return [{ n: counts[database] }]; },
    http: async () => ({ status: 200, body: JSON.stringify({ connections: 4 }) }),
};
const part = (app) => ({ kind: 'postgresql-count', database: `ov_tools_${app}`, sql: "SELECT count(*) AS n FROM tool_jobs WHERE state = 'running'" });
const svc = { units: ['openvibe-tools.service'], protected: { kind: 'sum', label: 'running tool jobs', probes: [part('img'), part('audio'), part('docs')] } };

(async () => {
    assert.deepStrictEqual(await countProtected(exec, svc), { count: 3, label: 'running tool jobs' });
    const mixed = { ...svc, protected: { kind: 'sum', label: 'x', probes: [part('img'), { kind: 'http-json-count', url: 'http://127.0.0.1:4400/ready', field: 'connections' }] } };
    assert.strictEqual((await countProtected(exec, mixed)).count, 6);
    const broken = { ...svc, protected: { ...svc.protected, probes: [part('img'), part('video')] } };
    const r = await countProtected(exec, broken);
    assert.strictEqual(r.count, null);
    assert.match(r.unknown, /^part 2: no such database/);

    const host = createFakeHost();
    host.addUnit('openvibe-tools.service');
    host.psqlHandler = (database, sql) => { assert.strictEqual(database, 'ov_tools'); assert.match(sql, /^SELECT/); return [{ n: 7 }]; };
    const pgPart = { kind: 'postgresql-count', database: 'ov_tools', sql: 'SELECT count(*) AS n FROM tool_jobs' };
    assert.deepStrictEqual(await countProtected(host.exec, { units: ['openvibe-tools.service'], protected: pgPart }), { count: 7, label: 'protected sessions' });
    host.psqlHandler = () => { throw new Error('psql: could not connect to server'); };
    assert.match((await countProtected(host.exec, { units: ['openvibe-tools.service'], protected: pgPart })).unknown, /could not connect/);

    const base = { owner: 'ubuntu', repo: '/opt/t', units: ['openvibe-tools.service'] };
    assert.doesNotThrow(() => normalise({ services: { tools: { ...base, protected: svc.protected } } }));
    assert.throws(() => normalise({ services: { tools: { ...base, protected: { kind: 'sum', probes: [] } } } }), /probes must be a non-empty array/);
    assert.throws(() => normalise({ services: { tools: { ...base, protected: { kind: 'sum', probes: [{ ...part('img'), sql: 'DELETE FROM tool_jobs' }] } } } }), /probes\[0\]\.sql must be a SELECT/);
    assert.throws(() => normalise({ services: { tools: { ...base, protected: { kind: 'sum', probes: [{ kind: 'sum', probes: [part('img')] }] } } } }), /probes\[0\]\.kind must be one of http-json-count, postgresql-count/);
    console.log('probes sum: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
