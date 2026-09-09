import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = [
  "migrations/auth/0001_auth.sql",
  "migrations/0002_schema.sql",
  "migrations/0003_part_analyses.sql",
  "migrations/0004_part_analysis_review.sql",
  "migrations/0005_inventory_lot_lineage.sql",
  "migrations/0006_auth_roles_potential.sql",
  "migrations/0007_import_submission_state.sql",
  "migrations/0008_potential_import_batch.sql",
];

export const INTEGRITY_MIGRATION = "migrations/0009_integrity_audit.sql";

export async function readMigration(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

export async function applyLegacySchema(db, { trackMigrations = false } = {}) {
  if (trackMigrations) {
    await db.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
  }
  for (const relativePath of MIGRATIONS) {
    await db.exec(await readMigration(relativePath));
    if (trackMigrations) {
      await db.query(
        "insert into _migrations (name) values ($1) on conflict (name) do nothing",
        [relativePath.split("/").pop()],
      );
    }
  }
}

export async function seedContinuityData(db) {
  await db.exec(`
    insert into "user" ("id", "name", "email", "emailVerified")
      values ('continuity-user', '连续性测试用户', 'continuity@test.local', true);
    insert into app_users (user_id, email, display_name, role, status)
      values ('continuity-user', 'continuity@test.local', '连续性测试用户', '老板', 'active');
    insert into parts (id, mpn_key, mpn, brand_code)
      values ('continuity-part', 'CONTINUITY-MPN', 'CONTINUITY-MPN', 'TI');
    insert into warehouses (id, code, name)
      values ('continuity-warehouse', 'HK', '香港');
    insert into channels (id, name, is_active)
      values ('continuity-channel', '连续性渠道', true);
    insert into customers (id, name, is_active)
      values ('continuity-customer', '连续性客户', true);
    insert into import_batches (id, kind, source_type, filename, created_by)
      values ('continuity-batch', 'inquiry', 'csv', 'continuity.csv', 'continuity-user');
    insert into stock_lots
      (id, part_id, warehouse_id, status, qty_in, qty_remaining, cost_amount, supplier_id, import_batch_id)
      values ('continuity-lot', 'continuity-part', 'continuity-warehouse', 'on_hand', 12, 12, 1.25, 'continuity-channel', 'continuity-batch');
    insert into stock_movements
      (id, part_id, lot_id, type, qty, to_warehouse_id, import_batch_id)
      values ('continuity-movement', 'continuity-part', 'continuity-lot', 'in', 12, 'continuity-warehouse', 'continuity-batch');
    insert into channel_offers
      (id, channel_id, part_id, qty, price_amount, import_batch_id)
      values ('continuity-offer', 'continuity-channel', 'continuity-part', 5, 2.50, 'continuity-batch');
    insert into customer_inquiries
      (id, customer_id, part_id, qty, import_batch_id)
      values ('continuity-inquiry', 'continuity-customer', 'continuity-part', 3, 'continuity-batch');
    insert into op_logs (id, action, entity_type, entity_id, detail)
      values ('continuity-log', 'create', 'import_batch', 'continuity-batch', 'continuity fixture');
  `);
}

export async function openLegacyDatabase(dataDir, options) {
  const db = new PGlite({ dataDir });
  await db.waitReady;
  await applyLegacySchema(db, options);
  return db;
}

export async function countRows(db, table, id) {
  const result = await db.query(`select count(*)::int as count from ${table} where id = $1`, [id]);
  return result.rows[0].count;
}
