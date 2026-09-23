'use strict';
/**
 * Every API and dashboard response is built from these allowlists, never from raw rows. Host
 * stores no tenant secrets in Stage B (no environment variables, no build secrets, no deploy keys),
 * and nothing here exposes Host's own configuration. The one value that looks like a token, a
 * custom domain's TXT verification value, is public by design (it is published in DNS) and is
 * only shown to the project's members.
 */
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function project(p, { role = null, quota = null, usage = null } = {}) {
    return {
        id: p.id,
        name: p.name,
        environment: p.environment,
        network_project_id: p.network_project_id || null,
        owner: p.owner_subject,
        role: role || p.role || null,
        created_at: iso(p.created_at),
        ...(quota ? { quota: quotaOut(quota) } : {}),
        ...(usage ? { usage: usageOut(usage) } : {}),
    };
}

function quotaOut(q) {
    return {
        storage_bytes: q.storageBytes, deploys_per_day: q.deploysPerDay, max_files: q.maxFiles,
        max_file_bytes: q.maxFileBytes, sites: q.sites, custom_domains: q.customDomains,
    };
}

function usageOut(u) {
    return { storage_bytes: u.storageBytes, objects: u.objects, deploys_last_24h: u.deploysLast24h, sites: u.sites, custom_domains: u.customDomains };
}

function site(s, { hostname, url }) {
    return {
        id: s.id,
        project_id: s.project_id,
        name: s.name,
        hostname,
        url,
        active_deploy_id: s.active_deploy_id || null,
        created_at: iso(s.created_at),
        updated_at: iso(s.updated_at),
    };
}

function deploy(d, { active = false, files = null, log = null } = {}) {
    return {
        id: d.id,
        site_id: d.site_id,
        project_id: d.project_id,
        state: d.state,
        active,
        source: d.source,
        file_count: d.file_count,
        total_bytes: d.total_bytes,
        new_bytes: d.new_bytes,
        manifest_sha256: d.manifest_sha256 || null,
        failure_code: d.failure_code || null,
        created_by: d.created_by,
        created_at: iso(d.created_at),
        ...(files ? { files: files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, content_type: f.content_type })) } : {}),
        ...(log ? { log: log.map(logLine) } : {}),
    };
}

function logLine(l) {
    return { level: l.level, message: l.message, at: iso(l.created_at) };
}

function domain(d, instructions = null) {
    return {
        id: d.id,
        site_id: d.site_id,
        hostname: d.hostname,
        kind: d.kind,
        status: d.status,
        served: d.status === 'verified',
        verified_at: iso(d.verified_at),
        last_checked_at: iso(d.last_checked_at),
        last_error: d.last_error || null,
        ...(instructions ? { instructions } : {}),
    };
}

function activation(a) {
    return { deploy_id: a.deploy_id, previous_deploy_id: a.previous_deploy_id || null, kind: a.kind, actor: a.actor, at: iso(a.created_at) };
}

module.exports = { project, quotaOut, usageOut, site, deploy, logLine, domain, activation, iso };
