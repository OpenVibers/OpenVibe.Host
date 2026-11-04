'use strict';
// workers/llm-inference/verify-artifact.sh: a pinned artifact is downloaded once, checked against
// the manifest SHA-256 and refused (without leaving a file behind) on any mismatch or placeholder.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const verify = path.join(root, 'workers', 'llm-inference', 'verify-artifact.sh');
const entrypoint = path.join(root, 'workers', 'llm-inference', 'entrypoint.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-artifact-'));
const baseEnv = { ...process.env };
delete baseEnv.ALLOW_LOCAL_ARTIFACT_URL;

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function manifest({ sha, revision = 'c9e90669eeb205d5af35c28a3e9983fc9293c2ec', filename = 'model.gguf', url, schema = 'openvibe.ai.worker-artifact@1' }) {
    return {
        schema,
        artifact: {
            id: `example/qwen3-4b:q4_k_m@${revision}`,
            revision,
            sha256: sha,
            license: 'apache-2.0',
        },
        download: { url, filename },
    };
}

function writeManifest(name, document) {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, JSON.stringify(document, null, 2));
    return file;
}

function run(manifestFile, dest, { allowLocal = true } = {}) {
    const env = { ...baseEnv };
    if (allowLocal) env.ALLOW_LOCAL_ARTIFACT_URL = '1';
    return spawnSync('sh', [verify, manifestFile, dest], { encoding: 'utf8', env });
}

const source = path.join(tmp, 'source.gguf');
fs.writeFileSync(source, 'a small GGUF stand-in, not a model');
const goodSha = sha256(source);

// A correct manifest downloads, verifies and prints the local path on stdout.
const dest1 = path.join(tmp, 'models-1');
const ok = run(writeManifest('good.json', manifest({ sha: goodSha, url: pathToFileURL(source).href })), dest1);
assert.strictEqual(ok.status, 0, ok.stderr);
assert.strictEqual(ok.stdout.trim(), path.join(dest1, 'model.gguf'), 'stdout is only the verified path');
assert.strictEqual(fs.readFileSync(path.join(dest1, 'model.gguf'), 'utf8'), fs.readFileSync(source, 'utf8'));

// A wrong SHA-256 is refused, and neither the final file nor a partial file is left behind.
const dest2 = path.join(tmp, 'models-2');
const wrong = run(writeManifest('wrong.json', manifest({ sha: '0'.repeat(64), url: pathToFileURL(source).href })), dest2);
assert.notStrictEqual(wrong.status, 0, 'wrong hash must fail');
assert.match(wrong.stderr, /SHA-256 mismatch/);
assert.ok(!fs.existsSync(path.join(dest2, 'model.gguf')), 'mismatched file must not be installed');
assert.deepStrictEqual(fs.readdirSync(dest2), [], 'partial download must be removed');

// A TODO placeholder (revision or hash) is refused before any download.
const todo = run(writeManifest('todo.json', manifest({ sha: goodSha, revision: 'TODO: pin the commit', url: pathToFileURL(source).href })), path.join(tmp, 'models-todo'));
assert.notStrictEqual(todo.status, 0);
assert.match(todo.stderr, /TODO placeholder/);

// A manifest cannot write outside its model directory.
const traversal = run(writeManifest('traversal.json', manifest({ sha: goodSha, filename: '../escape.gguf', url: pathToFileURL(source).href })), path.join(tmp, 'models-traversal'));
assert.notStrictEqual(traversal.status, 0);
assert.match(traversal.stderr, /plain file name/);
assert.ok(!fs.existsSync(path.join(tmp, 'escape.gguf')));

// Local URLs are for smoke tests only; production config has to be https.
const local = run(writeManifest('local.json', manifest({ sha: goodSha, url: pathToFileURL(source).href })), path.join(tmp, 'models-local'), { allowLocal: false });
assert.notStrictEqual(local.status, 0);
assert.match(local.stderr, /ALLOW_LOCAL_ARTIFACT_URL/);

// A malformed hash is refused even when its length is not 64.
const shortHash = run(writeManifest('short.json', manifest({ sha: 'abc', url: pathToFileURL(source).href })), path.join(tmp, 'models-short'));
assert.notStrictEqual(shortHash.status, 0);
assert.match(shortHash.stderr, /64 lowercase hex/);

// A cached file that already matches is reused without touching the URL.
const dest4 = path.join(tmp, 'models-cached');
fs.mkdirSync(dest4);
fs.writeFileSync(path.join(dest4, 'model.gguf'), fs.readFileSync(source));
const cached = run(writeManifest('missing-source.json', manifest({ sha: goodSha, url: 'file:///nonexistent/model.gguf' })), dest4);
assert.strictEqual(cached.status, 0, cached.stderr);
assert.strictEqual(cached.stdout.trim(), path.join(dest4, 'model.gguf'));

// The scripts parse under the shell the image uses, and the entrypoint refuses bounded settings
// before it reaches the model or the binaries.
for (const file of [verify, entrypoint]) {
    const syntax = spawnSync('sh', ['-n', file], { encoding: 'utf8' });
    assert.strictEqual(syntax.status, 0, `${file}: ${syntax.stderr}`);
}
const cases = [
    [{ LLM_CTX: '40000', LLM_CTX_MAX: '32768' }, /exceeds LLM_CTX_MAX/],
    [{ LLM_CTX: '1024', LLM_PARALLEL: '4' }, /at least 512 tokens per slot/],
    [{ LLM_KV_TYPE_K: 'magic' }, /LLM_KV_TYPE_K/],
    [{ DRAIN_SECONDS: '0' }, /DRAIN_SECONDS/],
];
for (const [env, pattern] of cases) {
    const refused = spawnSync('sh', [entrypoint], { encoding: 'utf8', env: { ...baseEnv, ...env } });
    assert.notStrictEqual(refused.status, 0, JSON.stringify(env));
    assert.match(refused.stderr, pattern, JSON.stringify(env));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('inference artifact verification: all checks passed');
