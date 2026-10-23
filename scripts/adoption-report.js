#!/usr/bin/env node
'use strict';
/**
 * The adoption report (plan 2026-10-22, track C1): the numbers that say whether people use OpenVibe, read from
 * production once a week. Read-only: every figure is one SELECT, run as the postgres OS user over peer auth (as
 * ovhost reads databases), and no row about a person is printed, only counts.
 *
 *   sudo node scripts/adoption-report.js [--days 7] [--json]
 *
 * What it reads, for the last --days (default 7) and the 30 days before now:
 *   Live       streams started and streamers; new streamers and how their first stream went live (browser or
 *              OBS/RTMP) and how long it ran; of the people whose first stream was 14 to 44 days ago, how many
 *              streamed again within 14 days (the go-live funnel's retention, plan C2)
 *   Network    new accounts (not anonymous, not deleted)
 *   Money      settled tips that were not tests, Tips creator profiles, VIP creators and memberships, active
 *              subscriptions in Billing
 *   Platform   paired Nodes (not revoked; seen in the window), Zone zones, Inventory owners (people holding an item)
 * The Companion's installs are not measured anywhere (the stores report them; owner, plan D2).
 * A database or table that does not answer prints "n/a" with the reason; the rest of the report still prints.
 */
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const DAYS = Math.max(1, Math.min(90, Number(opt('--days', 7)) || 7));

/** Rows of one SELECT (psql --csv: a header line, then one line per row; the selected values hold no commas). */
function rows(db, sql) {
    const out = execFileSync('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--csv', '-d', db, '-c', sql],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    const [head, ...lines] = out.trim().split('\n');
    const cols = head.split(',');
    return lines.filter(Boolean).map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
}
function one(db, sql) {
    try { return rows(db, sql)[0] || {}; } catch (e) { return { error: String(e.stderr || e.message).trim().split('\n')[0].slice(0, 160) }; }
}
function many(db, sql) {
    try { return rows(db, sql); } catch (e) { return [{ error: String(e.stderr || e.message).trim().split('\n')[0].slice(0, 160) }]; }
}

// Live and most services store times as text ('YYYY-MM-DD HH:MM:SS' or ISO): compared as text, to the second for
// Live's own format and by day elsewhere (both formats sort the same on their first 10 characters).
const since = (days) => `to_char(now() - interval '${days} days', 'YYYY-MM-DD HH24:MI:SS')`;
const sinceDay = (days) => `to_char(now() - interval '${days} days', 'YYYY-MM-DD')`;

function report() {
    const r = { generated_at: new Date().toISOString(), days: DAYS };
    // ── Live ──
    r.live = {};
    for (const d of [DAYS, 30]) {
        r.live[`last_${d}_days`] = one('ov_live', `SELECT count(*) AS streams, count(DISTINCT user_id) AS streamers FROM streams WHERE started_at >= ${since(d)}`);
    }
    const firsts = `WITH firsts AS (SELECT DISTINCT ON (user_id) user_id, id, started_at, protocol, duration_seconds FROM streams ORDER BY user_id, started_at, id)`;
    r.live.new_streamers = one('ov_live', `${firsts}
        SELECT count(*) AS total,
               count(*) FILTER (WHERE protocol = 'webrtc') AS browser,
               count(*) FILTER (WHERE protocol = 'rtmp') AS rtmp,
               count(*) FILTER (WHERE protocol NOT IN ('webrtc', 'rtmp')) AS other,
               count(*) FILTER (WHERE coalesce(duration_seconds, 0) < 60) AS under_1_min,
               count(*) FILTER (WHERE duration_seconds >= 60 AND duration_seconds < 600) AS from_1_to_10_min,
               count(*) FILTER (WHERE duration_seconds >= 600) AS over_10_min
          FROM firsts WHERE started_at >= ${since(30)}`);
    // Why the short ones ended (Live's streams.end_reason since Live#327; n/a before it).
    r.live.short_first_stream_endings = many('ov_live', `${firsts.replace('protocol, duration_seconds', 'protocol, duration_seconds, end_reason')}
        SELECT coalesce(end_reason, 'unknown') AS reason, count(*) AS n FROM firsts
         WHERE started_at >= ${since(30)} AND coalesce(duration_seconds, 0) < 60 GROUP BY 1 ORDER BY 2 DESC`);
    r.live.returned_within_14_days = one('ov_live', `${firsts}
        SELECT count(*) AS cohort,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM streams s WHERE s.user_id = f.user_id AND s.id <> f.id AND s.started_at > f.started_at
                                               AND s.started_at < to_char(f.started_at::timestamp + interval '14 days', 'YYYY-MM-DD HH24:MI:SS'))) AS returned
          FROM firsts f WHERE f.started_at >= ${since(44)} AND f.started_at < ${since(14)}`);
    // ── Network ──
    r.network = {};
    for (const d of [DAYS, 30]) {
        r.network[`new_accounts_${d}_days`] = one('ov_network', `SELECT count(*) AS n FROM users
            WHERE left(created_at, 10) >= ${sinceDay(d)} AND coalesce(is_anon, 0) = 0 AND deleted_at IS NULL AND merged_into IS NULL`).n;
    }
    // ── Money ──
    r.money = {
        tips_30_days: one('ov_tips', `SELECT count(*) AS settled, coalesce(sum(amount_cents), 0) AS cents, count(DISTINCT creator_subject) AS creators
            FROM tip_interactions WHERE NOT test AND payment_state = 'settled' AND created_at >= now() - interval '30 days'`),
        tip_profiles: one('ov_tips', 'SELECT count(*) AS n FROM creator_tip_profiles').n,
        vip_creators: one('ov_vip', 'SELECT count(*) AS n FROM vip_creators').n,
        vip_memberships_30_days: one('ov_vip', `SELECT count(*) AS n FROM vip_memberships WHERE left(joined_at, 10) >= ${sinceDay(30)}`).n,
        billing_subscriptions_active: one('ov_billing', "SELECT count(*) AS n FROM subscriptions WHERE status = 'active'").n,
    };
    // ── Platform ──
    r.platform = {
        nodes: one('ov_bot', `SELECT count(*) AS paired, count(*) FILTER (WHERE last_seen >= now() - interval '${DAYS} days') AS seen
            FROM devices WHERE revoked_at IS NULL`),
        zones: one('ov_zone', "SELECT count(*) AS n FROM zone_zones WHERE deletion_requested_at IS NULL").n,
        // A person's subject is usr_<ULID> (service-held items would carry another prefix).
        inventory_owners: one('ov_inventory', "SELECT count(DISTINCT owner_subject) AS n FROM inventory_instances WHERE owner_subject LIKE 'usr\\_%' AND state = 'owned'").n,
        companion_installs: 'not measured (the Chrome and Firefox stores report installs once the Companion is listed)',
    };
    return r;
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '-');
const val = (v) => (v == null ? 'n/a' : typeof v === 'object' && v.error ? `n/a (${v.error})` : v);

function markdown(r) {
    const L = [];
    const lw = r.live[`last_${r.days}_days`] || {}, lm = r.live.last_30_days || {}, ns = r.live.new_streamers || {}, rt = r.live.returned_within_14_days || {};
    L.push(`# OpenVibe adoption, ${r.generated_at.slice(0, 10)}`, '');
    L.push('| | Last ' + r.days + ' days | Last 30 days |', '|---|---|---|');
    L.push(`| Streams started | ${val(lw.streams)} | ${val(lm.streams)} |`);
    L.push(`| Streamers | ${val(lw.streamers)} | ${val(lm.streamers)} |`);
    L.push(`| New accounts (Network) | ${val(r.network[`new_accounts_${r.days}_days`])} | ${val(r.network.new_accounts_30_days)} |`, '');
    if (ns.error) L.push(`New streamers: n/a (${ns.error})`, '');
    else {
        L.push(`**New streamers, last 30 days: ${ns.total}.** First stream from the browser ${ns.browser}, OBS/RTMP ${ns.rtmp}, other ${ns.other}.`);
        L.push(`It ran under a minute for ${ns.under_1_min}, 1 to 10 minutes for ${ns.from_1_to_10_min}, longer for ${ns.over_10_min}.`, '');
    }
    const ends = r.live.short_first_stream_endings || [];
    L.push(ends.length && ends[0].error ? `Why short first streams ended: n/a (${ends[0].error})` : `Why first streams under a minute ended: ${ends.map((e) => `${e.reason} ${e.n}`).join(', ') || 'none'}.`, '');
    L.push(rt.error ? `Returned within 14 days: n/a (${rt.error})` : `**Streamed again within 14 days:** ${rt.returned} of the ${rt.cohort} people whose first stream was 14 to 44 days ago (${pct(rt.returned, rt.cohort)}).`, '');
    const t = r.money.tips_30_days || {};
    L.push('**Money.**');
    L.push(`- Tips settled in 30 days (not tests): ${t.error ? `n/a (${t.error})` : `${t.settled}, $${(t.cents / 100).toFixed(2)}, to ${t.creators} creator(s)`}.`);
    L.push(`- Tip pages: ${val(r.money.tip_profiles)}. VIP creators: ${val(r.money.vip_creators)}; memberships joined in 30 days: ${val(r.money.vip_memberships_30_days)}. Active Billing subscriptions: ${val(r.money.billing_subscriptions_active)}.`, '');
    const n = r.platform.nodes || {};
    L.push('**Platform.**');
    L.push(`- Paired Nodes: ${n.error ? `n/a (${n.error})` : `${n.paired}, ${n.seen} seen in ${r.days} days`}. Zones: ${val(r.platform.zones)}. People holding an Inventory item: ${val(r.platform.inventory_owners)}.`);
    L.push(`- Companion installs: ${r.platform.companion_installs}.`);
    return L.join('\n');
}

const r = report();
process.stdout.write(flag('--json') ? `${JSON.stringify(r, null, 2)}\n` : `${markdown(r)}\n`);
