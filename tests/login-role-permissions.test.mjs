import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { APP_ROLES, ROLE_PERMISSIONS, roleHasPermission } from "../src/lib/auth/roles.ts";

test("四个固定角色的服务端策略互斥且覆盖预期操作", () => {
  assert.deepEqual(APP_ROLES, ["老板", "最高督察", "主管", "跟进人"]);
  assert.equal(roleHasPermission("老板", "users.manage"), true);
  assert.equal(roleHasPermission("最高督察", "stock.write"), false);
  assert.equal(roleHasPermission("最高督察", "market.write"), false);
  assert.equal(roleHasPermission("主管", "market.write"), true);
  assert.equal(roleHasPermission("主管", "inventory.import"), false);
  assert.equal(roleHasPermission("跟进人", "inventory.import"), true);
  assert.equal(roleHasPermission("跟进人", "market.read"), false);
  assert.equal(roleHasPermission(null, "model.read"), false);
  assert.ok(ROLE_PERMISSIONS["跟进人"].includes("potential.write"));
});

async function schema() {
  const db = new PGlite();
  for (const file of ["migrations/auth/0001_auth.sql", "migrations/0002_schema.sql", "migrations/0006_auth_roles_potential.sql"]) {
    await db.exec(await readFile(file, "utf8"));
  }
  return db;
}

test("潜力型号按用户隔离、同一用户同一型号唯一，旧 watchlist 数据保留", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  await db.exec(`
    insert into "user" ("id", "name", "email", "emailVerified") values
      ('u-boss', '老板', 'boss@test.local', true), ('u-follow', '跟进', 'follow@test.local', true);
    insert into parts (id, mpn_key, mpn) values ('p-1', 'ABC', 'ABC');
    insert into watchlist (part_id, note) values ('p-1', 'legacy');
    insert into potential_models (user_id, part_id, note) values ('u-boss', 'p-1', 'boss note');
  `);
  await assert.rejects(
    db.exec("insert into potential_models (user_id, part_id) values ('u-boss', 'p-1')"),
    /duplicate key|unique/i,
  );
  const own = await db.query("select note from potential_models where user_id = $1", ["u-follow"]);
  assert.equal(own.rows.length, 0);
  const legacy = await db.query("select note from watchlist where part_id = $1", ["p-1"]);
  assert.equal(legacy.rows[0].note, "legacy");
});

test("库存型号总数只求有效在库批次，调拨保持总数、出库和盘点改变总数", async (t) => {
  const db = await schema();
  t.after(() => db.close());
  await db.exec(`
    insert into parts (id, mpn_key, mpn) values ('p-2', 'INV', 'INV');
    insert into warehouses (id, code, name) values ('w-hk', 'HK', '香港'), ('w-jt', 'JT', '交通');
    insert into stock_lots (id, part_id, warehouse_id, status, qty_in, qty_remaining)
      values ('l-1', 'p-2', 'w-hk', 'on_hand', 55, 55), ('l-2', 'p-2', 'w-jt', 'on_hand', 20, 20),
        ('l-transit', 'p-2', null, 'in_transit', 100, 100), ('l-closed', 'p-2', 'w-hk', 'closed', 9, 0),
        ('l-deleted', 'p-2', 'w-hk', 'on_hand', 8, 8);
    update stock_lots set deleted_at = now() where id = 'l-deleted';
  `);
  const total = async () => (await db.query(`select coalesce(sum(qty_remaining), 0)::int as total from stock_lots where part_id = 'p-2' and deleted_at is null and status = 'on_hand' and qty_remaining > 0`)).rows[0].total;
  assert.equal(await total(), 75);

  await db.exec("update stock_lots set qty_remaining = 35 where id = 'l-1'; insert into stock_lots (id, part_id, warehouse_id, status, qty_in, qty_remaining) values ('l-transfer', 'p-2', 'w-jt', 'on_hand', 20, 20)");
  assert.equal(await total(), 75);
  await db.exec("update stock_lots set qty_remaining = qty_remaining - 5 where id = 'l-2'");
  assert.equal(await total(), 70);
  await db.exec("update stock_lots set qty_remaining = 12 where id = 'l-2'");
  assert.equal(await total(), 67);

  await db.exec(`
    insert into channels (id, name) values ('ch-1', '渠道');
    insert into channel_offers (id, channel_id, part_id) values ('o-1', 'ch-1', 'p-2'), ('o-2', 'ch-1', 'p-2');
  `);
  const joined = await db.query(`
    select coalesce(sum(l.qty_remaining), 0)::int as total
    from stock_lots l
    where l.part_id = 'p-2' and l.deleted_at is null and l.status = 'on_hand' and l.qty_remaining > 0
      and exists (select 1 from channel_offers o where o.part_id = l.part_id and o.deleted_at is null)
  `);
  assert.equal(joined.rows[0].total, 67);
});
