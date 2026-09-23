'use strict';
/**
 * Background work in the Host process (a few timers; nothing here executes tenant content):
 *
 *   domain checks    every HOST_DOMAIN_RECHECK_MS: pending custom domains are checked again
 *                    (they fail after HOST_DOMAIN_PENDING_DAYS); verified ones are re-checked daily
 *                    and lapse when their TXT record has been gone for HOST_DOMAIN_LAPSE_DAYS
 *   object sweep     hourly: objects on disk that no deploy row references (an upload that failed
 *                    after writing objects) and interrupted temp files are removed after an hour
 *   outbox prune     daily: sent events older than seven days
 */
const fs = require('fs');

function createWorker({ config, store, domains, blobs, outbox, log = console }) {
    const timers = [];
    let checking = false;

    async function domainTick() {
        if (checking) return null;
        checking = true;
        try {
            const s = await domains.recheck();
            if (s.verified) outbox.kick();
            return s;
        } catch (err) {
            log.error('[Host] domain checks failed:', err.message);
            return null;
        } finally { checking = false; }
    }

    /** Remove objects no row references, once they are older than `graceMs`. */
    function sweepObjects({ graceMs = 3600 * 1000 } = {}) {
        const known = store.db.prepare('SELECT 1 FROM host_blobs WHERE project_id = ? AND sha256 = ?');
        let removed = 0;
        for (const o of blobs.list()) {
            if (known.get(o.projectId, o.sha256)) continue;
            try {
                if (Date.now() - fs.statSync(o.file).mtimeMs < graceMs) continue;
                fs.unlinkSync(o.file);
                removed++;
            } catch { /* raced with a write or already gone */ }
        }
        removed += blobs.sweepTmp(graceMs);
        return removed;
    }

    return {
        domainTick,
        sweepObjects,
        start() {
            if (!config.worker.enabled) return;
            const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref(); timers.push(t); };
            every(config.domains.recheckIntervalMs, domainTick);
            every(3600 * 1000, () => { try { sweepObjects(); } catch (err) { log.warn('[Host] object sweep failed:', err.message); } });
            every(24 * 3600 * 1000, () => { try { outbox.outbox.prune(); } catch (err) { log.warn('[Host] outbox prune failed:', err.message); } });
            setTimeout(domainTick, 5000).unref();
        },
        stop() { for (const t of timers) clearInterval(t); timers.length = 0; },
    };
}

module.exports = { createWorker };
