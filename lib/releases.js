'use strict';
/**
 * The release log: one JSON object per line in <stateDir>/releases/<service>.jsonl, appended for
 * every deploy and rollback attempt — including refusals and failures, which are the ones an
 * operator most needs to read later. Records carry shas, flags and counts; never env values.
 */
const path = require('path');
const crypto = require('crypto');

function logPath(inv, serviceId) {
    return path.join(inv.stateDir, 'releases', `${serviceId}.jsonl`);
}

function newId(now) {
    const d = new Date(now);
    const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `rel_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

async function append(exec, inv, record) {
    await exec.appendFile(logPath(inv, record.service), `${JSON.stringify(record)}\n`);
}

async function list(exec, inv, serviceId) {
    const text = await exec.readFile(logPath(inv, serviceId));
    if (!text) return [];
    const out = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* a torn last line is skipped, not fatal */ }
    }
    return out;
}

/**
 * The sha to roll back to when none is given: the `from` of the most recent successful deploy
 * that brought the checkout to `currentSha`.
 */
function previousFor(records, currentSha) {
    for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r.result === 'deployed' && r.to === currentSha && r.from && r.from !== currentSha) return r.from;
    }
    return null;
}

module.exports = { append, list, previousFor, logPath, newId };
