'use strict';

// Only these keys may create a provider. A Sources api item (sources.item@1, the `api` adapter) carries the plan's id as
// `identity`, its label (Linode) as `title`, and the endpoint's mapped `extra` fields flat in `fields`, as the API gave them.
const SOURCES = Object.freeze({
    'vultr-plans': { slug: 'vultr', name: 'Vultr', homepage_url: 'https://www.vultr.com/', source_url: 'https://www.vultr.com/pricing/' },
    'linode-types': { slug: 'linode', name: 'Linode', homepage_url: 'https://www.linode.com/', source_url: 'https://www.linode.com/pricing/' },
    'aws-lightsail-bundles': { slug: 'aws-lightsail', name: 'Amazon Lightsail', homepage_url: 'https://aws.amazon.com/lightsail/', source_url: 'https://aws.amazon.com/lightsail/pricing/' },
});
const number = (v, field) => {
    if (v == null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`${field} must be a non-negative number`);
    return v;
};
// AWS's price list gives every number as text: "2" vCPUs, "0.5GB" of memory, "1TB" of transfer, "0.0067200000" an hour.
const decimal = (v, field) => {
    if (v == null) return null;
    if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v.trim())) throw new TypeError(`${field} must be a decimal`);
    return Number(v.trim());
};
const sizeGb = (v, field) => {
    if (v == null) return null;
    const m = typeof v === 'string' && /^(\d+(?:\.\d+)?)\s*(GB|TB)$/i.exec(v.trim());
    if (!m) throw new TypeError(`${field} must be a size in GB or TB`);
    return Number(m[1]) * (m[2].toUpperCase() === 'TB' ? 1000 : 1);
};
const LIGHTSAIL_FAMILIES = { BundleUsage: 'General purpose', ComputeOptimizedBundleUsage: 'Compute-optimized', MemoryOptimizedBundleUsage: 'Memory-optimized' };
// "USE1-BundleUsage:0.5GB_IPv6" is the general-purpose 0.5 GB bundle without a public IPv4 address.
function lightsailName(usagetype, memoryGb) {
    const m = /^[A-Z0-9]+-([A-Za-z]+):([0-9.]+GB)(_IPv6)?$/.exec(typeof usagetype === 'string' ? usagetype : '');
    if (!m) return null;
    const family = LIGHTSAIL_FAMILIES[m[1]] || m[1];
    return `${family} ${memoryGb != null ? `${memoryGb} GB` : m[2]}${m[3] ? ' (IPv6 only)' : ''}`;
}
function lightsail(x, id) {
    if (x.price_unit !== 'Hrs') throw new TypeError('Lightsail price is not hourly');
    const hourly = decimal(x.price_hourly, 'hourly price');
    if (hourly == null) throw new TypeError('missing hourly price');
    const memoryGb = sizeGb(x.memory, 'memory');
    const ipv6Only = /_IPv6$/.test(x.usagetype || '');
    return {
        name: lightsailName(x.usagetype, memoryGb) || id, kind: 'vps',
        vcpu: decimal(x.vcpu, 'vcpu'), ram_mb: memoryGb == null ? null : Math.round(memoryGb * 1024),
        disk_gb: sizeGb(x.storage, 'storage'), disk_type: 'ssd', bandwidth_gb: sizeGb(x.transfer, 'transfer'),
        // Lightsail bills a bundle by the hour up to its monthly price, which is the hourly rate for 744 hours (a 31-day
        // month): 0.00672 an hour is the $5.00 bundle AWS lists.
        price_monthly: Math.round(hourly * 744 * 100) / 100, price_hourly: hourly,
        ipv4: ipv6Only ? 0 : 1, locations: typeof x.location === 'string' && x.location ? [x.location] : null,
    };
}
// Vultr's plan types as its pricing page names them; a plan is named from its type, CPU vendor, vCPUs and memory
// ("High Performance AMD · 1 vCPU, 1 GB"), never by its API id alone.
const VULTR_TYPES = Object.freeze({ vc2: 'Cloud Compute', vhf: 'High Frequency', vhp: 'High Performance', voc: 'Optimized Cloud', vcg: 'Cloud GPU', vbm: 'Bare Metal', vdc: 'Dedicated Cloud' });
function vultrName(x, id) {
    const type = VULTR_TYPES[x.type];
    const vcpu = Number(x.vcpu_count), ram = Number(x.ram);
    if (!type || !Number.isFinite(vcpu) || !Number.isFinite(ram) || ram <= 0) return id;
    const vendor = /-amd$/.test(id) ? ' AMD' : /-intel$/.test(id) ? ' Intel' : '';
    const memory = ram >= 1024 ? `${Math.round((ram / 1024) * 10) / 10} GB` : `${ram} MB`;
    return `${type}${vendor} · ${vcpu} vCPU, ${memory}`;
}

function mapItem(item) {
    const provider = SOURCES[item && item.source_key];
    if (!provider) return null;
    if (item.category !== 'hosting' || !item.fields || typeof item.fields !== 'object' || !item.provenance || !item.provenance.retrieved_at || !item.provenance.first_seen_at) throw new TypeError('incomplete hosting item');
    const x = item.fields;
    const id = typeof item.identity === 'string' ? item.identity.trim() : '';
    if (!id || id.length > 200 || (!Number.isFinite(Date.parse(item.provenance.retrieved_at)) || !Number.isFinite(Date.parse(item.provenance.first_seen_at)))) throw new TypeError('invalid plan identity or fetch time');
    const common = {
        provider, external_id: id, currency: 'USD', source_key: item.source_key, source_item_id: item.id,
        source_url: provider.source_url, checked_at: Date.parse(item.provenance.retrieved_at), first_seen_at: Date.parse(item.provenance.first_seen_at),
    };
    if (item.source_key === 'aws-lightsail-bundles') return { ...common, ...lightsail(x, id) };
    const vultr = item.source_key === 'vultr-plans';
    const monthly = number(vultr ? x.monthly_cost : x.price_monthly, 'monthly price');
    if (monthly == null) throw new TypeError('missing monthly price');
    // A free tier (Vultr's "-free" plan answers $0 with conditions attached) is not a price to compare: held, not listed.
    if (monthly <= 0 || (vultr && /-free$/.test(id))) return null;
    const disks = vultr && x.disk_count != null ? number(x.disk_count, 'disk count') : 1;
    return {
        ...common, name: vultr ? vultrName(x, id) : ((typeof item.title === 'string' && item.title.trim()) || id),
        kind: vultr && ['vdc', 'vbm'].includes(x.type) ? 'dedicated' : 'cloud',
        vcpu: number(vultr ? x.vcpu_count : x.vcpus, 'vcpu'),
        ram_mb: number(vultr ? x.ram : x.memory, 'ram'),
        disk_gb: vultr ? (x.disk == null ? null : number(x.disk, 'disk') * (disks || 1)) : (x.disk == null ? null : number(x.disk, 'disk') / 1024),
        disk_type: vultr ? (['vhf', 'vhp'].includes(x.type) ? 'nvme' : x.type === 'vc2' ? 'ssd' : null) : null,
        bandwidth_gb: number(vultr ? x.bandwidth : x.transfer, 'bandwidth'),
        price_monthly: monthly, price_hourly: number(vultr ? x.hourly_cost : x.price_hourly, 'hourly price'),
        ipv4: null, locations: null,
    };
}
module.exports = { SOURCES, mapItem };
