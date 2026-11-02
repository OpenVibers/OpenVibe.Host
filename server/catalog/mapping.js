'use strict';

// Only these keys may create a provider. A Sources api item (sources.item@1, the `api` adapter) carries the plan's id as
// `identity`, its label (Linode) as `title`, and the endpoint's mapped `extra` fields flat in `fields`, as the API gave them.
const SOURCES = Object.freeze({
    'vultr-plans': { slug: 'vultr', name: 'Vultr', homepage_url: 'https://www.vultr.com/', source_url: 'https://www.vultr.com/pricing/' },
    'linode-types': { slug: 'linode', name: 'Linode', homepage_url: 'https://www.linode.com/', source_url: 'https://www.linode.com/pricing/' },
    'aws-lightsail-bundles': { slug: 'aws-lightsail', name: 'Amazon Lightsail', homepage_url: 'https://aws.amazon.com/lightsail/', source_url: 'https://aws.amazon.com/lightsail/pricing/' },
    'ovhcloud-vps': { slug: 'ovhcloud', name: 'OVHcloud', homepage_url: 'https://us.ovhcloud.com/', source_url: 'https://us.ovhcloud.com/vps/' },
    'azure-retail-prices': { slug: 'azure', name: 'Microsoft Azure', homepage_url: 'https://azure.microsoft.com/', source_url: 'https://azure.microsoft.com/en-us/pricing/' },
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
        ipv4: ipv6Only ? 0 : 1, locations: typeof x.location === 'string' && x.location ? [x.location] : null, unmetered: null, port_mbps: null,
    };
}
// OVHcloud's public catalog (Sources `ovhcloud-vps`): the plan's hardware joined from its product, and its monthly
// no-commitment price in hundred-millionths of the currency (535000000 is the $5.35 VPS-1). Traffic is unmetered at
// the plan's bandwidth, which is a port speed in Mbit/s, not a transfer allowance.
function ovhcloud(x, id, title) {
    if (x.currency !== 'USD') throw new TypeError('OVHcloud price is not in USD');
    const units = number(x.price_monthly, 'monthly price');
    if (units == null) throw new TypeError('missing monthly price');
    const monthly = Math.round(units / 1e6) / 100;
    if (monthly <= 0) return null;
    const memoryGb = number(x.memory_gb, 'memory');
    const unmetered = x.bandwidth_unlimited === true;
    return {
        name: (typeof title === 'string' && title.trim()) || id, kind: 'vps',
        vcpu: number(x.vcpu, 'vcpu'), ram_mb: memoryGb == null ? null : Math.round(memoryGb * 1024),
        disk_gb: number(x.disk_gb, 'disk'),
        disk_type: /nvme/i.test(String(x.disk_interface || '')) ? 'nvme' : /ssd/i.test(String(x.disk_technology || '')) ? 'ssd' : null,
        bandwidth_gb: null, unmetered: unmetered || null, port_mbps: number(x.bandwidth_mbps, 'bandwidth'),
        price_monthly: monthly, price_hourly: null, ipv4: null, locations: null,
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

// Microsoft Azure's retail price list (Sources `azure-retail-prices`): one row per meter, region and SKU. A virtual
// machine is priced by the hour (0.922 an hour is the D96s v5 in eastus) and Azure bills by the hour, so a month is
// 730 hours; a storage row is priced per GB per month and says so in its name. The row's effective date is the
// observation time, so a price change is dated by the day it took effect (Host #210).
function azure(x, id, title) {
    if (x.currency != null && x.currency !== 'USD') throw new TypeError('Azure price is not in USD');
    const price = number(x.price, 'price');
    if (price == null) throw new TypeError('missing price');
    const unit = String(x.unit || '');
    const region = typeof x.region === 'string' && x.region ? x.region : null;
    const meter = typeof x.meter_name === 'string' ? x.meter_name : '';
    const plain = { vcpu: null, ram_mb: null, disk_gb: null, disk_type: null, bandwidth_gb: null, ipv4: null, unmetered: null, port_mbps: null, locations: region ? [region] : null };
    if (/hour/i.test(unit)) {
        const monthly = Math.round(price * 730 * 100) / 100;
        if (monthly <= 0) return null;
        const variant = /spot/i.test(meter) ? ' (Spot)' : /low priority/i.test(meter) ? ' (Low Priority)' : '';
        return { ...plain, name: `${(typeof title === 'string' && title.trim()) || id}${variant}`, kind: 'cloud', price_monthly: monthly, price_hourly: price };
    }
    if (/gb\/month/i.test(unit)) {
        return { ...plain, name: `${(typeof title === 'string' && title.trim()) || id} (per GB/month)`, kind: 'storage', price_monthly: price, price_hourly: null };
    }
    throw new TypeError('unknown Azure price unit');
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
        // Every price the mappers below read is the source's monthly price (Lightsail's and Azure's hourly rates
        // become a month's worth, OVHcloud is its commitment=0 one-month price), so the row's term is monthly. No
        // source states a renewal price for a server plan, so it stays unknown rather than guessed.
        price_term: 'monthly', renewal_price: null,
    };
    if (item.source_key === 'aws-lightsail-bundles') return { ...common, ...lightsail(x, id) };
    if (item.source_key === 'azure-retail-prices') {
        const plan = azure(x, id, item.title);
        if (!plan) return null;
        // The row's own effective date is when the price took effect: it is the observation time the price trend
        // (catalog_price_changes, Host #210) is dated by.
        const effective = Date.parse(x.effective_start || '');
        const observed = Number.isFinite(effective) ? effective : common.checked_at;
        const region = typeof x.region === 'string' && x.region ? x.region : null;
        return { ...common, ...plan, external_id: region ? `${id}@${region}` : id, checked_at: observed };
    }
    if (item.source_key === 'ovhcloud-vps') {
        const plan = ovhcloud(x, id, item.title);
        return plan && { ...common, ...plan };
    }
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
        ipv4: null, locations: null, unmetered: null, port_mbps: null,
    };
}
module.exports = { SOURCES, mapItem };
