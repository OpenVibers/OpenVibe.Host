'use strict';
/**
 * Certificate inventory: every `ssl_certificate` referenced by an enabled nginx vhost, with its
 * subject, names, issuer and expiry. Only certificate blocks are ever parsed; `ssl_certificate_key`
 * lines are never followed, a path that looks like a key is refused, and a combined PEM file has
 * everything except its CERTIFICATE blocks discarded before parsing. No key material is read into
 * output, logs or records.
 */
const crypto = require('crypto');
const path = require('path');

const CERT_LINE_RE = /^\s*ssl_certificate\s+("?)([^";\s]+)\1\s*;/gm;
const KEY_PATH_RE = /(privkey|private|\.key$)/i;
const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

function referencedCerts(vhostText) {
    const out = [];
    let m;
    CERT_LINE_RE.lastIndex = 0;
    while ((m = CERT_LINE_RE.exec(vhostText))) out.push(m[2]);
    return out;
}

/** X509Certificate subjects are newline-separated "K=V" lines. */
function field(dn, key) {
    const m = String(dn || '').match(new RegExp(`(?:^|\\n)${key}=([^\\n]+)`));
    return m ? m[1] : null;
}

function describe(pem, now) {
    const block = pem.match(CERT_BLOCK_RE);
    if (!block) return { error: 'no CERTIFICATE block' };
    const x = new crypto.X509Certificate(block[0]);
    const notAfter = new Date(x.validTo);
    const daysLeft = Math.floor((notAfter.getTime() - now) / 86400000);
    const cn = field(x.subject, 'CN');
    const issuer = [field(x.issuer, 'O'), field(x.issuer, 'CN')].filter(Boolean).join(' ');
    const names = (x.subjectAltName || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean);
    return { subject: cn, names, issuer, notBefore: new Date(x.validFrom).toISOString(), notAfter: notAfter.toISOString(), daysLeft, fingerprint256: x.fingerprint256 };
}

async function inventory(exec, inv, { warnDays = 21 } = {}) {
    const entries = (await exec.readdir(inv.nginx.sitesEnabled)) || [];
    const byPath = new Map();
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(inv.nginx.sitesEnabled, e.name);
        const text = await exec.readFile(file, { privileged: true });
        if (text == null) continue;
        for (const p of referencedCerts(text)) (byPath.get(p) || byPath.set(p, []).get(p)).push(e.name);
    }
    const now = exec.now();
    const certs = [];
    for (const [certPath, vhosts] of byPath) {
        const row = { path: certPath, vhosts };
        if (certPath.includes('$')) { row.status = 'dynamic'; row.error = 'path uses an nginx variable'; certs.push(row); continue; }
        if (KEY_PATH_RE.test(path.basename(certPath))) { row.status = 'refused'; row.error = 'looks like a key file; not read'; certs.push(row); continue; }
        const pem = await exec.readFile(certPath, { privileged: true });
        if (pem == null) { row.status = 'missing'; row.error = 'file not found'; certs.push(row); continue; }
        try {
            Object.assign(row, describe(pem, now));
            row.status = row.error ? 'unreadable' : row.daysLeft < 0 ? 'expired' : row.daysLeft < warnDays ? 'expiring' : 'ok';
        } catch (err) {
            row.status = 'unreadable';
            row.error = err.message;
        }
        certs.push(row);
    }
    return certs;
}

module.exports = { inventory, referencedCerts, describe };
