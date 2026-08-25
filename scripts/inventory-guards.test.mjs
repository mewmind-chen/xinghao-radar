import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("库存批次模型保留来源批次并可追溯流水", async () => {
  const migration = await read("migrations/0005_inventory_lot_lineage.sql");
  const stock = await read("src/lib/server/stock.ts");
  assert.match(migration, /source_lot_id/);
  assert.match(migration, /origin_lot_id/);
  assert.match(stock, /listLotMovements/);
  assert.match(stock, /sourceLotId/);
  assert.match(stock, /origin_lot_id/);
});

test("出库、调拨、修正必须指定 lotId，且使用事务与条件扣减", async () => {
  const stock = await read("src/lib/server/stock.ts");
  assert.match(stock, /validator\(\(input: \{ lotId: string; qty: number/);
  assert.match(stock, /withTransaction\(sql/);
  assert.match(stock, /qty_remaining >= \$\{qty\}/);
  assert.doesNotMatch(stock, /async function consumeLots/);
});

test("导入库存只写入批次成本并以整批事务提交", async () => {
  const source = await read("src/lib/server/import.ts");
  assert.match(source, /effectiveImportKind/);
  assert.match(source, /defaultSupplier/);
  assert.match(source, /return withTransaction\(sql/);
  assert.match(source, /cost_amount, cost_currency, cost_tax/);
  assert.match(source, /没有勾选可写入的行/);
});

test("批次撤销会阻断所有后续库存流水", async () => {
  const source = await read("src/lib/server/settings.ts");
  assert.match(source, /downstream/);
  assert.match(source, /出库、调拨、修正或在途接收/);
  assert.match(source, /source_lot_id/);
  assert.match(source, /withTransaction\(sql/);
});
