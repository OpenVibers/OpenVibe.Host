-- phase: expand
-- Per-site serving configuration (plan T12 J3, decision D4): the response headers, the redirects and
-- the SPA fallback of ONE site, kept in PostgreSQL and applied in server/http/tenant.js BEFORE the
-- platform's own headers. The platform's security, routing and caching headers (CSP, HSTS,
-- Set-Cookie, X-Forwarded-*, Cache-Control, …) are reserved and can never be set through it, and a
-- redirect target must be a local path, so a site can never become an open redirect. A site with no
-- row here serves exactly as before (no headers, no redirects, no SPA fallback).
CREATE TABLE host_site_config (
    site_id     text COLLATE "C" PRIMARY KEY REFERENCES host_sites(id),
    headers     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "Header-Name": "value" }, validated on write
    redirects   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [ { from, to, status } ], local targets only
    spa         boolean NOT NULL DEFAULT false,       -- serve index.html for extensionless paths
    updated_by  text COLLATE "C",
    updated_at  bigint NOT NULL
);
