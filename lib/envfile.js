'use strict';
/**
 * Environment files, NAMES ONLY. parseNames() reads KEY=value lines and returns { name, empty } —
 * the value is looked at just long enough to know whether it is empty and is never returned,
 * logged or stored. Nothing in ovhost has a code path that prints an env value.
 */
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const SECRET_NAME_RE = /(SECRET|PASSWORD|PASSWD|PASS$|TOKEN|KEY|CREDENTIAL|PRIVATE|COOKIE|SALT|DSN)/i;

function isEmptyValue(raw) {
    let v = raw.trim();
    if (!v.startsWith('"') && !v.startsWith("'")) v = v.replace(/(^|\s+)#.*$/, '');
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    return v.trim() === '';
}

function parseNames(text) {
    const seen = new Map();
    for (const line of String(text || '').split('\n')) {
        const m = line.match(LINE_RE);
        if (!m) continue;
        seen.set(m[1], { name: m[1], empty: isEmptyValue(m[2]) });
    }
    return [...seen.values()];
}

/** Names a .env.example declares (uncommented lines) and names it only mentions in comments. */
function parseExample(text) {
    const declared = [];
    const commented = [];
    for (const line of String(text || '').split('\n')) {
        let m = line.match(LINE_RE);
        if (m) { if (!declared.includes(m[1])) declared.push(m[1]); continue; }
        m = line.match(/^\s*#\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
        if (m && !commented.includes(m[1])) commented.push(m[1]);
    }
    return { declared, commented: commented.filter((n) => !declared.includes(n)) };
}

/** Environment=A=1 "B=two words" lines in a unit file -> names. */
function unitEnvironmentNames(unitText) {
    const names = [];
    for (const line of String(unitText || '').split('\n')) {
        const m = line.match(/^\s*Environment=(.*)$/);
        if (!m) continue;
        for (const part of splitAssignments(m[1])) {
            const n = part.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
            if (n && !names.includes(n[1])) names.push(n[1]);
        }
    }
    return names;
}

function splitAssignments(s) {
    const out = [];
    let cur = '';
    let quote = null;
    for (const ch of s) {
        if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (/\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

/**
 * Unit text with the value of every secret-looking Environment= assignment replaced by <redacted>.
 * Used by snapshots: unit files are config worth keeping, but an operator may have put a secret
 * straight into a unit instead of the EnvironmentFile.
 */
function redactUnit(unitText) {
    return String(unitText || '').split('\n').map((line) => {
        const m = line.match(/^(\s*Environment=)(.*)$/);
        if (!m) return line;
        const parts = splitAssignments(m[2]).map((a) => {
            const i = a.indexOf('=');
            if (i < 0) return a;
            const name = a.slice(0, i);
            return SECRET_NAME_RE.test(name) ? `${name}=<redacted>` : a;
        });
        return `${m[1]}${parts.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')}`;
    }).join('\n');
}

module.exports = { parseNames, parseExample, unitEnvironmentNames, redactUnit, SECRET_NAME_RE };
