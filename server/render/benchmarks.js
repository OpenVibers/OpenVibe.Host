'use strict';
/**
 * Benchmarks people ran on their own servers (server/catalog/benchmarks.js). Server-rendered, complete without
 * JavaScript:
 *
 *   list({ result, query })                  /catalog/benchmarks: newest first, or by Geekbench or disk speed
 *   detail(b, { csrf })                      /catalog/benchmarks/:id: one result in full
 *   submitForm({ viewer, providers, plans, csrf, error })   /catalog/benchmarks/new
 *   issued(link)                             the command with its one-time link
 *   summaryBlock(s, { href, label })         a provider's or a plan's medians, on its page
 */
const { esc } = require('./layout');
const { bytesMb } = require('./catalog');

const SORTS = [['new', 'Newest'], ['gb_single', 'Geekbench single-core'], ['gb_multi', 'Geekbench multi-core'], ['disk', 'Disk (4k IOPS)']];
const day = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
const link = (href, label, cls = '') => `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''}>${label}</a>`;
const out = (href, label, cls = '') => `<a href="${esc(href)}"${cls ? ` class="${cls}"` : ''} rel="nofollow noopener">${label}</a>`;
const n = (v, unit = '') => (v == null ? '<span class="hc-unknown">Not run</span>' : `${esc(Number(v).toLocaleString('en'))}${unit}`);
const select = (name, label, options, current) => `<label><span>${esc(label)}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(current || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const where = (b) => [b.city, b.country].filter(Boolean).join(', ');
const providerLink = (b) => (b.provider_slug ? link(`/catalog/providers/${encodeURIComponent(b.provider_slug)}`, esc(b.provider_name)) : esc(b.provider_name));
const planLink = (b) => (b.plan_name ? link(`/catalog/plans/${encodeURIComponent(b.plan_id)}`, esc(b.plan_name)) : '');

function table(rows, caption) {
    return `<div class="hc-table-wrap"><table class="hc-table hb-table"><caption>${esc(caption)}</caption>
<thead><tr><th scope="col">Server</th><th scope="col">CPU</th><th scope="col" class="hc-n">Geekbench</th><th scope="col" class="hc-n">Disk 4k</th><th scope="col" class="hc-n">Disk 1m</th><th scope="col">Where</th><th scope="col">Run</th></tr></thead>
<tbody>${rows.map((b) => `<tr>
<th scope="row" data-label="Server">${link(`/catalog/benchmarks/${encodeURIComponent(b.id)}`, esc(b.provider_name))}<span class="hc-kind">${esc([b.plan_name, b.note].filter(Boolean).join(' · ') || (b.ram_mb ? `${bytesMb(b.ram_mb)} RAM` : ''))}</span></th>
<td data-label="CPU">${esc(b.cpu_model || 'Unknown')}<span class="hc-kind">${b.cpu_cores != null ? `${esc(String(b.cpu_cores))} core${b.cpu_cores === 1 ? '' : 's'}` : ''}${b.virt ? ` · ${esc(b.virt)}` : ''}</span></td>
<td data-label="Geekbench" class="hc-n hb-gb">${b.gb_single != null || b.gb_multi != null ? `<span class="hc-price">${n(b.gb_single)}</span> / ${n(b.gb_multi)}<span class="hc-kind">GB${esc(String(b.gb_version || ''))} single / multi</span>` : '<span class="hc-unknown">Not run</span>'}</td>
<td data-label="Disk 4k" class="hc-n">${b.disk_4k_iops != null ? `${n(b.disk_4k_iops)}<span class="hc-kind">IOPS</span>` : '<span class="hc-unknown">Not run</span>'}</td>
<td data-label="Disk 1m" class="hc-n">${b.disk_1m_mbps != null ? `${n(Math.round(b.disk_1m_mbps))}<span class="hc-kind">MB/s</span>` : '<span class="hc-unknown">Not run</span>'}</td>
<td data-label="Where">${esc(where(b) || 'Unknown')}${b.network ? `<span class="hc-kind">${esc(b.network)}</span>` : ''}</td>
<td data-label="Run" class="hc-checked">${esc(day(b.created_at))}</td>
</tr>`).join('')}</tbody></table></div>`;
}

const HOW = `<section class="hc-method" aria-labelledby="hb-method-h"><h2 id="hb-method-h">How benchmarks get here</h2><ul>
<li><strong>Run by people on their own servers.</strong> A signed-in member asks for a one-time link naming the provider (and plan) they are testing, and runs YABS (Yet Another Bench Script) with it. YABS posts its result here when it finishes.</li>
<li><strong>What is kept.</strong> The CPU, memory and disk, Geekbench scores with their public link, fio disk speeds, iperf3 network speeds, and the city and network YABS looked up. Never the server's address, and never who ran it on the public page.</li>
<li><strong>Read with care.</strong> One run is one server on one day: neighbours, location and the plan's limits all change the numbers. Medians across several runs say more.</li>
<li><strong>Curated.</strong> The person who submitted a result, or staff, can take it down.</li>
</ul></section>`;

function list({ result, query = {} }) {
    const q = query || {};
    const rows = result.benchmarks;
    const next = result.next_cursor ? `<p class="hc-more">${link(`/catalog/benchmarks?${new URLSearchParams({ ...q, cursor: result.next_cursor })}`, 'Next 50 results →', 'button hc-button-quiet')}</p>` : '';
    const filtered = q.provider || q.plan;
    return `<header class="hc-head hc-head-row"><div><p class="hc-eyebrow">OpenVibe.Host · benchmarks</p><h1>Server benchmarks</h1>
<p class="hc-lede">CPU, disk and network results people ran on their own servers with YABS, by provider and plan.</p></div>
<p>${link('/catalog/benchmarks/new', 'Submit a benchmark', 'button')}</p></header>
${rows.length || filtered ? `<form class="hc-filters" method="get" action="/catalog/benchmarks" role="search" aria-label="Sort benchmarks">
${select('sort', 'Sort by', SORTS, q.sort || 'new')}
<label><span>Provider</span><input name="provider" value="${esc(q.provider || '')}" placeholder="Any" autocapitalize="off"></label>
<div class="hc-filter-actions"><button type="submit">Show</button> <a href="/catalog/benchmarks" class="hc-reset">Reset</a></div>
</form>` : ''}
${rows.length ? table(rows, `${rows.length}${result.next_cursor ? '+' : ''} result${rows.length === 1 ? '' : 's'}`)
        : filtered ? `<div class="hc-empty"><p><strong>No result for this provider yet.</strong></p><p>${link('/catalog/benchmarks/new', 'Run one on your server')} or ${link('/catalog/benchmarks', 'see every result')}.</p></div>`
            : `<div class="hc-empty hc-empty-rich"><p><strong>Be the first to add a result.</strong></p><p>Have a VPS or a dedicated server? One command measures it, and the result lands here for everyone comparing providers.</p><p>${link('/catalog/benchmarks/new', 'Submit a benchmark', 'button')}</p></div>`}
${next}
${HOW}
<p class="hc-links">${link('/catalog', '← Compare plans')} · ${link('/catalog/offers', 'Hosting offers')}</p>`;
}

function detail(b, { csrf = '', canRemove = false } = {}) {
    const spec = [
        ['CPU', b.cpu_model], ['Cores', b.cpu_cores], ['Clock', b.cpu_freq], ['AES-NI', b.aes == null ? null : b.aes ? 'Yes' : 'No'],
        ['Virtualization', b.virt], ['RAM', b.ram_mb != null ? bytesMb(b.ram_mb) : null], ['Swap', b.swap_mb ? bytesMb(b.swap_mb) : null],
        ['Disk', b.disk_gb != null ? `${b.disk_gb} GB` : null], ['Architecture', b.arch], ['System', b.distro],
    ];
    const fio = b.fio && b.fio.length ? `<div class="hc-table-wrap"><table class="hc-table hb-fio"><caption>fio, random reads and writes (50/50)</caption>
<thead><tr><th scope="col">Block size</th><th scope="col" class="hc-n">Read</th><th scope="col" class="hc-n">Write</th><th scope="col" class="hc-n">Total</th><th scope="col" class="hc-n">IOPS</th></tr></thead>
<tbody>${b.fio.map((f) => `<tr><th scope="row" data-label="Block size">${esc(f.bs)}</th><td data-label="Read" class="hc-n">${n(f.read_mbps, ' MB/s')}</td><td data-label="Write" class="hc-n">${n(f.write_mbps, ' MB/s')}</td><td data-label="Total" class="hc-n"><strong>${n(f.total_mbps, ' MB/s')}</strong></td><td data-label="IOPS" class="hc-n">${n(f.total_iops)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hc-dim">The disk test was not run.</p>';
    const iperf = b.iperf && b.iperf.length ? `<div class="hc-table-wrap"><table class="hc-table hb-iperf"><caption>iperf3, to public test servers</caption>
<thead><tr><th scope="col">Server</th><th scope="col">Where</th><th scope="col" class="hc-n">Send</th><th scope="col" class="hc-n">Receive</th><th scope="col" class="hc-n">Latency</th></tr></thead>
<tbody>${b.iperf.map((x) => `<tr><th scope="row" data-label="Server">${esc(x.provider || '')}${x.mode ? ` <span class="hc-dim">${esc(x.mode)}</span>` : ''}</th><td data-label="Where">${esc(x.location || '')}</td><td data-label="Send" class="hc-n">${esc(x.send || '')}</td><td data-label="Receive" class="hc-n">${esc(x.recv || '')}</td><td data-label="Latency" class="hc-n">${esc(x.latency || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hc-dim">The network test was not run.</p>';
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog/benchmarks', 'Benchmarks')} / ${esc(b.provider_name)}</nav>
<header class="hc-head"><p class="hc-eyebrow">Benchmark · ${esc(day(b.created_at))}</p><h1>${esc(b.provider_name)}${b.plan_name ? ` ${esc(b.plan_name)}` : ''}</h1>
<p class="hc-lede">${[b.provider_slug ? `${providerLink(b)}${b.plan_name ? ` · ${planLink(b)}` : ''}` : null, b.note ? esc(b.note) : null, where(b) ? esc(where(b)) : null, b.network ? esc(b.network) : null].filter(Boolean).join(' · ')}</p></header>
<div class="hb-scores">
<section class="hc-price-card" aria-label="Geekbench"><p class="hb-label">Geekbench ${esc(String(b.gb_version || ''))}</p>
${b.gb_single != null || b.gb_multi != null ? `<p class="hc-big">${n(b.gb_single)}<span>single</span></p><p class="hc-big">${n(b.gb_multi)}<span>multi</span></p>${b.gb_url ? `<p>${out(b.gb_url, 'Full result on Geekbench Browser')}</p>` : ''}` : '<p class="hc-dim">Not run.</p>'}</section>
<section aria-labelledby="hb-spec-h"><h2 id="hb-spec-h">The server</h2><dl class="hc-spec">${spec.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(String(v))}</dd></div>`).join('')}</dl></section>
</div>
<h2>Disk</h2>
${fio}
<h2>Network</h2>
${iperf}
<p class="hc-dim">Run with YABS ${esc(b.tool_version || '')}${b.elapsed_s ? ` in ${esc(String(Math.round(b.elapsed_s / 60)))} minutes` : ''}, submitted ${esc(day(b.created_at))}.</p>
${canRemove ? `<form method="post" action="/catalog/benchmarks/${esc(b.id)}/remove" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="hc-button-quiet">Remove this result</button></form>` : ''}
<p class="hc-links">${link('/catalog/benchmarks', '← Every benchmark')}${b.provider_slug ? ` · ${link(`/catalog/benchmarks?provider=${encodeURIComponent(b.provider_slug)}`, `More ${esc(b.provider_name)} results`)}` : ''}</p>`;
}

function submitForm({ viewer, providers = [], plans = [], csrf = '', error = null, query = {} }) {
    const head = `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog/benchmarks', 'Benchmarks')} / Submit</nav>
<header class="hc-head"><p class="hc-eyebrow">OpenVibe.Host · benchmarks</p><h1>Benchmark your server</h1>
<p class="hc-lede">Name the provider and plan, get a one-time link, and run one command on the server. YABS measures the CPU (Geekbench), the disk (fio) and the network (iperf3) in about 10 to 15 minutes, then posts the result here.</p></header>`;
    if (!viewer || viewer.kind !== 'user') {
        return `${head}<div class="hc-empty hc-empty-rich"><p><strong>Sign in to submit a benchmark.</strong></p><p>Results are public; who submitted them is not. Signing in lets you remove your own results later.</p><p>${link('/auth/login?next=%2Fcatalog%2Fbenchmarks%2Fnew', 'Sign in', 'button')}</p></div>`;
    }
    const byProvider = new Map();
    for (const p of plans) { if (!byProvider.has(p.provider_name)) byProvider.set(p.provider_name, []); byProvider.get(p.provider_name).push(p); }
    return `${head}${error ? `<p class="hb-error" role="alert">${esc(error)}</p>` : ''}
<form class="hb-form" method="post" action="/catalog/benchmarks/new">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label><span>Provider in the catalog</span><select name="provider"><option value="">Another provider (name it below)</option>${providers.map((p) => `<option value="${esc(p.slug)}"${query.provider === p.slug ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
<label><span>Or the provider's name</span><input name="provider_name" maxlength="80" placeholder="e.g. RackNerd" value="${esc(query.provider_name || '')}"></label>
<label><span>Plan (optional)</span><select name="plan_id"><option value="">Not in the catalog, or not sure</option>${[...byProvider].map(([name, list]) => `<optgroup label="${esc(name)}">${list.map((p) => `<option value="${esc(p.id)}"${query.plan_id === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
<label><span>Note (optional)</span><input name="note" maxlength="200" placeholder="e.g. Black Friday 2 GB KVM, Los Angeles"></label>
<div><button type="submit">Get my link</button></div>
</form>
<p class="hc-dim">YABS is open source: ${out('https://github.com/masonr/yet-another-bench-script', 'github.com/masonr/yet-another-bench-script')}. It downloads fio, iperf3 and Geekbench for the run and removes them after; Geekbench publishes its own result on browser.geekbench.com.</p>`;
}

function issued(l) {
    return `<nav class="hc-crumbs" aria-label="Breadcrumb">${link('/catalog/benchmarks', 'Benchmarks')} / Submit</nav>
<header class="hc-head"><p class="hc-eyebrow">Your link is ready</p><h1>Run this on your ${esc(l.provider_name)} server</h1>
<p class="hc-lede">Copy the command into a shell on the server (as any user; no root needed for most tests). When YABS finishes it prints the address of your result here.</p></header>
<pre class="hb-command"><code>${esc(l.command)}</code></pre>
<ul class="hc-rules"><li>The link works once, until ${esc(l.expires_at.slice(0, 16).replace('T', ' '))} UTC. Ask for another for each server.</li>
<li>Skip a test with YABS's own flags after <code>-s</code>: <code>-i</code> skips the network test, <code>-g</code> Geekbench, <code>-f</code> the disk test.</li>
<li>Keep the link to yourself: whoever has it can post one result in your name.</li></ul>
<p class="hc-links">${link('/catalog/benchmarks', '← Every benchmark')}</p>`;
}

function summaryBlock(s, { href, label }) {
    if (!s || !s.count) return `<section class="hb-summary" aria-label="Benchmarks"><h2>Benchmarks</h2><p class="hc-dim">No one has posted a benchmark of ${esc(label)} yet. ${link('/catalog/benchmarks/new', 'Run one on your server')}.</p></section>`;
    return `<section class="hb-summary" aria-label="Benchmarks"><h2>Benchmarks</h2>
<p>${esc(String(s.count))} result${s.count === 1 ? '' : 's'} from people running ${esc(label)}. Medians: ${s.gb_single != null ? `Geekbench ${esc(String(s.gb_version || ''))} <strong>${esc(s.gb_single.toLocaleString('en'))}</strong> single, <strong>${esc((s.gb_multi || 0).toLocaleString('en'))}</strong> multi` : 'no Geekbench run'}${s.disk_4k_iops != null ? `; disk <strong>${esc(s.disk_4k_iops.toLocaleString('en'))}</strong> 4k IOPS` : ''}.</p>
<p>${link(href, 'See every result →')} · ${link('/catalog/benchmarks/new', 'Add yours')}</p></section>`;
}

module.exports = { list, detail, submitForm, issued, summaryBlock, SORTS };
