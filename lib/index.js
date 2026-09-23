'use strict';
/**
 * OpenVibe.Host Stage A library. Every function takes a context { exec, inv, log }: `exec` is the
 * system executor (lib/executor.js) or the fake host in tests, `inv` the loaded inventory.
 */
const inventory = require('./inventory');
const ops = require('./release-ops');
const { validate, envNames } = require('./commands/validate');
const { status } = require('./commands/status');
const { backup } = require('./commands/backup');
const { snapshot } = require('./commands/snapshot');
const releases = require('./releases');
const certs = require('./certs');
const nginx = require('./nginx');
const { createSystemExecutor } = require('./executor');

module.exports = {
    createSystemExecutor,
    inventory,
    validate,
    envNames,
    plan: ops.plan,
    deploy: ops.deploy,
    rollback: ops.rollback,
    status,
    backup,
    snapshot,
    releases,
    certs,
    nginx,
    EXIT: ops.EXIT,
    OpError: ops.OpError,
};
