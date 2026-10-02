'use strict';
/**
 * OpenVibe.Host Stage A library. Every function takes a context { exec, inv, log }: `exec` is the
 * system executor (lib/executor.js) or the fake host in tests, `inv` the loaded inventory.
 */
const inventory = require('./inventory');
const ops = require('./release-ops');
const { validate, envNames, envSet } = require('./commands/validate');
const { status } = require('./commands/status');
const { backup, backupAll, readRun, writeRun, writeMetrics, BackupError } = require('./commands/backup');
const offsite = require('./offsite');
const { snapshot } = require('./commands/snapshot');
const { selfUpdate } = require('./commands/self-update');
const data = require('./commands/data');
const serviceAdd = require('./commands/service-add');
const { drill, DrillError } = require('./commands/drill');
const releases = require('./releases');
const certs = require('./certs');
const acme = require('./acme');
const nginx = require('./nginx');
const announce = require('./announce');
const { createSystemExecutor } = require('./executor');

module.exports = {
    createSystemExecutor,
    inventory,
    validate,
    envNames,
    envSet,
    plan: ops.plan,
    reconcile: (ctx, opts) => require('./reconcile').reconcile(ctx, module.exports, opts),
    deploy: ops.deploy,
    rollback: ops.rollback,
    status,
    backup,
    backupAll,
    readRun,
    writeRun,
    writeMetrics,
    BackupError,
    offsite,
    archive: require('./archive'),
    alerts: require('./alerts'),
    nodes: require('./nodes'),
    browserWatch: require('./browser-watch'),
    incidents: require('./incidents'),
    dns: require('./dns'),
    snapshot,
    selfUpdate,
    data,
    serviceAdd,
    drill,
    DrillError,
    releases,
    certs,
    acme,
    nginx,
    announce: announce.announce,
    announceSummary: announce.summary,
    AnnounceError: announce.AnnounceError,
    EXIT: ops.EXIT,
    OpError: ops.OpError,
};
