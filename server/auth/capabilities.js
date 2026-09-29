'use strict';

/**
 * Capability checks for service tokens (audience openvibe.host), by openvibe-contracts' manifests:
 *
 *   host.site.manage    projects, members, sites, quotas (read), deleting deploys
 *   host.deploy.create  upload deploys, list them and their logs, activate, roll back
 *   host.domain.manage  add, verify and remove custom domains
 *   host.site.config    read, set and reset a site's response headers, redirects and SPA fallback
 *
 * A service token is judged by its capability AND by the project role of the principal it acts
 * as (domain/access.js). Browsers are judged by their role alone.
 */
const { capabilities } = require('openvibe-contracts');

const CAPABILITIES = Object.freeze({
    SITE_MANAGE: 'host.site.manage',
    DEPLOY_CREATE: 'host.deploy.create',
    DOMAIN_MANAGE: 'host.domain.manage',
    SITE_CONFIG: 'host.site.config',
});

/** → { allowed, code, reason } (capabilities.check()). */
function checkCapability(claims, capabilityId) {
    return capabilities.check(claims, capabilityId);
}

module.exports = { CAPABILITIES, checkCapability };
