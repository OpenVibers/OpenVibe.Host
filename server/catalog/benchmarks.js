'use strict';
/**
 * Benchmarks people run on their own servers (migrations/0012_catalog_benchmarks.sql). A signed-in person asks for a
 * one-time link naming the provider (and plan) they are testing; YABS (Yet Another Bench Script, `-s <url>`) posts its
 * JSON result to that link; Host keeps the measurements and shows them per provider and plan.
 *
 *   parseYabs(body)                       YABS's JSON → the stored fields, or throws ApiError 400
 *   createBenchmarks({ store, baseUrl })  → { createLink, submit, list, get, summary, remove, ready }
 *
 * A link works once, for 24 hours; a person gets 10 a day. The server's address is never stored: YABS's own lookup gives
 * the city and network, which are kept. Until 0012 has applied (a held contract migration holds it), reads answer empty
 * and `ready()` is false.
 */
const crypto = require('crypto');
const { newId } = require('../ids');
const { ApiError } = require('../http/errors');

const LINK_TTL_MS = 24 * 3600_000;
const LINKS_PER_DAY = 10;
const PAGE = 50;
const YABS_COMMAND = (url) => `curl -sL https://yabs.sh | bash -s -- -s "${url}"`;

const bad = (message) => { throw new ApiError(400, 'host.benchmark.invalid', message); };
const invalid = (message) => { throw new ApiError(422, 'host.catalog.invalid', message); };
const missingTable = (err) => err && err.code === '42P01';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null);
const numberIn = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const int = (v, max) => { const n = numberIn(v, max); return n == null ? null : Math.round(n); };
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
// fio reports KB/s; pages show MB/s.
const mbps = (v) => { const n = numberIn(v, 1e9); return n == null ? null : round(n / 1000); };

/** YABS's JSON (yabs.sh builds it by hand, so every field is checked): CPU, memory, disk, fio, iperf3, Geekbench. */
function parseYabs(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('This is not a YABS result.');
    const version = text(body.version, 40);
    if (!version || !/^v\d{4}-\d{2}-\d{2}/.test(version)) bad('This is not a YABS result (no YABS version).');
    const cpu = body.cpu && typeof body.cpu === 'object' ? body.cpu : {};
    const os = body.os && typeof body.os === 'object' ? body.os : {};
    const mem = body.mem && typeof body.mem === 'object' ? body.mem : {};
    const ip = body.ip_info && typeof body.ip_info === 'object' ? body.ip_info : {};
    const fio = (Array.isArray(body.fio) ? body.fio : []).slice(0, 8).filter((f) => f && typeof f === 'object' && /^\d+[km]$/.test(String(f.bs || ''))).map((f) => ({
        bs: String(f.bs),
        read_mbps: mbps(f.speed_r), write_mbps: mbps(f.speed_w), total_mbps: mbps(f.speed_rw),
        read_iops: int(f.iops_r, 1e9), write_iops: int(f.iops_w, 1e9), total_iops: int(f.iops_rw, 1e9),
    }));
    const iperf = (Array.isArray(body.iperf) ? body.iperf : []).slice(0, 24).filter((x) => x && typeof x === 'object').map((x) => ({
        mode: text(x.mode, 10), provider: text(x.provider, 60), location: text(x.loc, 60), send: text(x.send, 30), recv: text(x.recv, 30), latency: text(x.latency, 30),
    })).filter((x) => x.provider || x.location);
    const gb = (Array.isArray(body.geekbench) ? body.geekbench : []).filter((g) => g && typeof g === 'object' && int(g.version, 99) != null && (int(g.single, 1e7) != null || int(g.multi, 1e8) != null))
        .sort((a, b) => b.version - a.version)[0] || null;
    if (!fio.length && !iperf.length && !gb) bad('The result has no disk, network or Geekbench test in it.');
    const at = (bs) => fio.find((f) => f.bs === bs);
    const kib = (v) => numberIn(v, 1e13);
    const gbUrl = gb && typeof gb.url === 'string' && /^https:\/\/browser\.geekbench\.com\/v\d+\/cpu\/\d+$/.test(gb.url.trim()) ? gb.url.trim() : null;
    return {
        tool: 'yabs', tool_version: version,
        cpu_model: text(cpu.model, 200), cpu_cores: int(cpu.cores, 4096), cpu_freq: text(cpu.freq, 40), aes: typeof cpu.aes === 'boolean' ? cpu.aes : null,
        virt: text(os.vm, 40), arch: text(os.arch, 20), distro: text(os.distro, 100),
        ram_mb: kib(mem.ram) == null ? null : round(kib(mem.ram) / 1024, 0), swap_mb: kib(mem.swap) == null ? null : round(kib(mem.swap) / 1024, 0),
        disk_gb: kib(mem.disk) == null ? null : round(kib(mem.disk) / 1048576, 1),
        city: text(ip.city, 80), region: text(ip.region, 80), country: text(ip.country, 80), network: text(ip.org, 120) || text(ip.isp, 120),
        gb_version: gb ? int(gb.version, 99) : null, gb_single: gb ? int(gb.single, 1e7) : null, gb_multi: gb ? int(gb.multi, 1e8) : null, gb_url: gbUrl,
        disk_4k_iops: at('4k') ? at('4k').total_iops : null, disk_4k_mbps: at('4k') ? at('4k').total_mbps : null, disk_1m_mbps: at('1m') ? at('1m').total_mbps : null,
        fio: fio.length ? fio : null, iperf: iperf.length ? iperf : null,
        elapsed_s: body.runtime && typeof body.runtime === 'object' ? int(body.runtime.elapsed, 86400 * 7) : null,
    };
}

const SORTS = {
    new: 'b.created_at DESC, b.id DESC',
    gb_single: 'b.gb_single DESC NULLS LAST, b.created_at DESC, b.id DESC',
    gb_multi: 'b.gb_multi DESC NULLS LAST, b.created_at DESC, b.id DESC',
    disk: 'b.disk_4k_iops DESC NULLS LAST, b.created_at DESC, b.id DESC',
};

function createBenchmarks({ store, baseUrl }) {
    const db = store.db;
    let isReady = null;
    async function ready() {
        if (isReady) return true;
        const r = await db.prepare("SELECT to_regclass('catalog_benchmarks') AS t").get();
        isReady = Boolean(r && r.t);
        return isReady;
    }
    async function safe(fn, fallback) {
        try { return await fn(); } catch (err) { if (missingTable(err)) { isReady = false; return fallback; } throw err; }
    }

    /** A one-time submit link for `person`, naming a catalog provider (by slug) or another provider by name, and a plan. */
    async function createLink(person, input = {}) {
        if (!person) throw new ApiError(401, 'host.benchmark.sign_in', 'Sign in to submit a benchmark');
        if (!(await ready())) throw new ApiError(503, 'host.benchmark.unavailable', 'Benchmarks open after the next maintenance');
        const now = store.now();
        const recent = await db.prepare('SELECT COUNT(*) AS n FROM catalog_bench_links WHERE person = ? AND created_at > ?').get(person, now - 86400_000);
        if (Number(recent.n) >= LINKS_PER_DAY) throw new ApiError(429, 'host.benchmark.too_many', `At most ${LINKS_PER_DAY} benchmark links a day`);
        let provider = null;
        let plan = null;
        if (input.plan_id) {
            plan = await db.prepare("SELECT p.id, p.provider_id, v.name FROM catalog_plans p JOIN catalog_providers v ON v.id = p.provider_id WHERE p.id = ? AND p.status = 'active' AND v.status = 'active'").get(String(input.plan_id));
            if (!plan) invalid('That plan is not in the catalog');
            provider = { id: plan.provider_id, name: plan.name };
        } else if (input.provider) {
            const row = await db.prepare("SELECT id, name FROM catalog_providers WHERE slug = ? AND status = 'active'").get(String(input.provider));
            if (!row) invalid('That provider is not in the catalog');
            provider = row;
        }
        const name = provider ? provider.name : text(input.provider_name, 80);
        if (!name) invalid('Name the provider you are testing');
        const note = text(input.note, 200);
        const token = crypto.randomBytes(24).toString('base64url');
        await db.prepare('INSERT INTO catalog_bench_links (token_hash, person, provider_id, provider_name, plan_id, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(sha(token), person, provider ? provider.id : null, name, plan ? plan.id : null, note, now, now + LINK_TTL_MS);
        const url = `${baseUrl}/api/v1/catalog/benchmarks/yabs/${token}`;
        return { url, command: YABS_COMMAND(url), provider_name: name, plan_id: plan ? plan.id : null, expires_at: new Date(now + LINK_TTL_MS).toISOString() };
    }

    // A link YABS can still post to, or the reason it cannot.
    function usable(link, now) {
        if (!link) throw new ApiError(404, 'host.benchmark.link_unknown', 'This benchmark link is not known');
        if (link.used_at != null) throw new ApiError(410, 'host.benchmark.link_used', 'This link was already used: ask for a new one at openvibe.host/catalog/benchmarks/new');
        if (Number(link.expires_at) <= now) throw new ApiError(410, 'host.benchmark.link_expired', 'This link has expired: ask for a new one at openvibe.host/catalog/benchmarks/new');
        return link;
    }
    const tokenOk = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token);

    /** Before reading a posted body: the link exists, is unused and unexpired. */
    async function checkLink(token) {
        if (!tokenOk(token)) usable(null);
        const link = await safe(() => db.prepare('SELECT used_at, expires_at FROM catalog_bench_links WHERE token_hash = ?').get(sha(token)), null);
        usable(link, store.now());
    }

    /** YABS posts here: the link is spent and the result stored, or nothing happens. Returns the new result's page. */
    async function submit(token, body) {
        if (!tokenOk(token)) usable(null);
        const v = parseYabs(body);
        const now = store.now();
        const id = newId('catalogBenchmark', now);
        await db.tx(async (t) => {
            const link = usable(await t.prepare('SELECT * FROM catalog_bench_links WHERE token_hash = ? FOR UPDATE').get(sha(token)), now);
            await t.prepare('UPDATE catalog_bench_links SET used_at = ? WHERE token_hash = ?').run(now, link.token_hash);
            const row = {
                id, provider_id: link.provider_id, provider_name: link.provider_name, plan_id: link.plan_id, note: link.note, submitted_by: link.person,
                ...v, fio: v.fio ? JSON.stringify(v.fio) : null, iperf: v.iperf ? JSON.stringify(v.iperf) : null, status: 'active', created_at: now, updated_at: now,
            };
            await t.prepare(`INSERT INTO catalog_benchmarks (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((k) => (k === 'fio' || k === 'iperf' ? '?::jsonb' : '?')).join(', ')})`).run(...Object.values(row));
        });
        return { id, url: `${baseUrl}/catalog/benchmarks/${id}` };
    }

    const out = (b) => ({
        ...b, ram_mb: b.ram_mb == null ? null : Number(b.ram_mb), swap_mb: b.swap_mb == null ? null : Number(b.swap_mb), disk_gb: b.disk_gb == null ? null : Number(b.disk_gb),
        disk_4k_iops: b.disk_4k_iops == null ? null : Number(b.disk_4k_iops), disk_4k_mbps: b.disk_4k_mbps == null ? null : Number(b.disk_4k_mbps), disk_1m_mbps: b.disk_1m_mbps == null ? null : Number(b.disk_1m_mbps),
        fio: typeof b.fio === 'string' ? JSON.parse(b.fio) : b.fio, iperf: typeof b.iperf === 'string' ? JSON.parse(b.iperf) : b.iperf,
        created_at: new Date(Number(b.created_at)).toISOString(), updated_at: undefined, submitted_by: undefined,
    });
    const SELECT = `SELECT b.*, v.slug AS provider_slug, p.name AS plan_name FROM catalog_benchmarks b
        LEFT JOIN catalog_providers v ON v.id = b.provider_id AND v.status = 'active' LEFT JOIN catalog_plans p ON p.id = b.plan_id AND p.status = 'active'`;

    async function list(query = {}) {
        const allowed = new Set(['sort', 'provider', 'plan', 'cursor']);
        for (const k of Object.keys(query)) if (!allowed.has(k) || Array.isArray(query[k])) invalid(`Invalid filter: ${k}`);
        const sort = query.sort || 'new';
        if (!SORTS[sort]) invalid('Invalid sort');
        const offset = query.cursor == null || query.cursor === '' ? 0 : Number(query.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) invalid('Invalid cursor');
        let where = "b.status = 'active'";
        const args = [];
        if (query.provider) { where += ' AND (v.slug = ? OR lower(b.provider_name) = lower(?))'; args.push(String(query.provider), String(query.provider)); }
        if (query.plan) { where += ' AND b.plan_id = ?'; args.push(String(query.plan)); }
        return await safe(async () => {
            const rows = await db.prepare(`${SELECT} WHERE ${where} ORDER BY ${SORTS[sort]} LIMIT ${PAGE + 1} OFFSET ${offset}`).all(...args);
            return { benchmarks: rows.slice(0, PAGE).map(out), next_cursor: rows.length > PAGE ? String(offset + PAGE) : null };
        }, { benchmarks: [], next_cursor: null });
    }

    async function get(id, viewer = null) {
        const row = await safe(() => db.prepare(`${SELECT} WHERE b.id = ? AND b.status = 'active'`).get(String(id)), null);
        if (!row) throw new ApiError(404, 'host.catalog.not_found', 'No such benchmark');
        return { ...out(row), mine: Boolean(viewer && viewer.subject && viewer.subject === row.submitted_by) };
    }

    /** The medians for a provider or a plan (a provider page's and a plan page's line). */
    async function summary({ providerId, planId }) {
        const [col, val] = planId ? ['b.plan_id', planId] : ['b.provider_id', providerId];
        return await safe(async () => {
            const r = await db.prepare(`SELECT COUNT(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY b.gb_single) AS gb_single, percentile_cont(0.5) WITHIN GROUP (ORDER BY b.gb_multi) AS gb_multi,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY b.disk_4k_iops) AS disk_4k_iops, MAX(b.gb_version) AS gb_version, MAX(b.created_at) AS latest
                FROM catalog_benchmarks b WHERE ${col} = ? AND b.status = 'active'`).get(val);
            const n = Number(r.n) || 0;
            return n ? { count: n, gb_single: r.gb_single == null ? null : Math.round(Number(r.gb_single)), gb_multi: r.gb_multi == null ? null : Math.round(Number(r.gb_multi)),
                disk_4k_iops: r.disk_4k_iops == null ? null : Math.round(Number(r.disk_4k_iops)), gb_version: r.gb_version == null ? null : Number(r.gb_version), latest: new Date(Number(r.latest)).toISOString() } : { count: 0 };
        }, { count: 0 });
    }

    /** The person who submitted a result, or staff, takes it down. */
    async function remove(id, viewer) {
        const row = await db.prepare("SELECT submitted_by FROM catalog_benchmarks WHERE id = ? AND status = 'active'").get(String(id));
        if (!row) throw new ApiError(404, 'host.catalog.not_found', 'No such benchmark');
        if (!viewer || viewer.kind !== 'user' || !(viewer.staff || viewer.subject === row.submitted_by)) throw new ApiError(403, 'host.catalog.forbidden', 'Only the person who submitted it, or staff, can remove it');
        await db.prepare("UPDATE catalog_benchmarks SET status = 'hidden', updated_at = ? WHERE id = ?").run(store.now(), String(id));
    }

    return { createLink, checkLink, submit, list, get, summary, remove, ready, SORTS: Object.keys(SORTS) };
}

module.exports = { parseYabs, createBenchmarks, YABS_COMMAND, LINK_TTL_MS, LINKS_PER_DAY };
