import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  INTEGRITY_MIGRATION,
  openLegacyDatabase,
  readMigration,
  seedContinuityData,
} from "./rehearsal-fixtures.mjs";

function makeDataDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dataDir = join(root, "pglite");
  mkdirSync(dataDir);
  return { root, dataDir };
}

test("PGlite continuity survives the PR13 schema migration and a restart", async () => {
  const { root, dataDir } = makeDataDir("xinghao-radar-continuity-");
  try {
    const oldDb = await openLegacyDatabase(dataDir, { trackMigrations: true });
    await seedContinuityData(oldDb);
    await oldDb.close();

    const upgraded = new PGlite({ dataDir });
    await upgraded.waitReady;
    await upgraded.exec(await readMigration(INTEGRITY_MIGRATION));
    await upgraded.exec(
      "insert into _migrations (name) values ('0009_integrity_audit.sql') on conflict (name) do nothing",
    );
    await upgraded.close();

    const restarted = new PGlite({ dataDir });
    await restarted.waitReady;
    await restarted.exec(await readMigration(INTEGRITY_MIGRATION));
    const checks = await Promise.all([
      restarted.query("select count(*)::int as count from \"user\" where id = 'continuity-user'"),
      restarted.query("select count(*)::int as count from parts where id = 'continuity-part'"),
      restarted.query("select count(*)::int as count from stock_lots where id = 'continuity-lot'"),
      restarted.query("select count(*)::int as count from channel_offers where id = 'continuity-offer'"),
      restarted.query("select count(*)::int as count from customer_inquiries where id = 'continuity-inquiry'"),
      restarted.query("select count(*)::int as count from import_batches where id = 'continuity-batch'"),
      restarted.query("select count(*)::int as count from _migrations where name = '0009_integrity_audit.sql'"),
    ]);
    assert.deepEqual(checks.map((result) => result.rows[0].count), [1, 1, 1, 1, 1, 1, 1]);
    await restarted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0009 rehearsal checks a clean copy and leaves duplicate names for manual review", async () => {
  const clean = makeDataDir("xinghao-radar-migration-clean-");
  try {
    const db = await openLegacyDatabase(clean.dataDir);
    await seedContinuityData(db);
    const duplicateChannels = await db.query(
      "select lower(trim(name)) as name_key, count(*)::int as count from channels group by lower(trim(name)) having count(*) > 1",
    );
    const duplicateCustomers = await db.query(
      "select lower(trim(name)) as name_key, count(*)::int as count from customers group by lower(trim(name)) having count(*) > 1",
    );
    const emptyChannels = await db.query(
      "select count(*)::int as count from channels where trim(name) = ''",
    );
    const emptyCustomers = await db.query(
      "select count(*)::int as count from customers where trim(name) = ''",
    );
    const orphanedBatches = await db.query(`
      select count(*)::int as count from (
        select import_batch_id from stock_lots where import_batch_id is not null
          and not exists (select 1 from import_batches b where b.id = stock_lots.import_batch_id)
        union all
        select import_batch_id from channel_offers where import_batch_id is not null
          and not exists (select 1 from import_batches b where b.id = channel_offers.import_batch_id)
        union all
        select import_batch_id from customer_inquiries where import_batch_id is not null
          and not exists (select 1 from import_batches b where b.id = customer_inquiries.import_batch_id)
      ) orphaned
    `);
    assert.equal(duplicateChannels.rows.length, 0);
    assert.equal(duplicateCustomers.rows.length, 0);
    assert.equal(emptyChannels.rows[0].count, 0);
    assert.equal(emptyCustomers.rows[0].count, 0);
    assert.equal(orphanedBatches.rows[0].count, 0);
    await db.exec(await readMigration(INTEGRITY_MIGRATION));
    const retained = await db.query(
      "select count(*)::int as count from channels where id = 'continuity-channel'",
    );
    assert.equal(retained.rows[0].count, 1);
    await db.close();
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
  }

  const duplicate = makeDataDir("xinghao-radar-migration-conflict-");
  try {
    const db = await openLegacyDatabase(duplicate.dataDir);
    await db.exec(`
      insert into channels (id, name) values ('duplicate-1', 'Acme'), ('duplicate-2', ' acme ');
    `);
    await db.exec("begin");
    await assert.rejects(db.exec(await readMigration(INTEGRITY_MIGRATION)));
    await db.exec("rollback");
    const columns = await db.query(
      "select count(*)::int as count from information_schema.columns where table_name = 'channels' and column_name = 'name_key'",
    );
    assert.equal(columns.rows[0].count, 0, "失败迁移不能留下半迁移列");
    await db.close();
  } finally {
    rmSync(duplicate.root, { recursive: true, force: true });
  }
});
