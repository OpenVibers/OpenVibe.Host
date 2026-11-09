'use strict';
const assert = require('assert');
const express = require('express');
const { createHostSession } = require('../server/auth/sso');

const person = { sub: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0', subject_id: 'usr_01JABCDEFGHJKMNPQRSTVWXYZ0' };
const auth = {
    async verify(token) {
        if (token === 'person.jwt.sig') return person;
        if (token === 'service.jwt.sig') return { ...person, sub: 'svc:host' };
        if (token === 'assertion.jwt.sig') return { ...person, typ: 'fedcm' };
        return null;
    },
    router: () => express.Router(),
};
const app = express();
app.use('/auth', createHostSession({ auth, config: { cookies: { secure: false } } }).router(express));

(async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const get = (cookie) => fetch(`${base}/auth/navbar-token`, { headers: cookie ? { Cookie: `ov_host_session=${cookie}` } : {} });
        const ok = await get('person.jwt.sig');
        assert.strictEqual(ok.status, 200);
        assert.strictEqual((await ok.json()).token, 'person.jwt.sig');
        assert.strictEqual(ok.headers.get('cache-control'), 'private, no-store');
        for (const cookie of [null, 'invalid', 'service.jwt.sig', 'assertion.jwt.sig']) {
            assert.strictEqual((await get(cookie)).status, 401, `refuse ${cookie || 'a guest'}`);
        }
        console.log('navbar token: verified person only, uncached');
    } finally { await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
