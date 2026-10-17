'use strict';

/**
 * ADR-033: catalog rows are shared. Export authored rows; erase only the attribution. A person's benchmark results and
 * links (migration 0012) are exported; erasing deletes the links and detaches the results, which stay as anonymous
 * measurements. Tables a held migration has not created yet are skipped.
 */
const TABLES = Object.freeze(['catalog_providers', 'catalog_plans', 'catalog_promos']);
const exists = async (db, table) => Boolean((await db.prepare('SELECT to_regclass(?) AS t').get(table)).t);

async function exportFor(db, personId) {
    const out = {};
    for (const table of TABLES) out[table] = await db.prepare(`SELECT * FROM ${table} WHERE created_by = ? ORDER BY created_at, id`).all(personId);
    if (await exists(db, 'catalog_benchmarks')) {
        out.catalog_benchmarks = await db.prepare('SELECT * FROM catalog_benchmarks WHERE submitted_by = ? ORDER BY created_at, id').all(personId);
        out.catalog_bench_links = await db.prepare('SELECT provider_name, plan_id, note, created_at, expires_at, used_at FROM catalog_bench_links WHERE person = ? ORDER BY created_at').all(personId);
    }
    return out;
}
async function eraseFor(db, personId) {
    const counts = {};
    const benchmarks = await exists(db, 'catalog_benchmarks');
    await db.tx(async (t) => {
        for (const table of TABLES) {
            const rows = await t.prepare(`SELECT id FROM ${table} WHERE created_by = ?`).all(personId);
            await t.prepare(`UPDATE ${table} SET created_by = NULL WHERE created_by = ?`).run(personId);
            counts[table] = rows.length;
        }
        if (benchmarks) {
            counts.catalog_benchmarks = (await t.prepare('UPDATE catalog_benchmarks SET submitted_by = NULL WHERE submitted_by = ?').run(personId)).changes;
            counts.catalog_bench_links = (await t.prepare('DELETE FROM catalog_bench_links WHERE person = ?').run(personId)).changes;
        }
    });
    return counts;
}
module.exports = { TABLES, exportFor, eraseFor };
