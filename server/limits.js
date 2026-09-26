'use strict';
/**
 * GET /limits.json (roadmap WS-N task 7): the limits a developer project meets here, read from the
 * running configuration, so OpenVibe.Codes' limits page (openvibe.codes/docs/limits) shows what is
 * enforced and never restates it. Public: these are the defaults; a project's own override (a
 * host_quotas row staff set) is on its quota page, not here.
 *
 *   limits[]  id, label, capability (the grant it bounds), unit (count | bytes | per_day),
 *             production and sandbox (the project's environment; 0 means none allowed),
 *             exceeded (what the caller gets past it)
 */
function limitsOf(config) {
    const p = config.quotas.production;
    const s = config.quotas.sandbox;
    const row = (id, label, key, unit, exceeded) => ({ id, label, capability: 'host.site.manage', unit, production: p[key], sandbox: s[key], exceeded });
    return {
        service: 'host',
        scope: 'per project and environment; projects per owner',
        limits: [
            { id: 'projects_per_owner', label: 'Projects one person owns', capability: 'host.site.manage', unit: 'count',
                production: config.projects.maxPerOwner, sandbox: config.projects.maxPerOwner, exceeded: '429 quota.projects' },
            row('sites', 'Sites', 'sites', 'count', '429 quota.sites'),
            row('custom_domains', 'Custom domains', 'customDomains', 'count', '429 quota.custom_domains'),
            row('deploys_per_day', 'Deploys in 24 hours', 'deploysPerDay', 'per_day', '429 quota.deploys_per_day'),
            row('storage_bytes', 'Stored bytes (every deploy kept)', 'storageBytes', 'bytes', '413 quota.storage'),
            row('max_files', 'Files in one deploy', 'maxFiles', 'count', '413 quota.max_files'),
            row('max_file_bytes', 'Size of one file', 'maxFileBytes', 'bytes', '413 quota.max_file_bytes'),
        ],
    };
}

function mountLimits(app, config) {
    const body = limitsOf(config);
    app.get('/limits.json', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300').set('Access-Control-Allow-Origin', '*').json(body);
    });
}

module.exports = { limitsOf, mountLimits };
