'use strict';
/** Catalog identifiers: <prefix>_<ULID>. */
const { ids } = require('openvibe-contracts');

const PREFIX = { catalogProvider: 'hpv', catalogPlan: 'hpl', catalogPromo: 'hpr', catalogOffer: 'hof' };
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const RE = Object.fromEntries(Object.entries(PREFIX).map(([k, p]) => [k, new RegExp(`^${p}_${ULID}$`)]));

function newId(kind, now) {
    return `${PREFIX[kind]}_${ids.ulid(now)}`;
}

function isId(kind, value) {
    return typeof value === 'string' && RE[kind].test(value);
}

module.exports = { newId, isId, PREFIX };
