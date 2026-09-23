'use strict';
/**
 * Host's own identifiers: <prefix>_<ULID> (the contracts ULID, so they sort by creation time).
 *
 *   prj_  project (until OpenVibe.Network has projects; then it references network_project_id)
 *   site_ site    dpl_ deploy    dom_ domain
 */
const { ids } = require('openvibe-contracts');

const PREFIX = { project: 'prj', site: 'site', deploy: 'dpl', domain: 'dom' };
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const RE = Object.fromEntries(Object.entries(PREFIX).map(([k, p]) => [k, new RegExp(`^${p}_${ULID}$`)]));

function newId(kind, now) {
    return `${PREFIX[kind]}_${ids.ulid(now)}`;
}

function isId(kind, value) {
    return typeof value === 'string' && RE[kind].test(value);
}

module.exports = { newId, isId, PREFIX };
