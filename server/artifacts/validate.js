'use strict';
/**
 * Turn uploaded entries into an immutable deploy manifest, or explain every reason it cannot be one.
 *
 *   manifest = { schema: 'host.deploy-manifest@1', file_count, total_bytes,
 *                files: [{ path, sha256, size, content_type }] }       (sorted by path)
 *   manifest_sha256 = sha256 of that JSON: identical content gives an identical digest.
 *
 * Every problem is collected (up to 50) so the upload log lists them all at once.
 */
const crypto = require('crypto');
const { checkPath, contentTypeFor, PathError } = require('./paths');
const { normaliseName } = require('./archive');

const MAX_PROBLEMS = 50;

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * entries: [{ path, data }]. limits: { maxFiles, maxFileBytes, maxTotalBytes }.
 * -> { ok: true, manifest, manifestSha256, files, warnings } | { ok: false, code, problems, warnings }
 */
function buildManifest(entries, limits) {
    const problems = [];
    const warnings = [];
    const files = [];
    const seen = new Set();
    let total = 0;
    const problem = (code, message) => { if (problems.length < MAX_PROBLEMS) problems.push({ code, message }); };

    if (!entries.length) problem('deploy.empty', 'the upload contains no files');
    if (entries.length > limits.maxFiles) problem('quota.max_files', `${entries.length} files; this project may deploy at most ${limits.maxFiles}`);

    for (const e of entries) {
        const raw = normaliseName(e.path);
        let p;
        try { p = checkPath(raw); } catch (err) {
            if (err instanceof PathError) { problem(err.code === 'path.traversal' || err.code === 'path.absolute' ? 'deploy.path_traversal' : 'deploy.invalid_path', `${JSON.stringify(String(e.path).slice(0, 200))}: ${err.message}`); continue; }
            throw err;
        }
        if (seen.has(p)) { problem('deploy.duplicate_path', `"${p}" appears twice`); continue; }
        seen.add(p);
        const t = contentTypeFor(p);
        if (t.refused) { problem(t.code, `"${p}": ${t.refused}`); continue; }
        if (e.data.length > limits.maxFileBytes) { problem('quota.max_file_bytes', `"${p}" is ${e.data.length} bytes; the limit per file is ${limits.maxFileBytes}`); continue; }
        total += e.data.length;
        files.push({ path: p, sha256: sha256(e.data), size: e.data.length, content_type: t.contentType, data: e.data });
    }
    if (total > limits.maxTotalBytes) problem('deploy.too_large', `the files add up to ${total} bytes; at most ${limits.maxTotalBytes} are allowed`);

    // A path cannot be both a file and a directory ("a" and "a/b.html").
    for (const p of seen) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) {
            const dir = parts.slice(0, i).join('/');
            if (seen.has(dir)) problem('deploy.path_conflict', `"${dir}" is both a file and a directory`);
        }
    }

    if (problems.length) {
        const first = problems[0].code;
        return { ok: false, code: first, problems, warnings };
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (!seen.has('index.html')) warnings.push('there is no index.html at the root: the site\'s home page will be the 404 page');
    const manifest = {
        schema: 'host.deploy-manifest@1',
        file_count: files.length,
        total_bytes: total,
        files: files.map(({ path, sha256: h, size, content_type }) => ({ path, sha256: h, size, content_type })),
    };
    const json = JSON.stringify(manifest);
    return { ok: true, manifest, manifestJson: json, manifestSha256: sha256(json), files, warnings };
}

module.exports = { buildManifest, sha256 };
