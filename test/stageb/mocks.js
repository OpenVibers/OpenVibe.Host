'use strict';
/**
 * In-process stand-in for OpenVibe.Network with a real RS256 key pair: JWKS and /oauth/token
 * (client_credentials → service tokens with the requested scope as capabilities).
 * userToken()/serviceToken()/appToken() mint what browsers, services and apps present to Host.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                handler(req, raw, json, res);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
    });
}

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    let issuer = null;
    const srv = await listen((req, raw, json) => {
        if (req.url === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            let body = {};
            if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
            else { try { body = JSON.parse(raw); } catch { /* */ } }
            if (body.client_secret !== 'shh-host-secret-value') return json(401, { error: 'invalid_client' });
            if (body.grant_type === 'client_credentials') {
                let scope = body.scope;
                if (scope && typeof scope === 'object') scope = Object.values(scope).join(' ');
                const cap = String(scope || '').split(/\s+/).filter(Boolean);
                return json(200, { access_token: sign({ sub: `svc:${body.client_id}`, actor_type: 'service', aud: [body.audience || 'openvibe.events'], cap }), token_type: 'Bearer', expires_in: 300 });
            }
            return json(400, { error: 'unsupported_grant_type' });
        }
        return json(404, { error: 'not found' });
    });
    issuer = srv.url;
    function sign({ sub, actor_type = 'service', aud, cap, ...extra }) {
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type, aud, cap, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(), ...extra }, privatePem);
    }
    function addUser(username, extra = {}) {
        return { subject: ids.newId('user'), username, display_name: extra.display_name || username, role: extra.role || 'user' };
    }
    function userToken(u) {
        return jwt.sign({ sub: String(Math.floor(Math.random() * 1e6)), subject_id: u.subject, username: u.username, display_name: u.display_name, role: u.role || 'user' }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    /** A FedCM ID assertion as Network's /fedcm/assertion signs it (same key and issuer, aud = the RP origin). */
    function fedcmAssertion(u, origin, nonce = 'n0nce') {
        return jwt.sign({ sub: String(Math.floor(Math.random() * 1e6)), id: 1, subject_id: u.subject, username: u.username, display_name: u.display_name, nonce, typ: 'fedcm', jti: crypto.randomBytes(16).toString('hex') }, privatePem, { algorithm: 'RS256', issuer, audience: origin, expiresIn: 300 });
    }
    function serviceToken(client, cap, extra = {}) {
        return sign({ sub: `svc:${client}`, aud: ['openvibe.host'], cap, ...extra });
    }
    // An app token carries its developer project and env, as Network's do (identity.service-token-claims 1.2.0).
    function appToken(appId, cap, extra = {}) {
        return sign({ sub: `app:${appId}`, actor_type: 'app', aud: ['openvibe.host'], cap, project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', env: 'production', ...extra });
    }
    return { ...srv, publicPem, addUser, userToken, fedcmAssertion, serviceToken, appToken, sign };
}

module.exports = { startNetwork, listen };
