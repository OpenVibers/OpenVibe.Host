'use strict';
/**
 * Certificate lifecycle (operator plane, `ovhost certs renew`).
 *
 * certbot stays outside the Host service: this module shells out to it and never reads a key file.
 * It renews what already exists (`certbot renew` covers the wildcard lineage and any per-domain
 * certificates), issues a certificate for every VERIFIED custom domain that still has none
 * (HTTP-01 webroot, the port-80 block already answers the challenge), and — with --install —
 * re-renders the tenant vhosts through the same transactional nginx install.
 *
 * Domains come straight from the Host database, so the values are validated exactly where nginx
 * renders them (nginx.renderTenants): a hostile hostname is refused and never reaches certbot's
 * argv. A failed issuance leaves the domain HTTP-only and is reported, never fatal to the others.
 */
const fs = require('fs');
const path = require('path');
const nginx = require('./nginx');

const ACME_WEBROOT = '/var/www/certbot';

/** The single service whose inventory declares an nginx.tenants block. */
function tenantService(inv) {
    const ids = Object.values(inv.services).filter((s) => s.nginx && s.nginx.tenants).map((s) => s.id);
    if (!ids.length) throw new Error('no service has an nginx.tenants block (there is nothing to renew for)');
    if (ids.length > 1) throw new Error(`more than one tenant service (${ids.join(', ')}); name one: ovhost certs renew <service>`);
    return inv.services[ids[0]];
}

function firstLine(text) {
    return String(text || '').trim().split('\n')[0] || '';
}

/**
 * -> { renewed, issued: [host], failed: [{ hostname, error }], refused: [value], installed }
 * `installed` is null without --install, else the nginx install result ({ changed, removed, reloaded }).
 */
async function renew(exec, inv, svc, { wildcardCert, install = false, webroot = ACME_WEBROOT, log = () => {} } = {}) {
    nginx.tenantsConfig(svc); // throws early if this service does not host tenants

    // 1. Renew every existing certificate. The wildcard is a DNS-01 lineage the operator issued;
    //    its credentials stay operator-side, so certbot renew owns it here too.
    const renewed = await exec.run('certbot', ['renew', '--non-interactive', '--quiet'], { privileged: true });
    if (renewed.code !== 0) log(`certbot renew reported a failure (exit ${renewed.code}): ${firstLine(renewed.stderr || renewed.stdout)}`);

    // 2. Issue for the verified custom domains that still have no certificate. renderTenants is the
    //    same validator the vhosts use, so `needCert` holds only plain host names.
    const before = await nginx.tenantDomains(exec, svc);
    const pre = nginx.renderTenants(inv, svc, { wildcardCert, domains: before });
    for (const h of pre.refused) log(`refused a database value that is not a plain host name: ${JSON.stringify(h)}`);
    const issued = [];
    const failed = [];
    for (const host of pre.needCert) {
        const r = await exec.run('certbot', ['certonly', '--webroot', '-w', webroot, '-d', host, '--non-interactive'], { privileged: true });
        if (r.code === 0) { issued.push(host); log(`issued a certificate for ${host}`); }
        else {
            const error = firstLine(r.stderr || r.stdout) || `certbot exited ${r.code}`;
            failed.push({ hostname: host, error });
            log(`could not issue a certificate for ${host}: ${error} — it stays HTTP-only`);
        }
    }

    // 3. Install only when asked: re-read the domains (a freshly issued one now has a certificate)
    //    and go through the transactional nginx install.
    let installed = null;
    if (install) {
        const after = await nginx.tenantDomains(exec, svc);
        const r = nginx.renderTenants(inv, svc, { wildcardCert, domains: after });
        const res = await nginx.install(exec, inv, r.files, { log, remove: r.replaces });
        for (const h of r.needCert) log(`still needs a certificate: ${h}`);
        installed = { changed: res.changed, removed: res.removed, reloaded: res.reloaded };
    }

    return { renewed: renewed.code === 0, issued, failed, refused: pre.refused, installed };
}

/** The renewal unit files as rendered (deploy/systemd/openvibe-certs.{service,timer}). */
function unitTexts() {
    const dir = path.join(__dirname, '..', 'deploy', 'systemd');
    return {
        service: fs.readFileSync(path.join(dir, 'openvibe-certs.service'), 'utf8'),
        timer: fs.readFileSync(path.join(dir, 'openvibe-certs.timer'), 'utf8'),
    };
}

module.exports = { renew, tenantService, unitTexts, ACME_WEBROOT };
