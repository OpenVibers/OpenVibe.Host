'use strict';
/**
 * Links built on the host for an operator alert (lib/alerts.js, lib/browser-watch.js).
 * The browser check keeps the axe rule's help text but not axe's helpUrl, so the page is built from the rule id
 * and the axe version the check ran (the same URL axe's helpUrl names), with a current-version fallback for a
 * result file written before the version was kept.
 */
const AXE_FALLBACK_VERSION = '4.13';
const RULE_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** The rule's Deque University page, or null when the rule id is not one. */
function axeHelpUrl(rule, version = null) {
    if (!RULE_RE.test(String(rule || ''))) return null;
    const v = (/^(\d+\.\d+)/.exec(String(version || '')) || [])[1] || AXE_FALLBACK_VERSION;
    return `https://dequeuniversity.com/rules/axe/${v}/${rule}?application=axeAPI`;
}

module.exports = { axeHelpUrl, AXE_FALLBACK_VERSION };
