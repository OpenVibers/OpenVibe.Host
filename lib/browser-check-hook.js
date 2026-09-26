'use strict';
/**
 * `ovhost deploy <service> --browser-check`: after a deploy that went through, the service's public site is
 * checked in a real browser by scripts/browser-check.js (roadmap WS-Q task 3). Report only: the result is
 * printed and never changes the deploy's exit code or its release record. It needs Chrome on the machine that
 * runs ovhost; without it the check says it did not run.
 */
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'browser-check.js');

/** Answers { code, lines, error }: code 0 pass, 1 problems found, 2 (or a signal) the check did not run. */
function runBrowserCheck(service, { timeoutMs = 15 * 60 * 1000, script = SCRIPT, args = [] } = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script, '--sites', service, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        const timer = setTimeout(() => { err += `\ntimed out after ${Math.round(timeoutMs / 1000)}s`; child.kill('SIGKILL'); }, timeoutMs);
        child.on('error', (e) => { clearTimeout(timer); resolve({ code: 2, lines: [], error: e.message }); });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
            const errLines = err.split('\n').map((l) => l.trim()).filter(Boolean);
            const c = code == null ? 2 : code;
            resolve({ code: c, lines, error: c >= 2 ? (errLines.find((l) => /Error|not found|timed out/.test(l)) || errLines[errLines.length - 1] || signal || `exit ${c}`) : null });
        });
    });
}

module.exports = { runBrowserCheck, SCRIPT };
