'use strict';
/**
 * ovhost command line. main(argv, { exec, out, env }) returns the exit code, so the tests drive the
 * whole CLI against the fake host.
 */
const lib = require('./index');
const { InventoryError } = require('./inventory');
const { LockedError } = require('./lock');
const { SocketGuardError } = require('./systemd');

const USAGE = `ovhost — OpenVibe.Host operator plane (Stage A)

Usage: ovhost <command> [args] [--inventory <file>] [--json]

  status [<service>...]                  unit state, sha, readiness, protected sessions (all services)
  validate <service>                     env names, unit files, port, nginx vhost + nginx -t, deps
  env-names <service>                    variable NAMES declared in the checkout's .env.example
  plan <service> [--to <sha>] [--no-fetch]
                                         what a deploy would do (fetches the remote; changes nothing else)
  deploy <service> [--wait-idle] [--force] [--restart] [--to <sha>] [--install-units] [--ready-timeout <s>]
  rollback <service> [--to <sha>] [--wait-idle] [--force]
  releases <service> [--limit <n>]       the release log
  certs [--warn-days <n>]                certificates referenced by enabled nginx vhosts, with expiry
  nginx render <service> [--variant http|sse|websocket] [--manifest <file>] [--install]
                                         print a vhost from the service manifest; --install writes it,
                                         runs nginx -t and reloads only if clean
  snapshot <service> [--out <file>]      config tarball: units, vhost, env NAMES, sha — no secret values
  backup <service>                       sqlite .backup of the declared databases to a dated directory

Inventory: --inventory, else $OVHOST_INVENTORY, else /etc/openvibe/host.json.
Exit codes: 0 ok · 1 usage/precondition · 2 validation failed (nothing restarted) · 3 not ready,
rolled back · 4 rollback failed (manual intervention) · 5 protected sessions active
`;

const FLAGS_WITH_VALUE = new Set(['inventory', 'to', 'limit', 'warn-days', 'variant', 'manifest', 'out', 'ready-timeout']);

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

async function main(argv, { exec = lib.createSystemExecutor(), out = (s) => process.stdout.write(`${s}\n`), env = process.env } = {}) {
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
        const inv = await lib.inventory.load(exec, { file: opts.inventory, env });
        const ctx = { exec, inv, log };
        switch (cmd) {
        case 'validate': {
            const r = await lib.validate(ctx, needService());
            if (json) emit(r);
            else {
                for (const f of r.findings) out(`${ICON[f.level]} ${f.area.padEnd(8)} ${f.message}`);
                out(`${r.service}: ${r.ok ? 'valid' : 'NOT valid'} (${r.errors} error(s), ${r.warnings} warning(s))`);
            }
            return r.ok ? 0 : 2;
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
            if (json) emit(r.record);
            else if (r.record.result !== 'unchanged') out(`[ovhost] result: ${r.record.result} (release ${r.record.id})`);
            return r.exitCode;
        }
        case 'status': {
            const rows = await lib.status(ctx, pos.slice(1));
            if (json) { emit(rows); return 0; }
            for (const r of rows) {
                const units = r.units.map((u) => `${u.unit.replace(/\.service$/, '')}=${u.active}${u.restarts ? `(${u.restarts} restarts)` : ''}`).join(' ');
                const sock = r.socket ? ` socket=${r.socket.active}` : '';
                const ready = r.ready ? (r.ready.ok ? 'ready' : `NOT READY (${r.ready.status || r.ready.error})`) : '-';
                const prot = r.protected ? (r.protected.count == null ? ` ${r.protected.label}=unknown` : ` ${r.protected.label}=${r.protected.count}`) : '';
                out(`${r.service.padEnd(10)} ${short(r.sha)} ${ready.padEnd(12)} ${units || '(no units)'}${sock}${prot}${r.managed ? '' : ' [unmanaged]'}`);
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
            if (pos[1] !== 'render') throw new UsageError('usage: ovhost nginx render <service> [--variant …] [--install]');
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
            const r = await lib.backup(ctx, needService());
            if (json) emit(r); else for (const f of r.files) out(f.skipped ? `skipped ${f.source}: ${f.skipped}` : `${f.source} → ${f.dest} (${f.bytes} bytes)`);
            return 0;
        }
        default:
            throw new UsageError(`unknown command "${cmd}"`);
        }
    } catch (err) {
        if (err instanceof UsageError) { out(err.message); return 1; }
        if (err instanceof InventoryError || err instanceof LockedError) { out(`[ovhost] ${err.message}`); return 1; }
        if (err instanceof SocketGuardError) { out(`[ovhost] ${err.message}`); return 1; }
        if (err instanceof lib.OpError) { out(`[ovhost] ✗ ${err.message}`); return err.exitCode; }
        out(`[ovhost] ✗ ${err.message}`);
        return 2;
    }
}

module.exports = { main, parseArgs, USAGE };
