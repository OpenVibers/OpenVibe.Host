'use strict';
/**
 * Activation and rollback are one atomic pointer switch: under concurrent traffic every response is
 * one whole deploy (never a mix, never an error); a failure inside the switch changes nothing;
 * artifacts are immutable at the database level; the pointer survives a restart.
 */
const assert = require('assert');
const { boot, check, done } = require('./stageb/boot');

(async () => {
    const t = await boot();
    const alice = t.user('alice');
    const project = await t.project(alice, 'R');
    const site = await t.site(alice, project.id, 'flip');
    const v1 = await t.deploy(alice, site.id, { 'index.html': 'version-1', 'v.txt': '1' });
    const v2 = await t.deploy(alice, site.id, { 'index.html': 'version-2', 'v.txt': '2', 'only-v2.txt': 'yes' }, { activate: false });
    const version = { [v1.id]: '1', [v2.id]: '2' };

    await check('under concurrent traffic every response is exactly one deploy while the pointer flips 40 times', async () => {
        let flips = 0;
        let stop = false;
        const flipper = (async () => {
            while (!stop && flips < 40) {
                const target = flips % 2 === 0 ? v2.id : v1.id;
                const r = await t.api('POST', `/api/v1/deploys/${target}/activate`, { as: alice, json: {} });
                assert.strictEqual(r.status, 200, r.text);
                flips++;
            }
        })();
        const seen = { 1: 0, 2: 0 };
        const readers = Array.from({ length: 8 }, async () => {
            for (let i = 0; i < 40; i++) {
                const p = i % 2 ? '/v.txt' : '/';
                const r = await t.get('flip.openvibe.host', p);
                assert.strictEqual(r.status, 200, `${p}: ${r.status}`);
                const v = version[r.headers['x-openvibe-deploy']];
                assert.ok(v, 'the response names a deploy of this site');
                assert.strictEqual(p === '/' ? r.text : `version-${r.text}`, `version-${v}`, 'the bytes belong to the deploy the response names');
                seen[v]++;
            }
        });
        await Promise.all(readers);
        stop = true;
        await flipper;
        assert.ok(flips >= 10, `flipped ${flips} times`);
        assert.ok(seen[1] + seen[2] === 320);
    });

    await check('a failure inside the switch leaves the pointer, history and outbox untouched', async () => {
        await t.api('POST', `/api/v1/deploys/${v1.id}/activate`, { as: alice, json: {} });
        const db = t.ctx.store.db;
        const before = { active: db.prepare('SELECT active_deploy_id FROM host_sites WHERE id = ?').get(site.id).active_deploy_id, acts: db.prepare('SELECT COUNT(*) AS n FROM host_activations').get().n, events: db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get().n };
        const emit = t.ctx.outbox.emit;
        t.ctx.outbox.emit = () => { throw new Error('simulated crash after the pointer moved'); };
        const r = await t.api('POST', `/api/v1/deploys/${v2.id}/activate`, { as: alice, json: {} });
        t.ctx.outbox.emit = emit;
        assert.strictEqual(r.status, 500);
        assert.strictEqual(db.prepare('SELECT active_deploy_id FROM host_sites WHERE id = ?').get(site.id).active_deploy_id, before.active);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM host_activations').get().n, before.acts);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get().n, before.events);
        assert.strictEqual((await t.get('flip.openvibe.host', '/')).text, 'version-1');
    });

    await check('expected_active guards against racing operators (409 with the current pointer)', async () => {
        const r = await t.api('POST', `/api/v1/deploys/${v2.id}/activate`, { as: alice, json: { expected_active: v2.id } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json().code, 'site.active_changed');
        assert.strictEqual(r.json().active_deploy_id, v1.id);
        const ok = await t.api('POST', `/api/v1/sites/${site.id}/rollback`, { as: alice, json: { expected_active: v1.id } });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.json().active_deploy_id, v2.id);
    });

    await check('rollback with no earlier deploy says so; a failed deploy cannot be activated', async () => {
        const s2 = await t.site(alice, project.id, 'single');
        await t.deploy(alice, s2.id, { 'index.html': 'only' });
        const r = await t.api('POST', `/api/v1/sites/${s2.id}/rollback`, { as: alice, json: {} });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json().code, 'deploy.no_previous');
        const bad = await t.upload(alice, s2.id, { 'x.php': '<?php' });
        const id = bad.json().deploy_id;
        const act = await t.api('POST', `/api/v1/deploys/${id}/activate`, { as: alice, json: {} });
        assert.strictEqual(act.status, 409);
        assert.strictEqual(act.json().code, 'deploy.not_ready');
    });

    await check('artifacts are immutable in the database itself', async () => {
        const db = t.ctx.store.db;
        assert.throws(() => db.prepare("UPDATE host_deploys SET manifest = '{}' WHERE id = ?").run(v1.id), /immutable/);
        assert.throws(() => db.prepare('UPDATE host_deploys SET total_bytes = 1 WHERE id = ?').run(v1.id), /immutable/);
        assert.throws(() => db.prepare("UPDATE host_deploy_files SET sha256 = 'x' WHERE deploy_id = ?").run(v1.id), /immutable/);
        assert.throws(() => db.prepare('DELETE FROM host_deploy_files WHERE deploy_id = ?').run(v1.id), /live deploy/);
        db.prepare("UPDATE host_deploys SET state = 'deleted' WHERE id = (SELECT id FROM host_deploys WHERE state = 'failed' LIMIT 1)").run();
        assert.throws(() => db.prepare("UPDATE host_deploys SET state = 'ready' WHERE state = 'deleted'").run(), /cannot become ready/);
    });

    await check('the active pointer survives a restart', async () => {
        await t.restart();
        assert.strictEqual((await t.get('flip.openvibe.host', '/')).text, 'version-2');
        assert.strictEqual((await t.get('flip.openvibe.host', '/only-v2.txt')).text, 'yes');
    });

    await t.close();
    done();
})();
