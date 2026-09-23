'use strict';
/** ovhost status: every service — unit states, checkout sha, readiness, protected sessions. Read-only. */
const systemd = require('../systemd');
const readiness = require('../readiness');
const probes = require('../probes');
const { git } = require('../git');

async function statusOne(ctx, svc) {
    const { exec } = ctx;
    const row = { service: svc.id, managed: svc.managed, units: [], workers: [], socket: null, sha: null, branch: null, ready: null, protected: null };
    for (const u of svc.units) {
        const st = await systemd.show(exec, u);
        row.units.push({ unit: u, active: st.active, sub: st.sub, restarts: st.restarts });
    }
    // Worker units are only listed: ovhost never starts, stops or restarts them.
    for (const w of svc.workerUnits) {
        try {
            for (const i of await systemd.instances(exec, w)) row.workers.push({ unit: i.unit, active: i.active, sub: i.sub });
        } catch (err) {
            row.workers.push({ unit: w, active: 'unknown', error: err.message.split('\n')[0] });
        }
    }
    if (svc.socketUnit) {
        const st = await systemd.show(exec, svc.socketUnit);
        row.socket = { unit: svc.socketUnit, active: st.active, sub: st.sub };
    }
    try {
        if (svc.layout === 'release') {
            const target = await exec.readlink(`${svc.repo}/current`);
            row.sha = target ? String(target).split('/').pop() : null;
            row.branch = 'release';
        } else {
            const g = git(exec, svc);
            row.sha = await g.head();
            row.branch = await g.branch();
        }
    } catch (err) {
        row.shaError = err.message.split('\n')[0];
    }
    if (svc.ready) {
        const p = await readiness.probe(exec, svc);
        row.ready = { ok: p.ok, status: p.status || null, error: p.error || null, latencyMs: p.latencyMs };
    }
    if (svc.protected) {
        const c = await probes.countProtected(exec, svc);
        row.protected = { label: c.label, count: c.count, unknown: c.unknown || null, notRunning: !!c.notRunning };
    }
    return row;
}

async function status(ctx, ids) {
    const list = ids && ids.length ? ids.map((id) => require('../inventory').service(ctx.inv, id)) : Object.values(ctx.inv.services);
    const rows = [];
    for (const svc of list) rows.push(await statusOne(ctx, svc));
    return rows;
}

module.exports = { status };
