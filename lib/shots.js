'use strict';
/**
 * `ovhost shots` (plan L9, devblog §3.3): the screenshot pass.
 *
 *   ovhost shots [--sites live,blog] [--pages /,/pricing] [--dry-run]
 *                                         (openvibe-shots.timer: every 6 hours)
 *
 * For every service the inventory names, the pages it lists (its "shots.pages" list, or "/" when it
 * names none), at two viewports — 390x844 (a phone: isMobile, hasTouch) and 1440x900 — the page is
 * captured in headless Chrome: dark theme, no animations, and the private parts masked ([data-private],
 * the inputs, and any email address on the page). Chrome runs as the unprivileged ovcheck account,
 * never as root, exactly like the browser check.
 *
 * Every PNG is stored in OpenVibe.Media, in Host's own tenant, with the service, the path, the
 * viewport, the release it was taken on and the sha256 of the bytes. The shots of a page and a
 * viewport are kept for 14 days; the same command prunes the older ones.
 *
 * Only public pages are captured: the origins come from the inventory, and a page that is not a
 * path of a public site is refused before Chrome starts.
 */
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { originOf, currentRelease } = require('./browser-watch');

/** The two viewports of §3.3: a phone and a desktop. */
const VIEWPORTS = Object.freeze([
    { name: 'phone', width: 390, height: 844 },
    { name: 'desktop', width: 1440, height: 900 },
]);
/** How long a shot of a page and a viewport is kept. */
const RETENTION_DAYS = 14;
const RETENTION_MS = RETENTION_DAYS * 24 * 3600 * 1000;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'shots-capture.js');
const SITE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const PAGE_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/;

/** The pages of a service: the inventory's own list, or the home page. */
function pagesOf(inv, id) {
    const entry = inv && inv.services && inv.services[id];
    const list = entry && entry.shots && Array.isArray(entry.shots.pages) ? entry.shots.pages : [];
    return list.length ? list.slice() : ['/'];
}

/** The capture plan: one target per page and viewport. */
function plan(inv, { services = null, pages = null } = {}) {
    const ids = services && services.length ? services : Object.keys((inv && inv.services) || {});
    const out = [];
    for (const id of ids) {
        if (!SITE_RE.test(id)) continue;
        const origin = originOf(inv, id, null);
        if (!origin) continue;
        let list = pages && pages.length ? pages : pagesOf(inv, id);
        list = list.filter((p) => PAGE_RE.test(String(p)));
        if (!list.length) continue;
        for (const p of list) {
            for (const v of VIEWPORTS) out.push({ service: id, origin, path: p, viewport: v.name, width: v.width, height: v.height });
        }
    }
    return out;
}

/**
 * Chrome, as the unprivileged account (Chrome never runs as root). The capture script writes the PNGs
 * into a temp directory and prints what it took; the parent hashes and uploads them.
 */
function captureWithChrome(targets, { asUser = 'ovcheck', home = '/var/lib/ovcheck', timeoutMs = 15 * 60 * 1000, spawnFn = spawn } = {}) {
    return new Promise((resolve) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-shots-'));
        const targetsFile = path.join(dir, 'targets.json');
        const outDir = path.join(dir, 'png');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(targetsFile, JSON.stringify(targets));
        // Chrome runs as asUser, and mkdtemp made the folder root's own (0700): hand the folder to that account,
        // still 0700, so it can read the targets and write the PNGs; root reads them back, nobody else can.
        if (asUser && process.getuid && process.getuid() === 0) {
            try {
                const ids = (flag) => Number(String(execFileSync('id', [flag, asUser])).trim());
                const uid = ids('-u'), gid = ids('-g');
                for (const p of [dir, targetsFile, outDir]) fs.chownSync(p, uid, gid);
            } catch (e) {
                fs.rmSync(dir, { recursive: true, force: true });
                resolve({ shots: [], error: `cannot hand the capture folder to ${asUser}: ${e.message}` });
                return;
            }
        }
        const argv = [SCRIPT, '--targets', targetsFile, '--out', outDir];
        const child = asUser
            ? spawnFn('runuser', ['-u', asUser, '--', 'env', `HOME=${home || '/tmp'}`, process.execPath, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
            : spawnFn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        const timer = setTimeout(() => { err += '\ntimed out'; child.kill('SIGKILL'); }, timeoutMs);
        child.on('error', (e) => { clearTimeout(timer); resolve({ shots: [], error: e.message }); });
        child.on('close', (code) => {
            clearTimeout(timer);
            let parsed = null;
            try { parsed = JSON.parse(out.split('\n').filter((l) => l.trim().startsWith('{')).pop() || 'null'); } catch { parsed = null; }
            const shots = [];
            for (const s of (parsed && parsed.shots) || []) {
                try {
                    const data = fs.readFileSync(s.file);
                    shots.push({ ...s, data, hash: crypto.createHash('sha256').update(data).digest('hex') });
                } catch { /* the file the capture wrote is not there: the shot is lost */ }
            }
            fs.rmSync(dir, { recursive: true, force: true });
            resolve({ shots, error: code === 0 || shots.length ? null : (err.split('\n').filter(Boolean).pop() || `the capture exited ${code}`) });
        });
    });
}

/** The shots to prune: older than the retention, per page and viewport. */
function expired(shots, now = Date.now()) {
    return shots.filter((s) => {
        const at = Date.parse((s.metadata && s.metadata.captured_at) || s.created_at || 0);
        if (!Number.isFinite(at)) return false;
        return now - at > RETENTION_MS;
    });
}

/**
 * One pass: capture, upload, prune.
 * opts: services, pages, now, capture (the capture function; tests pass a fake one), media (the Media
 * client), asUser, home, dryRun.
 */
async function shots(ctx, {
    services = null, pages = null, now = Date.now(), capture = captureWithChrome,
    media = null, asUser = 'ovcheck', home = '/var/lib/ovcheck', dryRun = false, log = () => {},
} = {}) {
    const { exec, inv } = ctx;
    const targets = plan(inv, { services, pages });
    if (!targets.length) return { captured: 0, uploaded: 0, pruned: 0, targets: [], reason: 'no service to capture' };

    // The release each service is on: the key of the shot (the same key the browser check uses).
    const releases = {};
    for (const t of targets) if (releases[t.service] === undefined) {
        const r = await currentRelease(exec, t.origin);
        releases[t.service] = r || 'unknown';
    }

    const captured = await capture(targets, { asUser, home });
    const taken = (captured.shots || []).map((s) => ({
        ...s,
        release: releases[s.service] || 'unknown',
        captured_at: new Date(now).toISOString(),
    }));

    const uploaded = [];
    if (!dryRun && media) {
        for (const s of taken) {
            if (!s.data) continue;
            const metadata = {
                service: s.service, path: s.path, viewport: s.viewport,
                width: s.width, height: s.height, release: s.release,
                hash: s.hash, captured_at: s.captured_at, source: 'ovhost shots',
            };
            try {
                const r = await media.uploadPng({ data: s.data, metadata });
                uploaded.push({ ...s, id: r.id });
            } catch (err) {
                log(`the shot of ${s.service}${s.path} at ${s.viewport} was not stored: ${err.message}`);
            }
        }
    }

    let pruned = [];
    if (!dryRun && media) {
        try {
            const all = await media.listAll({ kind: 'screenshot' });
            for (const o of expired(all, now)) {
                try { await media.remove(o.id); pruned.push(o.id); } catch { /* the object stays */ }
            }
        } catch (err) {
            log(`the shots were not pruned: ${err.message}`);
        }
    }

    return {
        captured: taken.length,
        uploaded: uploaded.length,
        pruned: pruned.length,
        releases,
        shots: uploaded.map((s) => ({ service: s.service, path: s.path, viewport: s.viewport, release: s.release, id: s.id, hash: s.hash })),
        error: captured.error || null,
    };
}

/** The Media client of this host, from the credentials in the env file (the secret never leaves it). */
async function mediaFor(ctx, { env = {} } = {}) {
    const { loadCredentials, createMedia } = require('./media');
    const creds = await loadCredentials(ctx.exec, ctx.inv, { env });
    if (creds.error) return { media: null, error: creds.error };
    return {
        media: createMedia({ clientId: creds.clientId, secret: creds.secret, networkUrl: creds.networkUrl, mediaUrl: creds.mediaUrl }),
        error: null,
    };
}

module.exports = { shots, plan, pagesOf, expired, captureWithChrome, mediaFor, VIEWPORTS, RETENTION_DAYS, RETENTION_MS, SCRIPT };
