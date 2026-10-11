'use strict';

/** ADR-033: catalog rows are shared. Export authored rows; erase only the attribution. */
const TABLES = Object.freeze(['catalog_providers', 'catalog_plans', 'catalog_promos']);
async function exportFor(db, personId) {
    const out = {};
    for (const table of TABLES) out[table] = await db.prepare(`SELECT * FROM ${table} WHERE created_by = ? ORDER BY created_at, id`).all(personId);
    return out;
}
async function eraseFor(db, personId) {
    const counts = {};
    await db.tx(async (t) => {
        for (const table of TABLES) {
            const rows = await t.prepare(`SELECT id FROM ${table} WHERE created_by = ?`).all(personId);
            await t.prepare(`UPDATE ${table} SET created_by = NULL WHERE created_by = ?`).run(personId);
            counts[table] = rows.length;
        }
    });
    return counts;
}
module.exports = { TABLES, exportFor, eraseFor };
