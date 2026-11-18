'use strict';
/**
 * The release browser check as a Run job on the shared node (plan §AD.21 item 6; the owner, 2026-11-17: "all that
 * should be able to be processed via link on the shared node"). After every deploy production (four cores, its swap
 * full) started a full Chrome beside every site for scripts/browser-check.js. With this, `ovhost browser-watch` asks
 * OpenVibe.Run for the same check instead: the node's Link worker runs it (the function `openvibe-browser-check`,
 * class linux: browser-check.js, the harness and Chrome in its sandbox, public egress only) and answers the same
 * { code, stdout } a local run does, so the state, the metrics and the alerts do not change.
 *
 * Host acts for the operator, in their checks project (X-OV-Subject + X-OV-Project: ADR-003's delegation, which Run
 * confirms with Network), with its own service token (run.job.submit and run.job.read, Network #1091). No production
 * key reaches the node.
 *
 *   createRunCheck({ exec, inv, env }) → check(site, opts) → { code, stdout, error? }, or null when not configured
 *
 * Configured in the inventory (`browserCheck: { run: { url, subject, project, artifact? } }`) or the environment
 * (OVHOST_BROWSERCHECK_RUN_URL, OVHOST_BROWSERCHECK_SUBJECT, OVHOST_BROWSERCHECK_PROJECT); the credentials are Host's
 * own, from the events env file (lib/announce.js loadCredentials).
 */
const { loadCredentials } = require('./announce');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const DONE = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const ARTIFACT = Object.freeze({ name: 'openvibe-browser-check', version: '1.0.0' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settingsOf(inv, env) {
    const c = (inv && inv.browserCheck && inv.browserCheck.run) || {};
    const url = String(c.url || env.OVHOST_BROWSERCHECK_RUN_URL || '').replace(/\/+$/, '');
    const subject = String(c.subject || env.OVHOST_BROWSERCHECK_SUBJECT || '');
    const project = String(c.project || env.OVHOST_BROWSERCHECK_PROJECT || '');
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !SUBJECT_RE.test(subject) || !PROJECT_RE.test(project)) return null;
    const a = c.artifact && typeof c.artifact === 'object' ? c.artifact : ARTIFACT;
    return { url, subject, project, artifact: { name: String(a.name || ARTIFACT.name), version: String(a.version || ARTIFACT.version) } };
}

function createRunCheck({ exec, inv, env = process.env, pollMs = 15000, timeoutMs = 25 * 60 * 1000, now = Date.now } = {}) {
    const s = settingsOf(inv, env);
    if (!s) return null;

    async function token() {
        const creds = await loadCredentials(exec, inv, { env });
        if (creds.error) throw new Error(creds.error);
        const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.secret, audience: 'openvibe.run', scope: 'run.job.submit run.job.read' });
        const t = await exec.request(`${creds.networkUrl}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString(), timeoutMs: 10000 });
        let tok = null;
        try { tok = t.status === 200 ? JSON.parse(t.body).access_token : null; } catch { tok = null; }
        if (typeof tok !== 'string' || !tok) throw new Error(t.status ? `the token endpoint answered ${t.status}` : 'Network did not answer');
        return tok;
    }

    return async function checkOnRun(site) {
        try {
            const tok = await token();
            const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${tok}`, 'X-OV-Subject': s.subject, 'X-OV-Project': s.project };
            const body = {
                class: 'linux', artifact: s.artifact, args: { site }, egress: 'public',
                // The operator's own node is a user-owned offer: Run places a job there only when the job names
                // user-owned trust (and the requester is its owner); first-party nodes are fine too.
                requirements: { kind: 'host.browser-check', mobility: 'job', latency_class: 'background', objective: 'balanced', trust: ['first-party', 'user-owned'] },
                limits: { wall_ms: 20 * 60 * 1000, cpu_ms: 40 * 60 * 1000, mem_bytes: 3 * 1024 * 1024 * 1024 },
                ttl_ms: 25 * 60 * 1000,
                idempotency_key: `browser-check:${site}:${Math.floor(now() / 60000)}`,
            };
            const sub = await exec.request(`${s.url}/api/v1/jobs`, { method: 'POST', headers, body: JSON.stringify(body), timeoutMs: 15000 });
            let job = null;
            try { job = JSON.parse(sub.body); } catch { job = null; }
            const id = job && (job.id || (job.job && job.job.id));
            if (!(sub.status === 200 || sub.status === 201) || !id) return { code: 2, stdout: '', error: `Run did not take the check (${sub.status}${job && job.code ? ` ${job.code}` : ''})` };
            const until = now() + timeoutMs;
            for (;;) {
                await sleep(pollMs);
                const r = await exec.request(`${s.url}/api/v1/jobs/${encodeURIComponent(id)}`, { method: 'GET', headers, timeoutMs: 15000 });
                let j = null;
                try { j = JSON.parse(r.body); } catch { j = null; }
                const state = j && j.state;
                if (state && DONE.has(state)) {
                    if (state !== 'succeeded' || !j.result || typeof j.result !== 'object') return { code: 2, stdout: '', error: `the check on Run ended ${state}${j.error && j.error.code ? ` (${j.error.code})` : ''}` };
                    const code = Number.isInteger(j.result.code) ? j.result.code : 2;
                    return { code, stdout: typeof j.result.stdout === 'string' ? j.result.stdout : '', ...(code >= 2 ? { error: String(j.result.stderr || 'the check broke on the node').slice(-400) } : {}) };
                }
                if (now() > until) return { code: 2, stdout: '', error: `the check on Run did not end in ${Math.round(timeoutMs / 60000)} minutes (job ${id}, ${state || 'unknown'})` };
            }
        } catch (err) {
            return { code: 2, stdout: '', error: `the check on Run could not start: ${String((err && err.message) || err).slice(0, 200)}` };
        }
    };
}

module.exports = { createRunCheck, settingsOf, ARTIFACT };
