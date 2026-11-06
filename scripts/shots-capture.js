'use strict';
/**
 * The capture itself (plan L9, devblog §3.3), run by ovhost shots as the unprivileged ovcheck account:
 * Chrome opens each page at each viewport, dark and without animations, and writes a PNG.
 *
 *   node scripts/shots-capture.js --targets <file.json> --out <dir>
 *
 * The target file holds [{ service, origin, path, viewport, width, height }]; the script prints
 * { shots: [{ service, path, viewport, width, height, file }] } on stdout. It never prints a page's
 * content, only the file it wrote.
 */
const fs = require('fs');
const path = require('path');
const harness = require('openvibe-shared/browser-harness');

/** The private parts of a page: what a shot must never show (§3.3). */
const MASK_SELECTOR = '[data-private], input, textarea, select, [data-ov-mask]';

/** Dark theme, no animations, no caret, and every email address hidden. */
const PREPARE = `(() => {
  const st = document.createElement('style');
  st.setAttribute('data-ov-shots', '1');
  st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
  (document.documentElement || document.body).appendChild(st);
  try { if (document.getAnimations) document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} }); } catch (e) {}
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue || '';
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    node.nodeValue = text.replace(re, '••••');
    const el = node.parentElement;
    if (el && !el.closest('[data-private]')) el.setAttribute('data-ov-mask', '1');
  }
  return true;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'page';

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : null;
}

(async () => {
    const targetsFile = arg('targets');
    const out = arg('out');
    if (!targetsFile || !out) { console.error('shots-capture: --targets and --out are needed'); process.exit(1); }
    const targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
    fs.mkdirSync(out, { recursive: true });
    const shots = [];
    const browser = await harness.launch({});
    const context = await browser.newContext();
    try {
        for (const t of targets) {
            const page = await harness.openPage(browser, context, { width: t.width, height: t.height });
            try {
                // Dark theme before the page loads, so the first paint is the dark one.
                await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
                await page.goto(`${t.origin}${t.path}`, { quietMs: 1200, maxMs: 20000 });
                await page.evaluate(PREPARE);
                await sleep(1200);
                const shot = await page.send('Page.captureScreenshot', { format: 'png', mask: [{ selector: MASK_SELECTOR }] });
                const file = path.join(out, `${safe(t.service)}__${safe(t.path)}__${safe(t.viewport)}.png`);
                fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
                shots.push({ service: t.service, path: t.path, viewport: t.viewport, width: t.width, height: t.height, file });
            } catch (err) {
                console.error(`shots-capture: ${t.service}${t.path} at ${t.viewport} failed: ${err.message}`);
            } finally {
                await page.close().catch(() => {});
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }
    process.stdout.write(`${JSON.stringify({ shots })}\n`);
    process.exit(0);
})().catch((err) => { console.error(`shots-capture: ${err.message}`); process.exit(2); });
