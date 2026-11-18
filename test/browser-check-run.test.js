'use strict';
// Plan §AD.21 item 6: ovhost browser-watch's check as a Run job on the shared node (lib/browser-check-run.js). It
// submits the check for the operator in their checks project, polls the job, and answers the same { code, stdout }
// a local run does; anything that is not a finished job with a report is code 2 (not a pass and not a fail).
//   node test/browser-check-run.test.js
const assert = require('assert');
const { createRunCheck, settingsOf } = require('../lib/browser-check-run');

const SUBJECT = 'usr_01KKT9AC60KM7CRTB3WN1Z8P56';
const PROJECT = 'prj_01M7A6T4Y2ZNWTMM8VR6HW5T17';
const inv = { browserCheck: { run: { url: 'http://127.0.0.1:4920', subject: SUBJECT, project: PROJECT } } };
const ENV_FILE = 'OV_OAUTH_CLIENT_ID=host\nOV_OAUTH_CLIENT_SECRET=s3cret-not-printed\nEVENTS_URL=http://127.0.0.1:4300\nOV_NETWORK_INTERNAL_URL=http://127.0.0.1:4000\n';
const REPORT = [{ site: 'wiki', summary: { routes: 3, checks: { status: { pass: 3, fail: 0 } } }, routes: [{ path: '/', ok: true }] }];

function fakeExec(states, result) {
    const calls = [];
    let polls = 0;
    return {
        calls,
        readFile: async () => ENV_FILE,
        request: async (url, o = {}) => {
            calls.push({ url, method: o.method, headers: o.headers, body: o.body });
            if (url.endsWith('/oauth/token')) return { status: 200, body: JSON.stringify({ access_token: 'tok-run' }) };
            if (url.endsWith('/api/v1/jobs') && o.method === 'POST') return { status: 201, body: JSON.stringify({ id: 'job_1', state: 'queued' }) };
            if (url.endsWith('/api/v1/jobs/job_1')) { const state = states[Math.min(polls++, states.length - 1)]; return { status: 200, body: JSON.stringify({ id: 'job_1', state, result: state === 'succeeded' ? result : null, error: state === 'expired' ? { code: 'run.unplaceable' } : null }) }; }
            return { status: 404, body: '{}' };
        },
    };
}

(async () => {
    // Not configured: the local Chrome, as before.
    assert.strictEqual(createRunCheck({ exec: fakeExec([], null), inv: {}, env: {} }), null);
    assert.strictEqual(settingsOf({ browserCheck: { run: { url: 'http://127.0.0.1:4920', subject: 'nobody', project: PROJECT } } }, {}), null, 'a malformed subject is not configured');

    // Through the real inventory loader (11-18: the normaliser kept only the keys it knew, so host.json's browserCheck
    // never reached the check and production kept running Chrome itself).
    const { normalise } = require('../lib/inventory');
    const loaded = normalise({ services: {}, browserCheck: inv.browserCheck });
    assert.deepStrictEqual(loaded.browserCheck.run, inv.browserCheck.run, 'browserCheck.run survives the loader');
    assert.ok(createRunCheck({ exec: fakeExec([], null), inv: loaded, env: {} }), 'and configures the check');
    assert.strictEqual(normalise({ services: {} }).browserCheck.run, null);

    // A pass: submitted as the operator in the checks project, polled to the end, the report handed back as stdout.
    const e = fakeExec(['queued', 'running', 'succeeded'], { code: 0, stdout: JSON.stringify(REPORT), stderr: '' });
    const check = createRunCheck({ exec: e, inv, env: {}, pollMs: 1 });
    const r = await check('wiki');
    assert.deepStrictEqual(r, { code: 0, stdout: JSON.stringify(REPORT) });
    const submit = e.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/v1/jobs'));
    const body = JSON.parse(submit.body);
    assert.deepStrictEqual([body.class, body.artifact, body.args, body.egress], ['linux', { name: 'openvibe-browser-check', version: '1.0.0' }, { site: 'wiki' }, 'public']);
    assert.deepStrictEqual(body.requirements.trust, ['first-party', 'user-owned'], 'the operator\'s own node is eligible (11-18: without it the job waited, unplaceable)');
    assert.deepStrictEqual([body.requirements.kind, body.requirements.mobility, body.requirements.latency_class, body.requirements.objective], ['host.browser-check', 'job', 'background', 'balanced']);
    assert.deepStrictEqual([submit.headers.Authorization, submit.headers['X-OV-Subject'], submit.headers['X-OV-Project']], ['Bearer tok-run', SUBJECT, PROJECT]);
    const tokenCall = e.calls.find((c) => c.url.endsWith('/oauth/token'));
    assert.match(tokenCall.body, /audience=openvibe\.run/);
    assert.match(tokenCall.body, /scope=run\.job\.submit\+run\.job\.read/);

    // A failing site: code 1 with its report, as a local run.
    const f = await createRunCheck({ exec: fakeExec(['succeeded'], { code: 1, stdout: JSON.stringify(REPORT), stderr: '' }), inv, env: {}, pollMs: 1 })('wiki');
    assert.strictEqual(f.code, 1);
    // A job that never ran: neither a pass nor a fail.
    const x = await createRunCheck({ exec: fakeExec(['queued', 'expired'], null), inv, env: {}, pollMs: 1 })('wiki');
    assert.deepStrictEqual([x.code, x.stdout], [2, '']);
    assert.match(x.error, /ended expired \(run\.unplaceable\)/);
    // A job that runs too long is given up, as code 2.
    const slow = await createRunCheck({ exec: fakeExec(['running'], null), inv, env: {}, pollMs: 1, timeoutMs: 5 })('wiki');
    assert.match(slow.error, /did not end in/);
    // A job that waits longer than a token lives (11-18: a 13-minute job, a 5-minute token; every later poll answered
    // 401, the finished job was never seen and the check gave up as code 2). Run accepts only the newest token here,
    // and each poll moves the clock a minute.
    {
        let clock = Date.parse('2026-11-18T01:02:34Z');
        let issued = 0;
        let polls = 0;
        const born = new Map();
        const reads = [];
        const ex = {
            readFile: async () => ENV_FILE,
            request: async (url, o = {}) => {
                if (url.endsWith('/oauth/token')) { issued++; born.set(`tok-${issued}`, clock); return { status: 200, body: JSON.stringify({ access_token: `tok-${issued}`, expires_in: 300 }) }; }
                const tok = String(o.headers.Authorization || '').replace(/^Bearer /, '');
                const ok = tok === `tok-${issued}` && clock < born.get(tok) + 300000;   // the newest, and not past its 5 minutes
                if (url.endsWith('/api/v1/jobs') && o.method === 'POST') return ok ? { status: 201, body: JSON.stringify({ id: 'job_1', state: 'queued' }) } : { status: 401, body: '{}' };
                if (url.endsWith('/api/v1/jobs/job_1')) {
                    reads.push(o.headers.Authorization);
                    if (!ok) { clock += 15000; return { status: 401, body: JSON.stringify({ code: 'auth.invalid_token' }) }; }
                    clock += 60000;
                    const state = ++polls >= 13 ? 'succeeded' : 'queued';
                    return { status: 200, body: JSON.stringify({ id: 'job_1', state, result: state === 'succeeded' ? { code: 0, stdout: JSON.stringify(REPORT), stderr: '' } : null }) };
                }
                return { status: 404, body: '{}' };
            },
        };
        const long = await createRunCheck({ exec: ex, inv, env: {}, pollMs: 1, now: () => clock })('wiki');
        assert.deepStrictEqual(long, { code: 0, stdout: JSON.stringify(REPORT) }, 'a 13-minute job is still seen to finish');
        assert.ok(issued >= 3, `the token is taken again before it ends (${issued} taken)`);
        assert.ok(reads.every((h) => /^Bearer tok-\d+$/.test(h)));

        // A token Run refuses early (rotated keys, say) is taken again at once, without waiting for its time.
        issued = 0; polls = 12; reads.length = 0;
        let refused = false;
        const ex2 = { ...ex, request: async (url, o = {}) => {
            if (!refused && url.endsWith('/api/v1/jobs/job_1')) { refused = true; issued++; return { status: 401, body: '{}' }; }
            return ex.request(url, o);
        } };
        const early = await createRunCheck({ exec: ex2, inv, env: {}, pollMs: 1, now: () => clock })('wiki');
        assert.strictEqual(early.code, 0, 'a 401 takes a new token and reads again');

        // A read Run keeps refusing: the give-up says why.
        const denied = { readFile: async () => ENV_FILE, request: async (url, o = {}) => {
            if (url.endsWith('/oauth/token')) return { status: 200, body: JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
            if (o.method === 'POST') return { status: 201, body: JSON.stringify({ id: 'job_1' }) };
            return { status: 403, body: JSON.stringify({ code: 'run.forbidden' }) };
        } };
        const why = await createRunCheck({ exec: denied, inv, env: {}, pollMs: 1, timeoutMs: 5 })('wiki');
        assert.match(why.error, /the last read answered HTTP 403/);
    }
    console.log('browser check on Run: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
