#!/usr/bin/env node
/**
 * Runs every test in test/ — the files named *.test.js — each in its own process, and fails if any
 * of them fails. Every test drives ovhost against the in-memory fake host (test/fake-host.js):
 * no systemctl, git, npm, nginx or curl call reaches the real machine.
 *
 *   npm test                   # everything
 *   npm test -- deploy certs   # only files whose name contains one of the words
 *   npm test -- --strict       # a skipped test fails the run too
 *
 * A test that cannot run something here prints `<label>: skipped (<why>)`: that file is listed with
 * ○ and not counted as passed (openvibe-shared/test-runner).
 */
'use strict';
// 180 s per file: d41-proof.test.js runs scripts/d41-proof.sh with a node stub per systemctl/ovhost call
// (hundreds of process starts, ~13 s of CPU), which takes 60–120 s of wall time on a loaded machine.
require('openvibe-shared/test-runner').main({ dir: __dirname, timeoutMs: 180000, pad: 32, parallel: 1 });
