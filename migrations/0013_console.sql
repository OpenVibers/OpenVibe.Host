-- phase: expand
-- The console (plan T20 step 3; owner 2026-10-08: "our own system that combines em somehow"): a person connects their
-- own hosting accounts (Linode, DigitalOcean, Vultr, Hetzner Cloud) with API tokens and sees and runs every server in
-- one place (server/console/). Tokens are sealed with HOST_CREDENTIALS_KEY (AES-256-GCM) and never shown again.
CREATE TABLE host_console_accounts (
    id             text COLLATE "C" PRIMARY KEY,                 -- hca_<random>
    owner_subject  text COLLATE "C" NOT NULL,                    -- usr_…
    provider       text COLLATE "C" NOT NULL CHECK (provider IN ('linode', 'digitalocean', 'vultr', 'hetzner')),
    label          text NOT NULL,
    token_sealed   text NOT NULL,
    token_hint     text NOT NULL,                                -- the last four characters, to tell tokens apart
    created_at     bigint NOT NULL,
    last_ok_at     bigint,
    last_error     text
);
CREATE INDEX host_console_accounts_owner ON host_console_accounts (owner_subject);

-- What a person did to their servers from the console (power on, power off, reboot), kept for them.
CREATE TABLE host_console_actions (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_subject  text COLLATE "C" NOT NULL,
    account_id     text COLLATE "C" NOT NULL,
    provider       text COLLATE "C" NOT NULL,
    server_id      text COLLATE "C" NOT NULL,
    server_name    text NOT NULL DEFAULT '',
    action         text COLLATE "C" NOT NULL,
    result         text NOT NULL,
    at             bigint NOT NULL
);
CREATE INDEX host_console_actions_owner ON host_console_actions (owner_subject, at DESC);

-- Account export and deletion (ADR-033) through openvibe-sdk/account-data (server/account-data.js).
CREATE TABLE IF NOT EXISTS account_data_events (
    id          text PRIMARY KEY,
    kind        text NOT NULL,
    subject     text NOT NULL,
    outcome     jsonb,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    sent_at     timestamptz
);
