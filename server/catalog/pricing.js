'use strict';
/**
 * What a stored plan price means (server/catalog/pricing.js), shared by the catalog store and the pages:
 *
 *   - a monthly server price: what a plan costs a month, the only price a server comparison may use;
 *   - a per-GB storage rate: Azure's per-GB tiers keep their rate in price_monthly (server/catalog/mapping.js writes
 *     the rate there and names the plan "<tier> (per GB/month)"), so it is not a monthly price and never joins a
 *     server comparison; it is shown as the rate per GB it is;
 *   - nothing: no price stated.
 *
 * A price last checked more than a year ago is stale: it is still shown and marked as stale, but it is never counted
 * as the cheapest plan or as a provider's "from" price.
 */
const STALE_AFTER_MS = 365 * 86400000;
const PER_GB_SUFFIX = '(per gb/month)';

const toMs = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
};
/** The plan carries a per-GB rate, not a monthly price. */
const isStorageRate = (p) => Boolean(p) && p.kind === 'storage' && typeof p.name === 'string' && p.name.toLowerCase().includes(PER_GB_SUFFIX);
/** The price was last checked more than a year ago. */
const isStale = (checkedAt, now) => { const t = toMs(checkedAt); return t != null && Number(now) - t > STALE_AFTER_MS; };
/** The oldest check that still counts as fresh (a plan checked before this is stale). */
const freshCutoff = (now) => Number(now) - STALE_AFTER_MS;
/** A stated monthly price a comparison may use: not a per-GB rate, not stale. */
const hasServerPrice = (p, now) => Number(p && p.price_monthly) > 0 && !isStorageRate(p) && !isStale(p.checked_at, now);

module.exports = { STALE_AFTER_MS, PER_GB_SUFFIX, isStorageRate, isStale, freshCutoff, hasServerPrice };
