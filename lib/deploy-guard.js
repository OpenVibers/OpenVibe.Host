'use strict';
/** Host-wide deploy admission. The executor holds a kernel flock until release(). */

const LOCK_FILE = '/run/lock/openvibe-host-deploy.lock';
const MIB = 1024 * 1024;
const { LockedError } = require('./lock');

async function acquire(ctx, svc) {
    const { exec, inv, log } = ctx;
    const seconds = inv.deployGuard.lockWaitSeconds;
    try {
        return await exec.acquireDeployLock(LOCK_FILE, svc.id, seconds, (owner) => {
            log(`waiting for ${owner || 'another service'}'s deploy to finish (up to ${seconds}s)`);
        });
    } catch (err) { throw new LockedError(err.message); }
}

/** Release the host lock only while the protected-session poll waits, then take it back. */
async function waitOutsideLock(ctx, svc, held, work) {
    await held.current.release();
    held.current = null;
    try { return await work(); }
    finally { held.current = await acquire(ctx, svc); }
}

async function enoughMemory(exec, config, log = () => {}) {
    const { minAvailableMiB, memoryWaitSeconds, memoryPollSeconds } = config;
    const min = minAvailableMiB * MIB;
    const start = exec.now();
    let announced = false;
    for (;;) {
        const bytes = await exec.memAvailableBytes();
        if (bytes == null) throw new Error('cannot read MemAvailable from /proc/meminfo; refusing dependency install');
        if (bytes >= min) {
            if (announced) log(`MemAvailable is ${Math.floor(bytes / MIB)} MiB; proceeding with dependency install`);
            return;
        }
        if (!announced) {
            log(`MemAvailable is ${Math.floor(bytes / MIB)} MiB, below ${minAvailableMiB} MiB; waiting up to ${memoryWaitSeconds}s before dependency install`);
            announced = true;
        }
        if (exec.now() - start >= memoryWaitSeconds * 1000) throw new Error(`MemAvailable stayed below ${minAvailableMiB} MiB for ${memoryWaitSeconds}s; dependency install was not started`);
        await exec.sleep(Math.min(memoryPollSeconds * 1000, memoryWaitSeconds * 1000 - (exec.now() - start)));
    }
}

module.exports = { LOCK_FILE, acquire, waitOutsideLock, enoughMemory };
