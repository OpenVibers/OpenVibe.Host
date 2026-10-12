'use strict';
/** Capability checks for the catalog API. */
const { capabilities } = require('openvibe-contracts');
const CAPABILITIES = Object.freeze({ CATALOG_MANAGE: 'host.catalog.manage' });
function checkCapability(claims, capabilityId) { return capabilities.check(claims, capabilityId); }
module.exports = { CAPABILITIES, checkCapability };
