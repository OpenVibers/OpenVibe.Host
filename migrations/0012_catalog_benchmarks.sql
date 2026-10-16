-- phase: expand
-- Benchmarks (plan T20, the owner's "benchmarks and user submittable community curated content"; Q21: user-submitted):
-- a signed-in person asks for a one-time link, runs YABS (Yet Another Bench Script) on their server with it, and YABS
-- posts its JSON result here (server/catalog/benchmarks.js). Host keeps the measurements (CPU, Geekbench, fio, iperf3),
-- the provider and plan they named, and the city and network YABS looked up; never the server's address.
CREATE TABLE catalog_bench_links (
    token_hash    text COLLATE "C" PRIMARY KEY,
    person        text COLLATE "C" NOT NULL,
    provider_id   text COLLATE "C" REFERENCES catalog_providers(id),
    provider_name text NOT NULL CHECK (length(provider_name) BETWEEN 1 AND 80),
    plan_id       text COLLATE "C" REFERENCES catalog_plans(id),
    note          text CHECK (note IS NULL OR length(note) <= 200),
    created_at    bigint NOT NULL,
    expires_at    bigint NOT NULL,
    used_at       bigint
);
CREATE INDEX catalog_bench_links_person ON catalog_bench_links (person, created_at);
CREATE TABLE catalog_benchmarks (
    id            text COLLATE "C" PRIMARY KEY,
    provider_id   text COLLATE "C" REFERENCES catalog_providers(id),
    provider_name text NOT NULL CHECK (length(provider_name) BETWEEN 1 AND 80),
    plan_id       text COLLATE "C" REFERENCES catalog_plans(id),
    note          text CHECK (note IS NULL OR length(note) <= 200),
    submitted_by  text COLLATE "C",
    tool          text COLLATE "C" NOT NULL CHECK (tool IN ('yabs')),
    tool_version  text,
    cpu_model     text,
    cpu_cores     integer CHECK (cpu_cores >= 0),
    cpu_freq      text,
    aes           boolean,
    virt          text,
    arch          text,
    distro        text,
    ram_mb        numeric CHECK (ram_mb >= 0),
    swap_mb       numeric CHECK (swap_mb >= 0),
    disk_gb       numeric CHECK (disk_gb >= 0),
    city          text,
    region        text,
    country       text,
    network       text,
    gb_version    integer,
    gb_single     integer CHECK (gb_single >= 0),
    gb_multi      integer CHECK (gb_multi >= 0),
    gb_url        text,
    disk_4k_iops  numeric CHECK (disk_4k_iops >= 0),
    disk_4k_mbps  numeric CHECK (disk_4k_mbps >= 0),
    disk_1m_mbps  numeric CHECK (disk_1m_mbps >= 0),
    fio           jsonb,
    iperf         jsonb,
    elapsed_s     integer,
    status        text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden')),
    created_at    bigint NOT NULL,
    updated_at    bigint NOT NULL
);
CREATE INDEX catalog_benchmarks_recent ON catalog_benchmarks (status, created_at DESC, id);
CREATE INDEX catalog_benchmarks_provider ON catalog_benchmarks (provider_id, status, created_at DESC);
CREATE INDEX catalog_benchmarks_plan ON catalog_benchmarks (plan_id, status, created_at DESC);
CREATE INDEX catalog_benchmarks_person ON catalog_benchmarks (submitted_by);
