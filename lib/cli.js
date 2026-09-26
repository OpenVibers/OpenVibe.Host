'use strict';
/**
 * ovhost command line. main(argv, { exec, out, env }) returns the exit code, so the tests drive the
 * whole CLI against the fake host.
 */
const lib = require('./index');
const { InventoryError } = require('./inventory');
const { LockedError } = require('./lock');
const { SocketGuardError } = require('./systemd');
const { runBrowserCheck } = require('./browser-check-hook');

const USAGE = `ovhost — OpenVibe.Host operator plane (Stage A)

Usage: ovhost <command> [args] [--inventory <file>] [--json]

  status [<service>...]                  unit state, sha, readiness, protected sessions (all services)
  validate <service> [--manifest <file>] env names, unit files, port, nginx vhost + nginx -t, deps, and the
                                         lifecycle declaration (inventory, --manifest or the installed
                                         openvibe-contracts manifest): every field, the shutdown deadline
                                         within the unit's TimeoutStopSec, contracts.range
  env-names <service>                    variable NAMES declared in the checkout's .env.example
  show [<service>...]                    the inventory as ovhost reads it: repo, owner, units, socket,
                                         workers, port, ready URL, protected probe (no values)
  plan <service> [--to <sha>] [--no-fetch]
                                         what a deploy would do (fetches the remote; changes nothing else)
  deploy <service> [--wait-idle] [--force] [--restart] [--to <sha>] [--install-units] [--ready-timeout <s>]
         [--browser-check]               then check the service's public site in headless Chrome
                                         (scripts/browser-check.js; report only, never changes the exit code)
         [--no-announce]                 a deploy that went live is announced (see announce) unless this is set
  rollback <service> [--to <sha>] [--wait-idle] [--force] [--no-announce]
  announce <service> [--release <id>] [--commit <sha>] [--origin <url>] [--force] [--dry-run]
                                         publish host.release.published to OpenVibe.Events (public), so open
                                         tabs check /release.json now: for services deployed by their own
                                         scripts. Release: --release, else the service's loopback
                                         /release.json, else the checkout's HEAD; the same release is sent
                                         once (--force again). Credentials: --events-env <file>, else
                                         $OVHOST_EVENTS_ENV, else inventory events.envFile, else
                                         /etc/openvibe/host.env (docs/release-notifications.md)
  releases <service> [--limit <n>]       the release log
  certs [--warn-days <n>]                certificates referenced by enabled nginx vhosts, with expiry
  nginx render <service> [--variant http|sse|websocket] [--manifest <file>] [--install]
                                         print a vhost from the service manifest; --install writes it,
                                         runs nginx -t and reloads only if clean
  nginx tenants <service> [--wildcard-cert <name|dir>] [--install]
                                         Stage B: the dashboard + *.<sites domain> vhost and one vhost
                                         for the VERIFIED custom domains (read from the service's
                                         database); lists domains still waiting for a certificate
  snapshot <service> [--out <file>]      config tarball: units, vhost, env NAMES, sha — no secret values
  backup <service>                       sqlite .backup of the declared databases to a dated directory
  backup --all [--offsite] [--no-prune] [--keep-daily <n>] [--keep-weekly <n>]
                                         every service with databases; one failure never stops the
                                         others; keeps the last 7 daily + 4 weekly good backups per
                                         service; JSON summary in <stateDir>/backup-runs/<run>.json;
                                         --offsite then encrypts and uploads the run (root)
  backup-metrics [--run <run>]           rewrite the Prometheus textfile (node_exporter collector) from a
                                         recorded backup --all run (default: the latest)
  offsite push [--run <run>]             encrypt + upload a backup --all run (default: the latest)
  offsite list [<service>] [--from-host <name>]
                                         runs stored off-host, newest first
  offsite check                          config, key and bucket access; uploads nothing
  archive push <file>... [--note <text>] encrypt + upload dead or backup database files (closed, not
                                         declared by the inventory) to <prefix>-archive/; never deletes them
  archive list                           the archives off-host
  archive restore <stamp> <path> --out <dir>   one archived file back, checked against the manifest
  dns list <zone>                        Cloudflare records (run where the token is: --token-file, or
                                         ~/.config/cloudflare-token; the host holds none)
  dns ensure <name> <type> <content> (--proxied|--dns-only) [--ttl <s>] [--apply]   dry run by default
  dns delete <name> <type> [--apply]
  incident open --title <t> --services a,b [--severity minor|major|critical] --message <m>
  incident update <inc_…> --state identified|monitoring|resolved --message <m>
  incident list                          incidents and maintenance on openvibe.network/status
  maintenance schedule --title <t> --services a,b --from <iso> --until <iso> --message <m> [--freeze]
  maintenance start|complete <inc_…> --message <m>   (complete lifts the window's freezes)
  freeze <service|all> --reason <text> [--incident <inc_…>]   deploys refuse it (exit 6) unless --force
  unfreeze <service|all>                 lift a freeze (freeze with no argument lists them)
  browser-watch [--sites live,...] [--force]
                                         check each site in a real browser after every release (and
                                         daily) as ovcheck; metrics for OpenVibeBrowserCheckFailed
                                         (openvibe-browsercheck.timer, every 5 minutes)
  alerts relay [--prometheus <url>] [--dry-run]
                                         the alerts firing in Prometheus, sent to Network, which pages
                                         the operator (openvibe-alerts.timer, every 2 minutes)
  restore-download <service> <run|latest> [--out <dir>] [--from-host <name>]
                                         download, verify and decrypt one service's databases into a
                                         NEW root-only directory; never touches a live database
                                         (offsite commands: --backup-env <file>, default
                                         /etc/openvibe/backup.env)
  drill <service> [--backup <dir>] [--keep]
                                         restore drill (root): restore the latest backup into a temp
                                         dir, start a sandboxed second instance on the drill port, compare
                                         it with production, stop it, log the result

Inventory: --inventory, else $OVHOST_INVENTORY, else /etc/openvibe/host.json.
Exit codes: 0 ok · 1 usage/precondition · 2 validation failed (nothing restarted) · 3 not ready,
rolled back · 4 rollback failed (manual intervention) · 5 protected sessions active ·
announce: 0 sent, already sent or dry run · 1 usage or not configured · 2 publishing failed ·
drill: 0 passed · 1 precondition (not root, port in use, no backup, unsupported) · 2 drill failed ·
backup --all / offsite: 0 everything succeeded · 1 precondition (config, key, lock) · 2 something failed
`;

const FLAGS_WITH_VALUE = new Set(['prometheus', 'sites', 'token-file', 'ttl', 'title', 'services', 'severity', 'message', 'state', 'from', 'until', 'reason', 'incident', 'inventory', 'to', 'limit', 'warn-days', 'variant', 'manifest', 'out', 'ready-timeout', 'wildcard-cert', 'backup', 'run', 'keep-daily', 'keep-weekly', 'from-host', 'backup-env', 'release', 'commit', 'origin', 'events-env', 'note']);

function parseArgs(argv) {
    const pos = [];
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { opts.help = true; continue; }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
            if (FLAGS_WITH_VALUE.has(name)) {
                const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
                if (v === undefined) throw new UsageError(`--${name} needs a value`);
                opts[name] = v;
            } else opts[name] = true;
        } else pos.push(a);
    }
    return { pos, opts };
}

class UsageError extends Error {}

const ICON = { ok: '  ok ', warn: 'WARN ', error: 'FAIL ', info: 'info ' };

function short(sha) { return sha ? sha.slice(0, 12) : '-'; }

function count(opts, name, dflt) {
    if (opts[name] == null) return dflt;
    const n = Number(opts[name]);
    if (!(Number.isInteger(n) && n >= 1 && n <= 366)) throw new UsageError(`--${name} must be a whole number from 1`);
    return n;
}

function bytes(n) {
    if (n == null) return '?';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${i ? v.toFixed(1) : v} ${u[i]}`;
}

/** An announce result without the envelope, for --json. */
function announcedSummary(a) {
    const { envelope, ...rest } = a;
    return rest;
}

async function main(argv, { exec = lib.createSystemExecutor(), out = (s) => process.stdout.write(`${s}\n`), env = process.env, s3 = lib.offsite.createClient, browserCheck = runBrowserCheck } = {}) {
    let parsed;
    try { parsed = parseArgs(argv); } catch (err) { out(err.message); out(USAGE); return 1; }
    const { pos, opts } = parsed;
    const cmd = pos[0];
    if (!cmd || opts.help) { out(USAGE); return cmd || opts.help ? 0 : 1; }
    const json = !!opts.json;
    const log = json ? () => {} : (s) => out(`[ovhost] ${s}`);
    const emit = (obj) => out(JSON.stringify(obj, null, 2));
    const needService = () => { if (!pos[1]) throw new UsageError(`${cmd} needs a <service>`); return pos[1]; };

    try {
        // The DNS adapter runs on the operator's workstation (where the Cloudflare token is), which has no inventory.
        let inv;
        try { inv = await lib.inventory.load(exec, { file: opts.inventory, env }); } catch (err) {
            if (cmd !== 'dns' || opts.inventory || !(err instanceof InventoryError)) throw err;
            inv = { dns: { dnsOnly: lib.dns.DEFAULT_DNS_ONLY }, services: {} };
        }
        const ctx = { exec, inv, log };
        switch (cmd) {
        case 'validate': {
            const r = await lib.validate(ctx, needService(), { manifestFile: opts.manifest });
            if (json) emit(r);
            else {
                for (const f of r.findings) out(`${ICON[f.level]} ${f.area.padEnd(8)} ${f.message}`);
                out(`${r.service}: ${r.ok ? 'valid' : 'NOT valid'} (${r.errors} error(s), ${r.warnings} warning(s))`);
            }
            return r.ok ? 0 : 2;
        }
        case 'show': {
            // The inventory as ovhost reads it (defaults applied). It holds no secret values.
            const ids = pos.slice(1);
            const list = ids.length ? ids.map((id) => lib.inventory.service(inv, id)) : Object.values(inv.services);
            const rows = list.map((s) => ({ id: s.id, managed: s.managed, repo: s.repo, owner: s.owner, runAs: s.runAs, branch: s.branch, units: s.units, socketUnit: s.socketUnit || null, workerUnits: s.workerUnits, port: s.port || null, ready: s.ready ? s.ready.url : null, protected: s.protected ? s.protected.kind : null, drain: s.drain ? s.drain.policy : null, layout: s.layout }));
            if (json) { emit(ids.length === 1 ? rows[0] : rows); return 0; }
            for (const r of rows) out(`${r.id.padEnd(10)} ${r.repo}  units: ${r.units.join(' ') || '-'}${r.socketUnit ? `  socket: ${r.socketUnit}` : ''}${r.workerUnits.length ? `  workers: ${r.workerUnits.join(' ')}` : ''}${r.protected ? `  protected: ${r.protected}` : ''}${r.managed ? '' : '  [unmanaged]'}`);
            return 0;
        }
        case 'env-names': {
            const r = await lib.envNames(ctx, needService());
            if (json) emit(r);
            else if (!r.found) out(`${r.file} not found`);
            else {
                out(`${r.file}: ${r.declared.length} declared name(s)`);
                out(r.declared.join('\n'));
                if (r.commented.length) out(`commented out: ${r.commented.join(', ')}`);
            }
            return r.found ? 0 : 1;
        }
        case 'plan': {
            const p = await lib.plan(ctx, needService(), { to: opts.to, fetch: !opts['no-fetch'], restart: !!opts.restart });
            if (json) { emit(p); return 0; }
            out(`${p.service}: ${short(p.from)} → ${short(p.to)}${p.upToDate ? ' (up to date)' : ''} on ${p.branch}${p.branch !== p.expectedBranch ? ` (EXPECTED ${p.expectedBranch})` : ''}`);
            for (const c of p.commits.slice(0, 30)) out(`    ${c}`);
            out(`  files changed      ${p.changedFiles} (${p.codeChanged} outside the no-restart paths)`);
            out(`  tracked changes    ${p.dirty.length ? `${p.dirty.join(', ')} — deploy will refuse` : 'none'}`);
            for (const i of p.installs) out(`  ${i.pkg.padEnd(18)} ${i.install ? `install (${[i.lockfileChanged && 'lockfile changed', i.depsChanged && 'deps changed', i.missingNodeModules && 'no node_modules'].filter(Boolean).join(', ') || 'always'})` : 'dependencies unchanged'}`);
            out(`  restart            ${p.restartNeeded ? `yes: ${p.units.join(', ')}${p.socketUnit ? ` (socket ${p.socketUnit} stays up)` : ''}` : 'no'}`);
            if (p.protectedSessions) {
                const s = p.protectedSessions;
                out(`  protected          ${s.count == null ? `UNKNOWN (${s.unknown}) — treated as active` : `${s.count} ${s.label}`}${s.notRunning ? ' (service not running)' : ''}; drain policy ${p.drainPolicy}`);
            }
            if (p.backupNeeded) out('  backup             schema files changed — databases are backed up before the restart');
            if (p.unitDrift.length) out(`  unit files         differ from the repo: ${p.unitDrift.map((u) => u.unit).join(', ')} (--install-units)`);
            if (p.installVhosts) out('  nginx              repo vhosts are installed (nginx -t, reload) on deploy');
            if (!p.managed) out('  NOT MANAGED        deploy/rollback refuse this service');
            return 0;
        }
        case 'deploy':
        case 'rollback': {
            const id = needService();
            const o = { waitIdle: !!opts['wait-idle'], force: !!opts.force, restart: !!opts.restart, to: opts.to, installUnits: !!opts['install-units'], readyTimeout: opts['ready-timeout'] ? Number(opts['ready-timeout']) : undefined };
            const r = cmd === 'deploy' ? await lib.deploy(ctx, id, o) : await lib.rollback(ctx, id, o);
            // Release notification (lib/announce.js): best effort, never changes the exit code.
            let announced = null;
            if (r.exitCode === 0 && ['deployed', 'rolled-back'].includes(r.record.result) && !opts['no-announce']) {
                try {
                    announced = await lib.announce(ctx, r.record.service, { head: r.record.to, rollback: cmd === 'rollback', envFile: opts['events-env'], env });
                } catch (e) { announced = { service: r.record.service, published: false, error: e.message }; }
                log(lib.announceSummary(announced));
            }
            if (json) emit(announced ? { ...r.record, announce: announcedSummary(announced) } : r.record);
            else if (r.record.result !== 'unchanged') out(`[ovhost] result: ${r.record.result} (release ${r.record.id})`);
            if (cmd === 'deploy' && opts['browser-check'] && !json && r.exitCode === 0 && r.record.result === 'deployed') {
                log(`browser check of ${id}'s public site (report only)…`);
                let b;
                try { b = await browserCheck(id); } catch (e) { b = { code: 2, lines: [], error: e.message }; }
                for (const line of b.lines) log(`  ${line}`);
                log(`browser check ${b.code === 0 ? 'passed' : b.code === 1 ? 'found problems (see above)' : `did not run: ${b.error}`}; the deploy stands`);
            }
            return r.exitCode;
        }
        case 'announce': {
            const id = needService();
            const a = await lib.announce(ctx, id, {
                release: opts.release, commit: opts.commit, origin: opts.origin,
                force: !!opts.force, dryRun: !!opts['dry-run'], envFile: opts['events-env'], env,
            });
            if (json) emit(a.envelope ? { ...announcedSummary(a), envelope: a.envelope } : announcedSummary(a));
            else {
                log(lib.announceSummary(a));
                if (a.envelope) out(JSON.stringify(a.envelope, null, 2));
            }
            if (a.published || (a.skipped && !a.notConfigured)) return 0;
            return a.notConfigured ? 1 : 2;
        }
        case 'status': {
            const rows = await lib.status(ctx, pos.slice(1));
            if (json) { emit(rows); return 0; }
            for (const r of rows) {
                const units = r.units.map((u) => `${u.unit.replace(/\.service$/, '')}=${u.active}${u.restarts ? `(${u.restarts} restarts)` : ''}`).join(' ');
                const sock = r.socket ? ` socket=${r.socket.active}` : '';
                const workers = r.workers && r.workers.length ? ` workers[${r.workers.map((w) => `${w.unit.replace(/\.service$/, '')}=${w.active}`).join(' ')}]` : '';
                const ready = r.ready ? (r.ready.ok ? 'ready' : `NOT READY (${r.ready.status || r.ready.error})`) : '-';
                const prot = r.protected ? (r.protected.count == null ? ` ${r.protected.label}=unknown` : ` ${r.protected.label}=${r.protected.count}`) : '';
                out(`${r.service.padEnd(10)} ${short(r.sha)} ${ready.padEnd(12)} ${units || '(no units)'}${sock}${workers}${prot}${r.managed ? '' : ' [unmanaged]'}`);
            }
            return 0;
        }
        case 'releases': {
            const id = lib.inventory.service(inv, needService()).id;
            const list = await lib.releases.list(exec, inv, id);
            const limit = Number(opts.limit || 20);
            const shown = list.slice(-limit);
            if (json) { emit(shown); return 0; }
            if (!shown.length) out(`no releases recorded for ${id}`);
            for (const r of shown) {
                out(`${r.startedAt}  ${r.action.padEnd(8)} ${short(r.from)} → ${short(r.to)}  ${String(r.result).padEnd(18)} ${r.operator || ''}${r.forced ? ' FORCED' : ''}${r.lockfileChanged ? ' lockfile' : ''}${r.error ? `  (${r.error.split('\n')[0].slice(0, 100)})` : ''}`);
            }
            return 0;
        }
        case 'certs': {
            const list = await lib.certs.inventory(exec, inv, { warnDays: Number(opts['warn-days'] || 21) });
            if (json) emit(list);
            else {
                for (const c of list) {
                    out(`${String(c.status).toUpperCase().padEnd(9)} ${c.notAfter ? `${c.notAfter.slice(0, 10)} (${c.daysLeft}d)` : ''.padEnd(10)} ${c.path}${c.names ? `  [${c.names.slice(0, 4).join(', ')}${c.names.length > 4 ? `, +${c.names.length - 4}` : ''}]` : ''}${c.error ? `  ${c.error}` : ''}  ← ${c.vhosts.join(', ')}`);
                }
                out(`${list.length} certificate(s) referenced by ${inv.nginx.sitesEnabled}`);
            }
            return list.some((c) => ['expired', 'missing', 'unreadable'].includes(c.status)) ? 2 : 0;
        }
        case 'nginx': {
            if (pos[1] === 'tenants') {
                const id = pos[2];
                if (!id) throw new UsageError('nginx tenants needs a <service>');
                const svc = lib.inventory.service(inv, id);
                const domains = await lib.nginx.tenantDomains(exec, svc);
                const r = lib.nginx.renderTenants(inv, svc, { wildcardCert: opts['wildcard-cert'], domains });
                for (const h of r.refused) log(`refused a custom domain value that is not a plain host name: ${JSON.stringify(h)}`);
                if (json && !opts.install) { emit({ files: r.files.map((f) => f.name), replaces: r.replaces, certDir: r.certDir, needCert: r.needCert, refused: r.refused }); return 0; }
                if (!opts.install) {
                    for (const f of r.files) out(`# ---- ${f.name} ----\n${f.text}`);
                    if (r.replaces.length) out(`# --install also removes, in the same nginx -t and reload: ${r.replaces.join(', ')} (if present)`);
                } else {
                    const res = await lib.nginx.install(exec, inv, r.files, { log, remove: r.replaces });
                    if (!res.changed.length && !res.removed.length) log('tenant vhosts already installed; nothing changed');
                }
                for (const h of r.needCert) log(`needs a certificate: certbot certonly --webroot -w /var/www/certbot -d ${h}   (then run this again)`);
                return 0;
            }
            if (pos[1] !== 'render') throw new UsageError('usage: ovhost nginx render <service> [--variant …] [--install] | ovhost nginx tenants <service> [--wildcard-cert …] [--install]');
            const id = pos[2];
            if (!id) throw new UsageError('nginx render needs a <service>');
            const svc = lib.inventory.service(inv, id);
            const r = lib.nginx.render(inv, svc, { variant: opts.variant, manifestFile: opts.manifest });
            if (!opts.install) { out(r.text); return 0; }
            const res = await lib.nginx.install(exec, inv, [r], { log });
            if (!res.changed.length) log(`${r.name} already installed and enabled; nothing changed`);
            return 0;
        }
        case 'snapshot': {
            const r = await lib.snapshot(ctx, needService(), { out: opts.out });
            if (json) emit(r); else { out(`snapshot: ${r.file}`); out(`  ${r.entries.join('\n  ')}`); }
            return 0;
        }
        case 'backup': {
            if (opts.all) {
                if (pos[1]) throw new UsageError('backup --all takes no <service>');
                const offsiteRun = opts.offsite ? async (summary) => {
                    const cfg = await lib.offsite.loadConfig(exec, { file: opts['backup-env'], env });
                    return lib.offsite.push(ctx, summary, { cfg, client: s3(cfg) });
                } : null;
                const r = await lib.backupAll(ctx, { daily: count(opts, 'keep-daily', 7), weekly: count(opts, 'keep-weekly', 4), prune: !opts['no-prune'], offsite: offsiteRun });
                if (json) emit(r);
                else {
                    for (const s of r.services) {
                        const copied = s.files.filter((f) => f.dest && !f.error);
                        const size = copied.reduce((a, f) => a + (f.bytes || 0), 0);
                        const detail = s.status === 'failed' ? s.error : s.status === 'skipped' ? 'no database found' : `${copied.length} file(s), ${bytes(size)}`;
                        out(`${s.status.toUpperCase().padEnd(8)} ${s.service.padEnd(10)} ${detail}${s.pruned.length ? `; pruned ${s.pruned.length}` : ''}`);
                    }
                    if (r.offsite) {
                        const o = r.offsite;
                        if (o.error) out(`OFFSITE  FAILED: ${o.error}`);
                        else out(`OFFSITE  ${o.ok ? 'ok' : 'FAILED'}: ${o.uploaded.length} file(s) to s3://${o.bucket}/${o.location} (key ${o.keyId})${o.failures.length ? `; ${o.failures.length} failure(s): ${o.failures.map((f) => `${f.service ? `${f.service}/` : ''}${f.file}: ${f.error}`).join('; ')}` : ''}${o.pruned.length ? `; pruned ${o.pruned.length} old run(s)` : ''}`);
                    }
                    out(`run ${r.run}: ${r.ok ? 'ok' : 'FAILED'}; summary ${r.file}`);
                }
                return r.ok ? 0 : 2;
            }
            const r = await lib.backup(ctx, needService());
            if (json) emit(r); else for (const f of r.files) out(f.skipped ? `skipped ${f.source}: ${f.skipped}` : `${f.source} → ${f.dest} (${f.bytes} bytes)`);
            return 0;
        }
        case 'backup-metrics': {
            // Rewrite the Prometheus textfile from a recorded run (the latest by default): after an
            // install, or when the collector directory appeared after the last run.
            const summary = await lib.readRun(exec, inv, opts.run || null);
            if (!summary) throw new UsageError(`no backup --all run recorded in ${inv.stateDir}/backup-runs`);
            const wrote = await lib.writeMetrics(ctx, summary);
            if (json) emit({ run: summary.run, written: wrote }); else out(wrote ? `backup metrics written from run ${summary.run}` : 'no textfile collector directory: nothing written');
            return 0;
        }
        case 'offsite': {
            const sub = pos[1];
            if (!['push', 'list', 'check'].includes(sub)) throw new UsageError('usage: ovhost offsite push [--run <run>] | offsite list [<service>] | offsite check');
            const cfg = await lib.offsite.loadConfig(exec, { file: opts['backup-env'], env });
            const client = s3(cfg);
            if (sub === 'check') {
                const r = await lib.offsite.check(ctx, { cfg, client });
                if (json) emit(r); else out(`off-host ok: s3://${r.bucket}/${r.prefix}/${r.host}/ at ${r.endpoint} (region ${r.region}); key id ${r.keyId}; retention ${r.retentionDays} days${r.prune ? '' : ' (pruning off)'}`);
                return 0;
            }
            if (sub === 'list') {
                const host = await lib.offsite.hostName(exec, inv, opts['from-host']);
                const runs = (await lib.offsite.listRuns(client, cfg, host)).filter((x) => !pos[2] || x.services.includes(pos[2])).map(({ keys, ...x }) => x);
                if (json) { emit(runs); return 0; }
                if (!runs.length) out(`no runs under s3://${cfg.bucket}/${cfg.prefix}/${host}/`);
                for (const x of runs) out(`${x.run}  ${String(x.objects).padStart(3)} object(s) ${bytes(x.bytes).padStart(9)}  ${x.manifest ? '' : '(no manifest) '}${x.services.join(' ')}`);
                return 0;
            }
            const summary = await lib.readRun(exec, inv, opts.run || null);
            if (!summary) throw new UsageError(opts.run ? `no backup --all run ${opts.run} in ${inv.stateDir}/backup-runs` : `no backup --all run recorded in ${inv.stateDir}/backup-runs; run ovhost backup --all first`);
            summary.offsite = await lib.offsite.push(ctx, summary, { cfg, client });
            if (!summary.offsite.ok) summary.ok = false;
            await lib.writeRun(exec, summary);
            try { await lib.writeMetrics(ctx, summary); } catch { /* metrics never fail a push */ }
            const o = summary.offsite;
            if (json) emit(o);
            else out(`OFFSITE ${o.ok ? 'ok' : 'FAILED'}: ${o.uploaded.length} file(s) to s3://${o.bucket}/${o.location}${o.failures.length ? `; failures: ${o.failures.map((f) => `${f.service ? `${f.service}/` : ''}${f.file}: ${f.error}`).join('; ')}` : ''}`);
            return o.ok ? 0 : 2;
        }
        case 'dns': {
            // WS-N task 12: the DNS adapter (lib/dns.js; Cloudflare API).
            const dns = lib.dns;
            const conn = { tokenFile: opts['token-file'], env };
            const row = (r) => `${r.name}  ${r.type}  ${r.content}${r.proxied ? '  proxied' : ''}  ttl ${r.ttl === 1 ? 'auto' : r.ttl}`;
            try {
                const sub = pos[1];
                if (sub === 'list') {
                    if (!pos[2]) throw new UsageError('usage: ovhost dns list <zone>');
                    const r = await dns.list(ctx, pos[2], conn);
                    if (json) emit(r); else { out(`zone ${r.zone}: ${r.records.length} record(s)`); for (const x of r.records) out(`  ${row(x)}`); }
                    return 0;
                }
                if (sub === 'ensure' || sub === 'delete') {
                    if (!pos[2] || !pos[3] || (sub === 'ensure' && !pos[4])) throw new UsageError(sub === 'ensure' ? 'usage: ovhost dns ensure <name> <type> <content> (--proxied|--dns-only) [--ttl <s>] [--apply]' : 'usage: ovhost dns delete <name> <type> [--apply]');
                    if (opts.proxied && opts['dns-only']) throw new UsageError('--proxied or --dns-only, not both');
                    const r = sub === 'ensure'
                        ? await dns.ensure(ctx, { name: pos[2], type: pos[3], content: pos[4], proxied: opts.proxied ? true : opts['dns-only'] ? false : undefined, ttl: opts.ttl != null ? Number(opts.ttl) : undefined }, { apply: !!opts.apply, ...conn })
                        : await dns.remove(ctx, { name: pos[2], type: pos[3] }, { apply: !!opts.apply, ...conn });
                    if (json) emit(r);
                    else {
                        out(`${r.dryRun ? 'would ' : ''}${r.action} in ${r.zone}${r.dryRun ? ' (dry run; --apply to change)' : ''}`);
                        if (r.before) out(`  before: ${row(r.before)}`);
                        if (r.after) out(`  after:  ${row(r.after)}`);
                    }
                    return 0;
                }
                throw new UsageError('usage: ovhost dns list|ensure|delete …');
            } catch (err) {
                if (err instanceof dns.DnsError) { (json ? emit({ ok: false, error: err.message }) : out(`[ovhost] ✗ ${err.message}`)); return err.exitCode; }
                throw err;
            }
        }
        case 'incident':
        case 'maintenance':
        case 'freeze':
        case 'unfreeze': {
            // WS-N task 12: incident and maintenance controls (lib/incidents.js).
            const inc = lib.incidents;
            const conn = { envFile: opts['events-env'], env };
            const show = (i) => `${i.id}  ${i.kind === 'maintenance' ? 'maintenance' : (i.severity || 'incident')}  ${i.state}  ${i.services.join(',')}  ${i.title}${i.ends_at ? `  (until ${i.ends_at})` : ''}`;
            try {
                if (cmd === 'freeze') {
                    if (!pos[1]) { const f = await inc.freezes(ctx); if (json) emit(f); else if (!f.length) out('nothing is frozen'); else for (const x of f) out(`${x.service}  since ${x.at}  ${x.reason}${x.incident ? ` (${x.incident})` : ''}`); return 0; }
                    const r = await inc.freeze(ctx, pos[1], { reason: opts.reason, incident: opts.incident, by: env.SUDO_USER || env.USER || null });
                    if (json) emit(r); else out(`frozen: ${r.service} (${r.reason}); deploys refuse it until ovhost unfreeze ${r.service}`);
                    return 0;
                }
                if (cmd === 'unfreeze') {
                    if (!pos[1]) throw new UsageError('usage: ovhost unfreeze <service|all>');
                    const had = await inc.unfreeze(ctx, pos[1]);
                    out(had ? `unfrozen: ${pos[1]}` : `${pos[1]} was not frozen`);
                    return 0;
                }
                const sub = pos[1];
                let r;
                if (cmd === 'incident') {
                    if (sub === 'open') r = await inc.open(ctx, opts, conn);
                    else if (sub === 'update') r = await inc.update(ctx, pos[2], opts, conn);
                    else if (sub === 'list') { const l = await inc.list(ctx, conn); if (json) emit(l); else { out(`active: ${l.active.length}`); for (const i of l.active) out(`  ${show(i)}`); out(`closed in the last 30 days: ${l.recent.length}`); for (const i of l.recent) out(`  ${show(i)}`); } return 0; }
                    else throw new UsageError('usage: ovhost incident open|update|list …');
                } else {
                    if (sub === 'schedule') {
                        r = await inc.schedule(ctx, opts, conn);
                        if (opts.freeze) for (const s of r.services) await inc.freeze(ctx, s, { reason: `maintenance: ${r.title}`, incident: r.id, by: env.SUDO_USER || env.USER || null });
                    } else if (sub === 'start') r = await inc.update(ctx, pos[2], { state: 'in_progress', message: opts.message }, conn);
                    else if (sub === 'complete') {
                        r = await inc.update(ctx, pos[2], { state: 'completed', message: opts.message }, conn);
                        for (const f of await inc.freezes(ctx)) if (f.incident === r.id) await inc.unfreeze(ctx, f.service);
                    } else throw new UsageError('usage: ovhost maintenance schedule|start|complete …');
                }
                if (json) emit(r); else out(show(r));
                return 0;
            } catch (err) {
                if (err instanceof inc.IncidentsError) { (json ? emit({ ok: false, error: err.message }) : out(`[ovhost] ✗ ${err.message}`)); return err.exitCode; }
                throw err;
            }
        }
        case 'browser-watch': {
            // WS-H task 11: the release UX check. A failure pages through the alerts relay.
            const sites = String(opts.sites || 'live').split(',').map((x) => x.trim()).filter(Boolean);
            const r = await lib.browserWatch.watch(ctx, { sites, force: !!opts.force });
            if (json) emit(r);
            else for (const x of r.sites) out(x.action === 'checked' ? `${x.ok ? 'ok  ' : 'FAIL'} ${x.site} ${x.release || '?'}${x.failing && x.failing.length ? `; failing: ${x.failing.map((f) => `${f.check} ${f.fail}`).join(', ')}` : ''}`
                : x.action === 'skipped' ? `skip ${x.site} ${x.release || '?'} (${x.reason}; last ${x.ok ? 'passed' : 'failed'})` : `ERR  ${x.site}: ${x.reason}`);
            return r.sites.some((x) => x.action === 'error') ? 2 : r.sites.some((x) => x.action === 'checked' && !x.ok) ? 1 : 0;
        }
        case 'alerts': {
            // WS-H task 11: deliver the firing Prometheus alerts to the operator through Network.
            if (pos[1] !== 'relay') throw new UsageError('usage: ovhost alerts relay [--prometheus <url>] [--dry-run] [--events-env <file>]');
            const r = await lib.alerts.relay(ctx, { prometheus: opts.prometheus, envFile: opts['events-env'], env, dryRun: !!opts['dry-run'] });
            if (json) emit(r);
            else if (!r.ok) out(`ALERTS not delivered (${r.stage}): ${r.error}`);
            else if (r.dryRun) { out(`${r.firing} alert(s) firing (dry run, nothing sent)`); for (const a of r.alerts) out(`  ${a.severity.padEnd(8)} ${a.name}  ${a.summary}`); }
            else out(`ALERTS delivered: ${r.firing} firing; opened ${r.result.opened}, reminded ${r.result.reminded}, resolved ${r.result.resolved}; ${r.result.notified} notification(s)`);
            return r.ok ? 0 : 2;
        }
        case 'archive': {
            // WS-S task 6: dead and backup database files, encrypted off-host before the owner deletes them.
            const sub = pos[1];
            if (!['push', 'list', 'restore'].includes(sub)) throw new UsageError('usage: ovhost archive push <file>... [--note <text>] | archive list | archive restore <stamp> <path> --out <dir>');
            const cfg = await lib.offsite.loadConfig(exec, { file: opts['backup-env'], env });
            const client = s3(cfg);
            try {
                if (sub === 'list') {
                    const rows = await lib.archive.list(ctx, { cfg, client });
                    if (json) { emit(rows); return 0; }
                    if (!rows.length) out('no archives off-host');
                    for (const x of rows) out(x.error ? `${x.stamp}  ${x.error}` : `${x.stamp}  ${String(x.files).padStart(3)} file(s) ${bytes(x.plainBytes).padStart(9)}${x.failures ? `  ${x.failures} failed` : ''}  ${x.note}`);
                    return 0;
                }
                if (sub === 'restore') {
                    if (!pos[2] || !pos[3]) throw new UsageError('archive restore needs <stamp> <path> --out <dir>');
                    const r = await lib.archive.restore(ctx, pos[2], pos[3], { cfg, client, out: opts.out });
                    if (json) emit(r); else out(`restored ${pos[3]} into ${r.file} (${bytes(r.bytes)}, sha256 ${r.sha256.slice(0, 16)}…, root-only)`);
                    return 0;
                }
                const r = await lib.archive.push(ctx, pos.slice(2), { cfg, client, note: opts.note || '' });
                if (json) emit(r);
                else {
                    for (const f of r.files) out(`archived ${f.path}  ${bytes(f.plainBytes)}  sha256 ${f.plainSha256.slice(0, 16)}…`);
                    for (const f of r.failures) out(`✗ ${f.path}: ${f.error}`);
                    out(`ARCHIVE ${r.ok ? 'ok' : 'INCOMPLETE'}: ${r.files.length} file(s) at ${r.location} (record ${inv.stateDir}/archives/${r.stamp}.json). Nothing was deleted.`);
                }
                return r.ok ? 0 : 2;
            } catch (err) {
                if (err instanceof lib.archive.ArchiveError) { (json ? emit({ ok: false, error: err.message }) : out(`ARCHIVE refused: ${err.message}`)); return err.exitCode; }
                throw err;
            }
        }
        case 'restore-download': {
            const id = needService();
            if (!pos[2]) throw new UsageError('restore-download needs a <run> (a run id such as 20260923-033000, or latest)');
            const cfg = await lib.offsite.loadConfig(exec, { file: opts['backup-env'], env });
            const r = await lib.offsite.restoreDownload(ctx, id, pos[2], { cfg, client: s3(cfg), out: opts.out, host: opts['from-host'] });
            if (json) { emit(r); return 0; }
            for (const f of r.files) out(`${f.file}  ${bytes(f.bytes)}  sha256 ${f.sha256.slice(0, 16)}…  quick_check ${f.quickCheck}  (was ${f.source})`);
            out(`restored ${r.service} from ${r.host}/${r.run} into ${r.dir} (root-only). Nothing live was touched;`);
            out('see docs/backups.md "Restoring from an off-host copy" to put a copy in place.');
            return 0;
        }
        case 'drill': {
            const r = await lib.drill(ctx, needService(), { backup: opts.backup, keep: !!opts.keep });
            if (json) emit(r.record);
            else {
                out(`[ovhost] drill ${r.record.result}${r.record.failure ? ` at ${r.record.failure.stage}: ${r.record.failure.message}` : ''}`);
                out('Row for docs/restore-drills.md:');
                out(r.record.markdown);
            }
            return r.exitCode;
        }
        default:
            throw new UsageError(`unknown command "${cmd}"`);
        }
    } catch (err) {
        if (err instanceof UsageError) { out(err.message); return 1; }
        if (err instanceof InventoryError || err instanceof LockedError) { out(`[ovhost] ${err.message}`); return 1; }
        if (err instanceof SocketGuardError) { out(`[ovhost] ${err.message}`); return 1; }
        if (err instanceof lib.DrillError) { out(`[ovhost] ${err.message}`); return err.exitCode; }
        if (err instanceof lib.offsite.OffsiteError) { out(`[ovhost] ✗ ${err.message}`); return err.exitCode; }
        if (err instanceof lib.OpError) { out(`[ovhost] ✗ ${err.message}`); return err.exitCode; }
        if (err instanceof lib.AnnounceError) { out(`[ovhost] ${err.message}`); return err.exitCode; }
        out(`[ovhost] ✗ ${err.message}`);
        return 2;
    }
}

module.exports = { main, parseArgs, USAGE };
