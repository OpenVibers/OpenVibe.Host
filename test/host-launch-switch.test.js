'use strict';
/**
 * Public hosting is owner-gated (plan T20/O34): until HOST_PUBLIC_HOSTING=on, the front page says hosting is not
 * open yet and invites no one to publish, a person cannot create a project (403 host.not_launched), the dashboard
 * shows why instead of the form, and OpenVibe staff can still create projects to test the engine.
 */
const assert = require('assert');
const { boot, check, done, DASHBOARD } = require('./stageb/boot');
const { csrfToken } = require('../server/auth/forms');

(async () => {
    const t = await boot({ env: { HOST_PUBLIC_HOSTING: 'off' } });
    const alice = t.user('alice');
    const staff = t.user('root', { role: 'admin' });

    await check('the signed-out front page says hosting is not open yet and invites no one to publish', async () => {
        const r = await t.api('GET', '/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /not open yet/);
        assert.match(r.text, /launch review/);
        assert.match(r.text, /How it will work/);
        assert.doesNotMatch(r.text, /Get a site online/);
        assert.doesNotMatch(r.text, /class="sc-btn sc-primary" href="\/auth\/login/, 'no primary sign-in-to-publish call');
        assert.match(r.text, /id="limits"/, 'the limits the engine enforces are still published');
    });

    await check('a person cannot create a project until launch', async () => {
        const r = await t.api('POST', '/api/v1/projects', { as: alice, json: { name: 'Too early' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'host.not_launched');
    });

    await check('the signed-in dashboard explains instead of offering the form, and its form post is refused', async () => {
        const r = await t.api('GET', '/', { session: alice });
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Your projects/);
        assert.match(r.text, /not open for hosting yet/);
        assert.doesNotMatch(r.text, /<form[^>]+action="\/projects"/);
        const csrf = csrfToken({ formSecret: 'test-form-secret' }, { subject: alice.subject });
        const post = await t.api('POST', '/projects', { session: alice, form: { csrf, name: 'Too early', environment: 'production' }, headers: { origin: `https://${DASHBOARD}` } });
        assert.ok(!/\/projects\/prj_/.test(post.headers.location || ''), `no project page to go to: ${post.status} ${post.headers.location}`);
        const mine = (await t.api('GET', '/api/v1/projects', { as: alice })).json().projects;
        assert.strictEqual(mine.length, 0, 'nothing was created');
    });

    await check('OpenVibe staff can still create a project to test the engine', async () => {
        const p = await t.project(staff, 'Staff test');
        assert.match(p.id, /^prj_/);
    });

    done();
})();
