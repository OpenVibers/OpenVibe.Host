'use strict';

/**
 * Capability checks for service tokens (audience openvibe.host), including the ids Host introduces
 * before the contracts library knows them.
 *
 * openvibe-contracts' capabilities.check() answers capability.unknown for an id that is not in its
 * manifests yet. Host's ids are proposed in docs/capabilities-proposal/ for the next contracts
 * release; until then a grant is decided locally with the library's own matching rule (the exact
 * id, or a `prefix.*` grant covering it). An id the library does know always goes through the
 * library, so the day the release lands nothing changes here.
 *
 *   host.site.manage    projects, members, sites, quotas (read), deleting deploys
 *   host.deploy.create  upload deploys, list them and their logs, activate, roll back
 *   host.domain.manage  add, verify and remove custom domains
 *
 * A service token is judged by its capability AND by the project role of the principal it acts
 * as (domain/access.js). Browsers are judged by their role alone.
 */
const { capabilities } = require('openvibe-contracts');

const CAPABILITIES = Object.freeze({
    SITE_MANAGE: 'host.site.manage',
    DEPLOY_CREATE: 'host.deploy.create',
    DOMAIN_MANAGE: 'host.domain.manage',
});
const PROPOSED = new Set(Object.values(CAPABILITIES));

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, PROPOSED, checkCapability };
