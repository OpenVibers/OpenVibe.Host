'use strict';
/**
 * The staff-only inference planner page (server/http/inference-planner.js). Plain server-rendered
 * HTML in Host's catalog style: no form, no button and no action — the page reads a plan and says
 * what it recommends. Every amount is integer nano-USD in the JSON; it is formatted as USD here.
 */
const { esc } = require('./layout');
const { formatUsd } = require('../inference-planner');

const MODE_LABELS = { warm: 'Warm rented GPU', scale_to_zero: 'Scale to zero', wholesale: 'Wholesale API' };

function commas(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function money(nano) {
    const n = BigInt(nano);
    return formatUsd(n, n > 0n && n < 1_000_000n ? 6 : 2);
}

function budgetText(budget) {
    if (!budget.valid) return 'HOST_INFERENCE_BUDGET_NANO_USD is not a non-negative integer; it is treated as 0, so every positive recommendation needs the owner\'s budget.';
    if (!budget.configured) return 'HOST_INFERENCE_BUDGET_NANO_USD is unset = 0, so every positive recommendation needs the owner\'s budget.';
    return 'from HOST_INFERENCE_BUDGET_NANO_USD. A recommendation at the forecast or at the high band above it needs the owner\'s budget.';
}

function costCell(cost, high, mode) {
    let extra;
    if (mode === 'warm') {
        extra = `${commas(cost.gpu_count)} GPU${cost.gpu_count === '1' ? '' : 's'} · idle burn ${money(cost.idle_burn_nano_usd)}`;
    } else if (mode === 'scale_to_zero') {
        extra = `${commas(cost.cold_starts)} cold start${cost.cold_starts === '1' ? '' : 's'} · ${money(cost.parts_nano_usd.cold_start)}`;
    } else {
        extra = 'all-in · no idle burn';
    }
    return `<td data-label="${esc(MODE_LABELS[mode])}"><span class="hc-price">${money(cost.total_nano_usd)}</span><span class="hc-term">high band ${money(high.total_nano_usd)}</span><span class="hc-dim">${esc(extra)}</span></td>`;
}

function breakEvenText(be) {
    const bits = [];
    if (be.warm_vs_scale_to_zero) bits.push(`warm beats scale-to-zero above ${commas(be.warm_vs_scale_to_zero.requests_per_month)} requests/month`);
    if (be.warm_vs_wholesale) bits.push(`warm beats wholesale above ${commas(be.warm_vs_wholesale.requests_per_month)} requests/month`);
    if (!bits.length) return `No warm break-even within ${commas(be.capacity_requests_per_month)} requests/month (one GPU's monthly busy time).`;
    return bits.join('; ') + `. (One warm GPU covers ${commas(be.capacity_requests_per_month)} requests/month.)`;
}

function row(candidate) {
    const f = candidate.costs.forecast;
    const h = candidate.costs.high_band;
    const rec = candidate.recommendation;
    const badge = rec.budget.status === 'needs_owner_budget'
        ? '<span class="hc-chip">needs the owner\'s budget</span>'
        : '<span class="hc-dim">within budget</span>';
    return `<tr>
  <th scope="row">${esc(candidate.model.label)}<span class="hc-kind">${esc(candidate.model.id)}</span></th>
  <td data-label="GPU class">${esc(candidate.gpu_class.label)}<span class="hc-kind">${esc(candidate.gpu_class.id)}</span></td>
  ${costCell(f.warm, h.warm, 'warm')}
  ${costCell(f.scale_to_zero, h.scale_to_zero, 'scale_to_zero')}
  ${costCell(f.wholesale, h.wholesale, 'wholesale')}
  <td data-label="Recommendation" style="grid-column: 1 / -1"><strong>${esc(rec.label)}</strong> ${badge}<p class="hc-dim">${esc(rec.reason)}</p><p class="hc-dim">${esc(breakEvenText(candidate.break_even))}</p></td>
</tr>`;
}

function method() {
    return `<section class="hc-method" aria-labelledby="hp-method-h">
<h2 id="hp-method-h">How the forecast is made</h2>
<ul>
<li>The level is the mean of the trailing window of daily request counts. Each weekday's factor is that weekday's mean in the window divided by the level; a future day is the level times its weekday factor, rounded to a whole request.</li>
<li>The band is ±1.96 × the pooled standard deviation of the window's residuals from their weekday means × √horizon. Daily residuals are assumed independent. It is a planning band, not a guarantee.</li>
<li>The input is a planning JSON (<code>HOST_INFERENCE_PLANNER_INPUT</code>); with <code>HOST_INFERENCE_PLANNER_SOURCE=ai</code> the daily request series comes from OpenVibe.AI's aggregate usage feed and is cached ten minutes. No provider API is read and no benchmark is invented.</li>
</ul>
</section>
<section class="hc-method" aria-labelledby="hp-cost-h">
<h2 id="hp-cost-h">How the costs are compared</h2>
<ul>
<li><strong>Warm rented GPU:</strong> one GPU-month (730 hours) at the class's hourly rate for each GPU the busy time needs, plus storage and egress. The idle burn is the part of the rental not spent on busy requests.</li>
<li><strong>Scale to zero:</strong> busy milliseconds at the serverless hourly rate, a cold start every <code>requests_per_cold_start</code> requests at the startup seconds, plus storage and egress. Idle time is free.</li>
<li><strong>Wholesale API:</strong> input, cached read, cache write and output tokens at the per-million rate, plus the per-request fee. All-in: no owned storage or egress.</li>
<li>Every amount is integer nano-USD (D1); the page formats it as USD for reading and the JSON keeps the exact integer. A tie prefers wholesale, then scale-to-zero — never a rental.</li>
</ul>
</section>
<section class="hc-method" aria-labelledby="hp-action-h">
<h2 id="hp-action-h">Budget and authority</h2>
<p>Any recommendation whose monthly cost at the forecast or at the high band exceeds <code>HOST_INFERENCE_BUDGET_NANO_USD</code> is marked <strong>needs the owner's budget</strong>. Unset means 0, so nothing is pre-approved. The planner returns a recommendation and an empty action list; there is no code path in it that starts, stops or rents a GPU. The owner approves every rental separately.</p>
</section>`;
}

/** Where the demand came from: the AI feed, the JSON input, or the JSON after a failed feed. */
function demandText(demand) {
    if (!demand) return null;
    if (demand.source === 'ai') return `Demand: OpenVibe.AI's aggregate usage series, ${commas(demand.days)} days (${demand.from} to ${demand.to}), cached up to 10 minutes.`;
    if (demand.fallback) return `${demand.warning}; using the configured planning JSON instead.`;
    return 'Demand: the configured planning JSON.';
}

/** The planner page body. `result` is the output of server/inference-planner.js. */
function page(result) {
    const monthly = result.forecast.monthly;
    const candidates = result.candidates;
    const needs = result.summary.needs_owner_budget;
    const demand = demandText(result.demand);
    return `<header class="hc-head">
<p class="hc-eyebrow">Staff</p>
<h1>Inference placement planner</h1>
<p class="hc-lede">A forecast and a monthly break-even for a warm rented GPU, scale-to-zero and wholesale. This page recommends; it never starts, stops or rents anything. The owner approves every rental.</p>
</header>
${demand ? `<p class="hc-facts">${esc(demand)}</p>` : ''}
<p class="hc-facts">Forecast: <strong>${commas(monthly.requests)} requests</strong> in the next ${result.forecast.horizon.days} days, uncertainty band ${commas(monthly.low)}–${commas(monthly.high)}. ${needs} of ${candidates.length} recommendation${candidates.length === 1 ? '' : 's'} need${needs === 1 ? 's' : ''} the owner's budget.</p>
<p class="hc-facts">Budget: <strong>${money(result.budget.configured_nano_usd)}/month</strong> (<code>${commas(result.budget.configured_nano_usd)} nano-USD</code>). ${esc(budgetText(result.budget))}</p>
${result.note ? `<p class="hc-disclosure">${esc(result.note)}</p>` : ''}
<div class="hc-table-wrap"><table class="hc-table"><caption>Monthly cost at the forecast and at the high band. Exact nano-USD is in <code>/api/v1/catalog/inference-planner</code>.</caption><thead><tr><th scope="col">Model</th><th scope="col">GPU class</th><th scope="col">Warm rented GPU</th><th scope="col">Scale to zero</th><th scope="col">Wholesale API</th><th scope="col">Recommendation</th></tr></thead><tbody>${candidates.map(row).join('')}</tbody></table></div>
${method()}`;
}

/** A staff-only error page: no result is shown and nothing is acted on. */
function errorPage(message, { input = false } = {}) {
    return `<header class="hc-head"><p class="hc-eyebrow">Staff</p><h1>Inference placement planner</h1>
<p class="hc-lede">The planner could not show a plan. Nothing was started, stopped or rented.</p></header>
<div class="hc-empty"><p><strong>${input ? 'The planning input is unavailable.' : 'The planner has no plan to show.'}</strong></p><p>${esc(message)}</p>${input ? '<p>Set <code>HOST_INFERENCE_PLANNER_INPUT</code> to a readable planning JSON and reload.</p>' : ''}</div>`;
}

module.exports = { page, errorPage, money, commas, MODE_LABELS };
