'use strict';
/**
 * Backup retention: which dated backups to keep. Pure functions over stamps (YYYYMMDD-HHMMSS, UTC),
 * so the policy is tested on its own.
 *
 * keep(): the newest backup of each of the last `daily` distinct days that have a backup, and the
 * newest backup of each of the last `weekly` distinct ISO weeks that have one. Days and weeks
 * without a backup do not use up a slot, so a service whose backups have been failing for a month
 * still keeps its last good ones.
 */
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

function parseStamp(s) {
    const m = STAMP_RE.exec(String(s));
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return Number.isFinite(ms) ? ms : null;
}

/** ISO-8601 week key, e.g. "2026-W39". */
function isoWeek(ms) {
    const d = new Date(ms);
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
    // The ISO week is the one holding that week's Thursday, numbered by the Thursday's day of year.
    const week = Math.floor((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86400000 / 7) + 1;
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function keep(stamps, { daily = 7, weekly = 4 } = {}) {
    const sorted = [...new Set(stamps)].filter((s) => parseStamp(s) !== null).sort().reverse();
    const kept = new Set();
    const days = new Set();
    const weeks = new Set();
    for (const s of sorted) {
        const day = s.slice(0, 8);
        const week = isoWeek(parseStamp(s));
        if (!days.has(day) && days.size < daily) { days.add(day); kept.add(s); }
        if (!weeks.has(week) && weeks.size < weekly) { weeks.add(week); kept.add(s); }
    }
    return kept;
}

module.exports = { keep, parseStamp, isoWeek, STAMP_RE };
