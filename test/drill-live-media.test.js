'use strict';
/**
 * The example inventory's live and media drills (LIVE_DRILL, OpenVibe.Live 8a58aea; MEDIA_DRILL,
 * OpenVibe.Media 6e74eb0), run by `ovhost drill` on the fake host:
 *   - live: the production unit's ExecStart from its own checkout with LIVE_DRILL=1, the copy as
 *     DB_PATH and {tmp}/data as DATA_DIR (created before the start); DB-only reads compared, the
 *     values production changes while someone is live ignored; the socket and the service untouched.
 *   - media: MEDIA_DRILL=1, the copy as DB_PATH, every storage path but the thumbnail listing moved
 *     under {tmp}/storage and never created; the /browse pages compared byte for byte.
 *   - a checkout without the switch is refused before anything is created (an older release would
 *     ignore LIVE_DRILL / MEDIA_DRILL and run its side effects).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scenario, test, runTests, SECRET } = require('./helpers');
const { normalise } = require('../lib/inventory');

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'host.example.json'), 'utf8'));
const LIVE_DB = '/opt/openvibe.live/data/live.db';
const MEDIA_DB = '/opt/openvibe.media/data/media.db';

const envOf = (text) => Object.fromEntries(text.trim().split('\n').filter((l) => !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const stateChanges = (host) => host.calls.filter((c) => c.cmd === 'systemctl' && !['show', 'is-active', 'is-enabled', 'cat', 'status', 'list-units'].includes(c.args[0]));

/** Production answers and the drill instance's answers for the compared paths. */
function liveBodies({ drill }) {
    const stream = { id: 7, title: 'Morning walk', user_id: 327, username: 'japaneseoldguy', protocol: 'webrtc', is_live: 1, channel: { id: 105, user_id: 327, title: 'Walks' } };
    const live = drill
        ? { ...stream, viewer_count: 0, peak_viewers: 3, external_viewer_count: 0, total_viewer_count: 0, last_heartbeat: '2026-09-24 10:00:00', thumbnail_url: 'https://openvibe.media/t/stream-7-1.jpg' }
        : { ...stream, viewer_count: 12, peak_viewers: 14, external_viewer_count: 5, total_viewer_count: 17, last_heartbeat: '2026-09-24 10:00:30', thumbnail_url: 'https://openvibe.media/t/stream-7-2.jpg' };
    const { external_viewer_count, total_viewer_count, channel, ...row } = live;
    const slot = { managed_stream_id: 3, slug: 'walks', title: 'Walks', last_live_at: '2026-09-23 21:00:00', vod_thumbnail: drill ? null : 'https://openvibe.media/t/vod-99-1.jpg' };
    return {
        '/api/themes': '{"themes":[{"id":1,"slug":"vibe","name":"Vibe"}]}',
        '/api/emotes/global': '{"emotes":[{"id":"custom-1","code":"ovWave"}]}',
        '/api/streams': JSON.stringify({ streams: [live] }),
        '/api/streams/recently-online?limit=20': JSON.stringify({ streamers: [{ user_id: 327, username: 'japaneseoldguy', managed_streams: [slot] }], total: 1, limit: 20, offset: 0, hasMore: false }),
        // The channel's live-only answer carries the stream row, its endpoint and recording state; no external counts.
        '/api/streams/channel/japaneseoldguy/live': JSON.stringify({ channel: { username: 'JapaneseOldGuy', display_name: 'JapaneseOldGuy', user_id: 327 }, streams: [{ ...row, server_clip: !drill, endpoint: { roomId: 'stream-7' } }] }),
    };
}

async function liveHost({ switchInCheckout = true, drillBodies = null } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.live = JSON.parse(JSON.stringify(EXAMPLE.services.live));
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    if (switchInCheckout) {
        host.put('/opt/openvibe.live/server/drill.js', "const enabled = parse(process.env.LIVE_DRILL);\n", { owner: 'ubuntu' });
        host.put('/opt/openvibe.live/server/paths.js', "return path.resolve(process.env.DATA_DIR || './data');\n", { owner: 'ubuntu' });
    }
    host.put('/etc/systemd/system/openvibe-live.service', [
        '[Service]', 'Type=simple', 'User=ubuntu', 'WorkingDirectory=/opt/openvibe.live', 'EnvironmentFile=/etc/openvibe/live.env',
        'Environment=NODE_ENV=production', 'Environment=PATH=/usr/local/bin:/usr/bin:/bin',
        'ExecStart=/usr/bin/env node /opt/openvibe.live/server/index.js', 'ReadWritePaths=/opt/openvibe.live/data', '',
    ].join('\n'));
    host.put('/etc/systemd/system/openvibe-live.service.d/socket.conf', '[Unit]\nRequires=openvibe-live.socket\nAfter=openvibe-live.socket\n');
    const unit = host.units.get('openvibe-live.service');
    unit.dropIns = ['/etc/systemd/system/openvibe-live.service.d/socket.conf'];
    host.alivePids.add(unit.mainPid);
    host.listeners.set(3000, [{ pid: unit.mainPid, process: 'node' }]);
    host.put(LIVE_DB, 'sqlite-production', { owner: 'ubuntu', mode: 0o640 });

    const prod = liveBodies({ drill: false });
    host.http.set('http://127.0.0.1:3000/api/ready', () => ({ status: 200, body: { ready: true } }));
    for (const [p, body] of Object.entries(prod)) host.http.set(`http://127.0.0.1:3000${p}`, () => ({ status: 200, body }));
    const counts = { users: 393, channels: 180, managed_streams: 140, streams: 5120, follows: 910, chat_messages: 250000 };
    host.sqliteHandler = (db, sql) => {
        if (/integrity_check/.test(sql)) return [{ integrity_check: 'ok' }];
        const m = /FROM "([a-z_]+)"/.exec(sql);
        return [{ n: m ? counts[m[1]] ?? 0 : 0 }];
    };
    host.onSystemdRun = (spec) => {
        const envFile = spec.envFiles[spec.envFiles.length - 1];
        host.drillEnv = host.read(envFile);
        host.dataDirAtStart = !!host.files.get(path.join(path.dirname(envFile), 'data'));
        host.listeners.set(13000, [{ pid: spec.pid, process: 'node' }]);
        const alive = (fn) => () => (host.alivePids.has(spec.pid) ? fn() : { status: 0, error: 'ECONNREFUSED' });
        host.http.set('http://127.0.0.1:13000/api/ready', alive(() => ({ status: 200, body: { ready: true, mode: 'drill' } })));
        for (const [p, body] of Object.entries(drillBodies || liveBodies({ drill: true }))) host.http.set(`http://127.0.0.1:13000${p}`, alive(() => ({ status: 200, body })));
        return undefined;
    };
    const b = await host.cli('backup', 'live', '--json');
    assert.strictEqual(b.code, 0, b.out);
    host.advance(60 * 1000);
    return host;
}

const BROWSE = (tab) => `<!DOCTYPE html><html><body><nav class="tabs"><a href="/?tab=${tab}">Videos<span class="n">1,204</span></a><a>Thumbnails<span class="n">5,120</span></a></nav><div class="grid">…</div></body></html>`;

async function mediaHost({ switchInCheckout = true } = {}) {
    const host = scenario();
    const doc = JSON.parse(host.read('/etc/openvibe/host.json'));
    doc.services.media = JSON.parse(JSON.stringify(EXAMPLE.services.media));
    host.put('/etc/openvibe/host.json', JSON.stringify(doc, null, 2), { mode: 0o640, owner: 'root' });
    if (switchInCheckout) {
        host.put('/opt/openvibe.media/server/drill.js', "const enabled = parse(process.env.MEDIA_DRILL);\n", { owner: 'ubuntu' });
        host.put('/opt/openvibe.media/server/public/routes.js', "if (drill.refuseBytes(res)) return;\n", { owner: 'ubuntu' });
    }
    host.put('/etc/systemd/system/openvibe-media.service', [
        '[Service]', 'Type=simple', 'User=ubuntu', 'WorkingDirectory=/opt/openvibe.media', 'EnvironmentFile=/etc/openvibe/media.env',
        'ExecStart=/usr/bin/env node /opt/openvibe.media/server/index.js', 'ReadWritePaths=/opt/openvibe.media/data', '',
    ].join('\n'));
    const unit = host.units.get('openvibe-media.service');
    host.alivePids.add(unit.mainPid);
    host.listeners.set(4100, [{ pid: unit.mainPid, process: 'node' }]);
    host.put(MEDIA_DB, 'sqlite-production', { owner: 'ubuntu', mode: 0o640 });
    host.http.set('http://127.0.0.1:4100/api/ready', () => ({ status: 200, body: { ready: true } }));
    for (const tab of ['videos', 'clips']) host.http.set(`http://127.0.0.1:4100/browse?tab=${tab}`, () => ({ status: 200, body: BROWSE(tab) }));
    const counts = { media_objects: 6021, vods: 1300, clips: 4700, apps: 4 };
    host.sqliteHandler = (db, sql) => {
        if (/integrity_check/.test(sql)) return [{ integrity_check: 'ok' }];
        if (/is_recording/.test(sql)) return [{ n: 0 }];
        const m = /FROM "([a-z_]+)"/.exec(sql);
        return [{ n: m ? counts[m[1]] ?? 0 : 0 }];
    };
    host.onSystemdRun = (spec) => {
        const envFile = spec.envFiles[spec.envFiles.length - 1];
        host.drillEnv = host.read(envFile);
        host.drillDirAtStart = [...host.files.keys()].filter((f) => f.startsWith(`${path.dirname(envFile)}/`)).map((f) => path.relative(path.dirname(envFile), f)).sort();
        host.listeners.set(14100, [{ pid: spec.pid, process: 'node' }]);
        const alive = (fn) => () => (host.alivePids.has(spec.pid) ? fn() : { status: 0, error: 'ECONNREFUSED' });
        host.http.set('http://127.0.0.1:14100/api/ready', alive(() => ({ status: 200, body: { ready: true, mode: 'drill' } })));
        for (const tab of ['videos', 'clips']) host.http.set(`http://127.0.0.1:14100/browse?tab=${tab}`, alive(() => ({ status: 200, body: BROWSE(tab) })));
        return undefined;
    };
    const b = await host.cli('backup', 'media', '--json');
    assert.strictEqual(b.code, 0, b.out);
    host.advance(60 * 1000);
    return host;
}

runTests([
    test('the example inventory: live and media drills are supported, on 13000 and 14100, with their switches', () => {
        const inv = normalise(EXAMPLE);
        const live = inv.services.live.drill;
        assert.strictEqual(live.supported, true);
        assert.strictEqual(live.port, 13000);
        assert.deepStrictEqual(live.databases, { live: { env: 'DB_PATH', dir: false } });
        assert.strictEqual(live.env.LIVE_DRILL, '1');
        assert.strictEqual(live.env.DATA_DIR, '{tmp}/data');
        assert.strictEqual(live.env.HOST, '127.0.0.1');
        assert.deepStrictEqual(live.dirs, ['{tmp}/data']);
        assert.deepStrictEqual(live.requires.map((r) => r.contains), ['LIVE_DRILL', 'DATA_DIR']);
        assert.deepStrictEqual(live.counts.map((c) => c.table), ['users', 'channels', 'managed_streams', 'streams', 'follows', 'chat_messages']);
        assert.ok(!live.outbound && !live.bind.length);
        const media = inv.services.media.drill;
        assert.strictEqual(media.supported, true);
        assert.strictEqual(media.port, 14100);
        assert.deepStrictEqual(media.databases, { media: { env: 'DB_PATH', dir: false } });
        assert.strictEqual(media.env.MEDIA_DRILL, '1');
        for (const k of ['VOD_PATH', 'CLIPS_PATH', 'PASTES_PATH', 'ASSETS_PATH', 'FILES_PATH', 'OBJECTS_PATH']) assert.match(media.env[k], /^\{tmp\}\/storage\//, k);
        assert.ok(!('THUMBNAILS_PATH' in media.env), '/browse lists production\'s thumbnail directory');
        assert.deepStrictEqual(media.requires.map((r) => r.contains), ['MEDIA_DRILL', 'refuseBytes']);
        assert.deepStrictEqual(media.compare.map((c) => c.path), ['/browse?tab=videos', '/browse?tab=clips']);
        assert.deepStrictEqual(media.counts.map((c) => c.table), ['media_objects', 'vods', 'clips', 'apps']);
    }),

    test('ovhost drill live: LIVE_DRILL=1 from the production unit, copy + DATA_DIR in the drill directory, live values ignored, production untouched', async () => {
        const host = await liveHost();
        const callsBefore = host.calls.length;
        const r = await host.cli('drill', 'live');
        assert.strictEqual(r.code, 0, r.out);
        const rec = JSON.parse(host.read('/var/lib/openvibe-host/drills/live.jsonl').trim().split('\n').pop());
        assert.strictEqual(rec.result, 'passed', JSON.stringify(rec.failure));
        assert.deepStrictEqual(rec.compare.map((c) => [c.path, c.match]), [
            ['/api/themes', true], ['/api/emotes/global', true], ['/api/streams', true],
            ['/api/streams/recently-online?limit=20', true], ['/api/streams/channel/japaneseoldguy/live', true],
        ]);
        assert.deepStrictEqual(rec.databases.map((d) => d.name), ['live'], 'rs-companion.db is not restored');
        assert.deepStrictEqual(rec.counts.map((c) => [c.table, c.match]), [['users', true], ['channels', true], ['managed_streams', true], ['streams', true], ['follows', true], ['chat_messages', true]]);

        assert.strictEqual(host.systemdRuns.length, 1);
        const run = host.systemdRuns[0];
        assert.deepStrictEqual(run.argv, ['/usr/bin/env', 'node', '/opt/openvibe.live/server/index.js']);
        assert.strictEqual(run.cwd, '/opt/openvibe.live');
        assert.deepStrictEqual(run.envFiles, ['/etc/openvibe/live.env', `${rec.dir}/drill.env`]);
        for (const p of ['SocketBindAllow=tcp:13000', 'SocketBindDeny=any', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'ProtectSystem=strict', `ReadWritePaths=${rec.dir}`, 'Environment=NODE_ENV=production']) assert.ok(run.props.includes(p), p);
        assert.ok(!run.props.some((p) => /BindPaths=|ReadWritePaths=\/opt/.test(p)), 'no bind mounts; production\'s data directory is not writable');
        assert.deepStrictEqual(envOf(host.drillEnv), {
            PORT: '13000', HOST: '127.0.0.1', LIVE_DRILL: '1', DATA_DIR: `${rec.dir}/data`,
            EVENTS_URL: '', OV_OAUTH_CLIENT_SECRET: '', MEDIA_URL: 'http://127.0.0.1:9', DB_PATH: `${rec.dir}/db/live.db`,
        });
        assert.ok(host.dataDirAtStart, 'DATA_DIR exists before the instance starts');

        const calls = host.calls.slice(callsBefore);
        assert.deepStrictEqual(calls.filter((c) => c.cmd === 'kill').map((c) => c.args), [['SIGTERM', run.pid]], 'only the drill instance is signalled');
        assert.deepStrictEqual(stateChanges(host), [], 'no unit was started, stopped or restarted');
        assert.deepStrictEqual(host.socketViolations(), []);
        assert.strictEqual(host.units.get('openvibe-live.socket').active, 'active');
        assert.strictEqual(host.read(LIVE_DB), 'sqlite-production');
        assert.ok(!(r.out + JSON.stringify(host.systemdRuns) + host.read('/var/lib/openvibe-host/drills/live.jsonl')).includes(SECRET));
    }),

    test('ovhost drill live: a difference outside the ignored live values fails the drill', async () => {
        const drill = liveBodies({ drill: true });
        drill['/api/streams'] = drill['/api/streams'].replace('Morning walk', 'Evening walk');
        const host = await liveHost({ drillBodies: drill });
        const r = await host.cli('drill', 'live');
        assert.strictEqual(r.code, 2, r.out);
        const rec = JSON.parse(host.read('/var/lib/openvibe-host/drills/live.jsonl').trim().split('\n').pop());
        const streams = rec.compare.find((c) => c.path === '/api/streams');
        assert.strictEqual(streams.match, false);
        assert.match(streams.detail, /\$\.streams\[0\]\.title/);
    }),

    test('ovhost drill media: MEDIA_DRILL=1, storage under {tmp}/storage and never created, /browse byte for byte', async () => {
        const host = await mediaHost();
        const r = await host.cli('drill', 'media');
        assert.strictEqual(r.code, 0, r.out);
        const rec = JSON.parse(host.read('/var/lib/openvibe-host/drills/media.jsonl').trim().split('\n').pop());
        assert.strictEqual(rec.result, 'passed', JSON.stringify(rec.failure));
        assert.deepStrictEqual(rec.compare.map((c) => [c.path, c.match, c.mode]), [['/browse?tab=videos', true, 'bytes'], ['/browse?tab=clips', true, 'bytes']]);
        assert.deepStrictEqual(rec.counts.map((c) => [c.table, c.production, c.match]), [['media_objects', 6021, true], ['vods', 1300, true], ['clips', 4700, true], ['apps', 4, true]]);
        const run = host.systemdRuns[0];
        assert.deepStrictEqual(run.argv, ['/usr/bin/env', 'node', '/opt/openvibe.media/server/index.js']);
        assert.ok(run.props.includes('SocketBindAllow=tcp:14100'));
        const env = envOf(host.drillEnv);
        assert.deepStrictEqual(env, {
            PORT: '14100', HOST: '127.0.0.1', MEDIA_DRILL: '1',
            VOD_PATH: `${rec.dir}/storage/vods`, CLIPS_PATH: `${rec.dir}/storage/clips`, PASTES_PATH: `${rec.dir}/storage/pastes`,
            ASSETS_PATH: `${rec.dir}/storage/assets`, FILES_PATH: `${rec.dir}/storage/files`, OBJECTS_PATH: `${rec.dir}/storage/objects`,
            EVENTS_URL: '', OV_OAUTH_CLIENT_SECRET: '', DB_PATH: `${rec.dir}/db/media.db`,
        });
        assert.deepStrictEqual(host.drillDirAtStart, ['db', 'db/media.db', 'drill.env'], 'nothing but the copy and the override file; storage is never created');
        assert.deepStrictEqual(stateChanges(host), []);
        assert.strictEqual(host.read(MEDIA_DB), 'sqlite-production');
        assert.ok(!(r.out + JSON.stringify(host.systemdRuns)).includes(SECRET));
    }),

    test('a checkout without the drill switch is refused before anything is created', async () => {
        for (const [id, mk, want] of [['live', liveHost, /LIVE_DRILL in server\/drill\.js \(file not found\); DATA_DIR in server\/paths\.js \(file not found\)/], ['media', mediaHost, /MEDIA_DRILL in server\/drill\.js \(file not found\)/]]) {
            const host = await mk({ switchInCheckout: false });
            const r = await host.cli('drill', id);
            assert.strictEqual(r.code, 1, r.out);
            assert.match(r.out, want);
            assert.match(r.out, /Deploy a release with the drill switch first/);
            assert.strictEqual(host.systemdRuns.length, 0);
            assert.ok(![...host.files.keys()].some((f) => f.startsWith('/var/lib/openvibe-drills/')), 'no drill directory');
        }
    }),
]);
