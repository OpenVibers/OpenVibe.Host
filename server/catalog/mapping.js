'use strict';

// Only these keys may create a provider. A Sources api item (sources.item@1, the `api` adapter) carries the plan's id as
// `identity`, its label (Linode) as `title`, and the endpoint's mapped `extra` fields flat in `fields`, as the API gave them.
const SOURCES = Object.freeze({
    'vultr-plans': { slug: 'vultr', name: 'Vultr', homepage_url: 'https://www.vultr.com/', source_url: 'https://www.vultr.com/pricing/' },
    'linode-types': { slug: 'linode', name: 'Linode', homepage_url: 'https://www.linode.com/', source_url: 'https://www.linode.com/pricing/' },
});
const number = (v, field) => {
    if (v == null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`${field} must be a non-negative number`);
    return v;
};
function mapItem(item) {
    const provider = SOURCES[item && item.source_key];
    if (!provider) return null;
    if (item.category !== 'hosting' || !item.fields || typeof item.fields !== 'object' || !item.provenance || !item.provenance.retrieved_at || !item.provenance.first_seen_at) throw new TypeError('incomplete hosting item');
    const x = item.fields;
    const id = typeof item.identity === 'string' ? item.identity.trim() : '';
    if (!id || id.length > 200 || (!Number.isFinite(Date.parse(item.provenance.retrieved_at)) || !Number.isFinite(Date.parse(item.provenance.first_seen_at)))) throw new TypeError('invalid plan identity or fetch time');
    const vultr = item.source_key === 'vultr-plans';
    const monthly = number(vultr ? x.monthly_cost : x.price_monthly, 'monthly price');
    if (monthly == null) throw new TypeError('missing monthly price');
    return {
        provider, external_id: id, name: vultr ? id : ((typeof item.title === 'string' && item.title.trim()) || id),
        kind: vultr && x.type === 'vdc' ? 'dedicated' : 'cloud',
        vcpu: number(vultr ? x.vcpu_count : x.vcpus, 'vcpu'),
        ram_mb: number(vultr ? x.ram : x.memory, 'ram'),
        disk_gb: vultr ? number(x.disk, 'disk') : (x.disk == null ? null : number(x.disk, 'disk') / 1024),
        disk_type: vultr ? (['vhf', 'vhp'].includes(x.type) ? 'nvme' : x.type === 'vc2' ? 'ssd' : null) : null,
        bandwidth_gb: number(vultr ? x.bandwidth : x.transfer, 'bandwidth'),
        price_monthly: monthly, price_hourly: number(vultr ? x.hourly_cost : x.price_hourly, 'hourly price'),
        currency: 'USD', source_key: item.source_key, source_item_id: item.id,
        source_url: provider.source_url, checked_at: Date.parse(item.provenance.retrieved_at), first_seen_at: Date.parse(item.provenance.first_seen_at),
    };
}
module.exports = { SOURCES, mapItem };
