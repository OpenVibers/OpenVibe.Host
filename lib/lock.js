'use strict';
/** One operation per service at a time: <stateDir>/locks/<service>.lock holds the owner's pid. */
const path = require('path');

class LockedError extends Error {}

async function acquire(exec, inv, serviceId, pid = process.pid) {
    const file = path.join(inv.stateDir, 'locks', `${serviceId}.lock`);
    const body = JSON.stringify({ pid, at: new Date(exec.now()).toISOString() });
    if (await exec.createExclusive(file, body)) return { file, release: () => exec.removeFile(file) };
    let holder = null;
    try { holder = JSON.parse(await exec.readFile(file)); } catch { /* unreadable lock: treat as stale */ }
    if (holder && holder.pid && await exec.pidAlive(holder.pid)) {
        throw new LockedError(`another ovhost operation on ${serviceId} is running (pid ${holder.pid}, since ${holder.at}); lock: ${file}`);
    }
    await exec.removeFile(file);
    if (await exec.createExclusive(file, body)) return { file, release: () => exec.removeFile(file), recoveredStale: true };
    throw new LockedError(`could not take the lock ${file}`);
}

module.exports = { acquire, LockedError };
