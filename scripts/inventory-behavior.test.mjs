import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import { runWithStartContext } from "@tanstack/start-storage-context";

test("inventory operations run against real PGlite with transactional and lineage guarantees", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "xinghao-radar-inventory-"));
  process.env.DATABASE_URL = "";
  process.env.DATA_DIR = dataDir;

  const vite = await createServer({
    root: process.cwd(),
    server: { middlewareMode: true },
    appType: "custom",
  });

  const context = {
    request: new Request("http://localhost/"),
    contextAfterGlobalMiddlewares: {},
  };
  const invoke = async (fn, data) => {
    const envelope = await runWithStartContext(context, () => fn({ data }));
    if (envelope?.error) throw envelope.error;
    return envelope?.result ?? envelope;
  };
  const expectFailure = async (fn, pattern) => {
    await assert.rejects(fn, (error) => {
      assert.match(String(error?.message ?? error), pattern);
      return true;
    });
  };
  const row = (mpn, qty, extra = {}) => ({
    id: crypto.randomUUID(),
    kind: "stock",
    mpn,
    brand: null,
    qty,
    qtyRaw: String(qty),
    dateCode: null,
    priceAmount: null,
    priceCurrency: null,
    priceTax: null,
    isTp: false,
    leadTimeText: null,
    etaText: null,
    warehouse: null,
    channel: null,
    customer: null,
    package: null,
    standardPack: null,
    packState: null,
    costAmount: null,
    costCurrency: null,
    costTax: null,
    note: null,
    duplicate: false,
    duplicateReason: null,
    selected: true,
    warning: null,
    ...extra,
  });

  try {
    const stock = await vite.ssrLoadModule("/src/lib/server/stock.ts?tss-serverfn-split&inventory-behavior");
    const imports = await vite.ssrLoadModule("/src/lib/server/import.ts?tss-serverfn-split&inventory-behavior");
    const settings = await vite.ssrLoadModule("/src/lib/server/settings.ts?tss-serverfn-split&inventory-behavior");
    const parts = await vite.ssrLoadModule("/src/lib/server/parts.ts?tss-serverfn-split&inventory-behavior");
    const domain = await vite.ssrLoadModule("/src/lib/domain.ts?inventory-behavior");
    const db = await vite.ssrLoadModule("/src/lib/db.ts?inventory-behavior");
    const sql = await db.getSql();

    const meta = await invoke(stock.stockMeta_createServerFn_handler);
    assert.deepEqual(meta.warehouses.map((w) => w.code), ["HK", "交通", "坂田"]);

    const nullCost = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-NULL-COST",
      warehouseId: "wh_hk",
      qty: 12,
      supplier: "行为供应商",
      dateCode: "2418+",
    });
    const nullLot = (await sql.query("select * from stock_lots where id = $1", [nullCost.id]))[0];
    assert.equal(nullLot.cost_amount, null);
    assert.equal(nullLot.cost_currency, null);
    assert.equal(nullLot.cost_tax, null);

    const zeroCost = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-ZERO-COST",
      warehouseId: "wh_hk",
      qty: 4,
      costAmount: 0,
      costCurrency: "CNY",
      costTax: "exclusive",
    });
    const zeroLot = (await sql.query("select * from stock_lots where id = $1", [zeroCost.id]))[0];
    assert.equal(Number(zeroLot.cost_amount), 0);
    assert.equal(zeroLot.cost_currency, "CNY");
    assert.equal(zeroLot.cost_tax, "exclusive");
    assert.equal(domain.formatCost(0, "CNY", "exclusive"), "¥0未");
    assert.equal(domain.formatCost(1.2, "USD", "none"), "$1.20");
    assert.equal(domain.formatInventoryQty(25), "25片");
    assert.equal(domain.formatInventoryQty(1000), "1K");

    await expectFailure(
      () => invoke(stock.stockInbound_createServerFn_handler, {
        mpn: "BEHAVIOR-BAD-COST",
        warehouseId: "wh_hk",
        qty: 1,
        costAmount: 2,
        costTax: "exclusive",
      }),
      /必须选择币种/,
    );

    const concurrent = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-CONCURRENT",
      warehouseId: "wh_hk",
      qty: 10,
    });
    const concurrentResults = await Promise.allSettled([
      invoke(stock.stockOutbound_createServerFn_handler, { lotId: concurrent.id, qty: 6 }),
      invoke(stock.stockOutbound_createServerFn_handler, { lotId: concurrent.id, qty: 6 }),
    ]);
    assert.equal(concurrentResults.filter((r) => r.status === "fulfilled").length, 1);
    const concurrentLot = (await sql.query("select qty_remaining from stock_lots where id = $1", [concurrent.id]))[0];
    assert.equal(Number(concurrentLot.qty_remaining), 4);
    await expectFailure(
      () => invoke(stock.stockOutbound_createServerFn_handler, { lotId: concurrent.id, qty: 5 }),
      /库存不足|被其他操作改变/,
    );
    const nonNegative = (await sql.query("select min(qty_remaining) as n from stock_lots where id = $1", [concurrent.id]))[0];
    assert.ok(Number(nonNegative.n) >= 0);

    const adjusted = await invoke(stock.stockAdjust_createServerFn_handler, {
      lotId: nullCost.id,
      countedQty: 15,
    });
    assert.equal(adjusted.beforeQty, 12);
    assert.equal(adjusted.countedQty, 15);
    assert.equal(Number(adjusted.qtyRemaining), 15);
    const adjustmentRows = await sql.query(
      "select count(*)::int as n, max(note) as note from stock_movements where lot_id = $1 and type = 'adjust'",
      [nullCost.id],
    );
    assert.equal(Number(adjustmentRows[0].n), 1);
    assert.match(String(adjustmentRows[0].note), /修 12 → 15/);

    const lineageSource = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-LINEAGE",
      warehouseId: "wh_hk",
      qty: 8,
      dateCode: "2418",
      costAmount: 8.5,
      costCurrency: "CNY",
      costTax: "exclusive",
      supplier: "原供应商",
    });
    const transfer = await invoke(stock.stockTransfer_createServerFn_handler, {
      lotId: lineageSource.id,
      toWarehouseId: "wh_jt",
      qty: 3,
    });
    await invoke(stock.stockLotUpdate_createServerFn_handler, {
      lotId: transfer.destinationLotId,
      costAmount: 9.5,
      costCurrency: "CNY",
      costTax: "inclusive",
      supplier: "新供应商",
      dateCode: "2418+",
    });
    const lineageRows = await sql.query(
      "select id, origin_lot_id, cost_amount, cost_currency, cost_tax, date_code, supplier_id from stock_lots where origin_lot_id = (select origin_lot_id from stock_lots where id = $1) order by id",
      [lineageSource.id],
    );
    assert.ok(lineageRows.length >= 2);
    for (const lot of lineageRows) {
      assert.equal(Number(lot.cost_amount), 9.5);
      assert.equal(lot.cost_currency, "CNY");
      assert.equal(lot.cost_tax, "inclusive");
      assert.equal(lot.date_code, "2418+");
      assert.ok(lot.supplier_id);
    }
    const transferMovement = (await sql.query(
      "select source_lot_id, type from stock_movements where lot_id = $1 and type = 'transfer'",
      [transfer.destinationLotId],
    ))[0];
    assert.equal(transferMovement.source_lot_id, lineageSource.id);
    assert.equal(transferMovement.type, "transfer");

    const identitySource = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-IDENTITY-OLD",
      warehouseId: "wh_hk",
      qty: 7,
      dateCode: "2418",
    });
    const identityPart = (await sql.query("select id from parts where mpn = 'BEHAVIOR-IDENTITY-OLD'"))[0];
    const identityMovement = (await sql.query("select id from stock_movements where lot_id = $1 and type = 'in'", [identitySource.id]))[0];
    await invoke(parts.updatePartIdentity_createServerFn_handler, {
      id: identityPart.id,
      mpn: "BEHAVIOR-IDENTITY-NEW",
    });
    const identityAfter = (await sql.query("select id, mpn from parts where id = $1", [identityPart.id]))[0];
    assert.equal(identityAfter.id, identityPart.id);
    assert.equal(identityAfter.mpn, "BEHAVIOR-IDENTITY-NEW");
    assert.equal((await sql.query("select part_id from stock_lots where id = $1", [identitySource.id]))[0].part_id, identityPart.id);
    assert.equal((await sql.query("select part_id from stock_movements where id = $1", [identityMovement.id]))[0].part_id, identityPart.id);
    await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-IDENTITY-CLASH",
      warehouseId: "wh_hk",
      qty: 1,
    });
    await expectFailure(
      () => invoke(parts.updatePartIdentity_createServerFn_handler, { id: identityPart.id, mpn: "BEHAVIOR-IDENTITY-CLASH" }),
      /同型号已存在/,
    );

    const duplicateSeed = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-DUPLICATE",
      warehouseId: "wh_hk",
      qty: 4,
      dateCode: "2418",
      costAmount: 2,
      costCurrency: "CNY",
      costTax: "exclusive",
      supplier: "重复供应商",
    });
    const duplicatePreview = await invoke(imports.parseImport_createServerFn_handler, {
      kind: "stock",
      sourceType: "csv",
      text: "型号,数量,批次,仓库,成本,供应商\nBEHAVIOR-DUPLICATE,4,2418,HK,¥2未税,重复供应商",
      defaultWarehouseId: "wh_hk",
      defaultCurrency: "CNY",
      defaultTax: "exclusive",
    });
    assert.equal(duplicatePreview.rows[0].duplicate, true);
    await sql.query("update stock_lots set inbound_at = now() - interval '91 days' where id = $1", [duplicateSeed.id]);
    const stalePreview = await invoke(imports.parseImport_createServerFn_handler, {
      kind: "stock",
      sourceType: "csv",
      text: "型号,数量,批次,仓库,成本,供应商\nBEHAVIOR-DUPLICATE,4,2418,HK,¥2未税,重复供应商",
      defaultWarehouseId: "wh_hk",
      defaultCurrency: "CNY",
      defaultTax: "exclusive",
    });
    assert.equal(stalePreview.rows[0].duplicate, false);

    const rollbackBefore = Number((await sql.query("select count(*)::int as n from import_batches"))[0].n);
    await expectFailure(
      () => invoke(imports.confirmImport_createServerFn_handler, {
        kind: "stock",
        sourceType: "text",
        defaultWarehouseId: "wh_hk",
        defaultSupplier: "回滚供应商",
        defaultCurrency: "CNY",
        defaultTax: "exclusive",
        rows: [row("BEHAVIOR-ROLLBACK-A", 1), row("   ", 1)],
      }),
      /型号不能为空/,
    );
    const rollbackAfter = Number((await sql.query("select count(*)::int as n from import_batches"))[0].n);
    assert.equal(rollbackAfter, rollbackBefore);
    assert.equal(Number((await sql.query("select count(*)::int as n from parts where mpn = 'BEHAVIOR-ROLLBACK-A'"))[0].n), 0);

    const imported = await invoke(imports.confirmImport_createServerFn_handler, {
      kind: "stock",
      sourceType: "text",
      defaultWarehouseId: "wh_hk",
      defaultSupplier: "导入供应商",
      defaultCurrency: "CNY",
      defaultTax: "exclusive",
      rows: [row("BEHAVIOR-UNDO", 2)],
    });
    const importedLot = (await sql.query("select id from stock_lots where import_batch_id = $1", [imported.batchId]))[0];
    assert.ok(importedLot.id);
    await invoke(settings.undoImportBatch_createServerFn_handler, { id: imported.batchId });
    assert.equal(Number((await sql.query("select count(*)::int as n from stock_lots where id = $1 and deleted_at is not null", [importedLot.id]))[0].n), 1);

    const blocked = await invoke(imports.confirmImport_createServerFn_handler, {
      kind: "stock",
      sourceType: "text",
      defaultWarehouseId: "wh_hk",
      defaultCurrency: "CNY",
      defaultTax: "exclusive",
      rows: [row("BEHAVIOR-UNDO-BLOCKED", 3)],
    });
    const blockedLot = (await sql.query("select id from stock_lots where import_batch_id = $1", [blocked.batchId]))[0];
    await invoke(stock.stockOutbound_createServerFn_handler, { lotId: blockedLot.id, qty: 1 });
    await expectFailure(
      () => invoke(settings.undoImportBatch_createServerFn_handler, { id: blocked.batchId }),
      /不能整批撤销/,
    );

    const stockList = await invoke(stock.listStock_createServerFn_handler, {});
    assert.ok(stockList.summary.lots >= 1);
    assert.equal(domain.formatStockDateCode("2418+"), "24+");
    assert.equal(domain.formatStockDateCode("0918"), "09+");

    // /parts 的真实型号库口径：通过真实库存操作写入 PGlite，再调用实际 searchParts
    // server handler 验证总在库数量，避免用源码正则或静态文案测试冒充行为测试。
    const findPartItem = async (mpn) => {
      const items = await invoke(parts.searchParts_createServerFn_handler, { q: mpn, filter: "all" });
      assert.equal(items.length, 1, `应找到唯一型号 ${mpn}`);
      return items[0];
    };
    const onHandLabel = (item) => item.onHandLabel ?? "";

    const oneLot = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-ONE",
      warehouseId: "wh_hk",
      qty: 25,
    });
    const oneLotItem = await findPartItem("BEHAVIOR-PARTS-ONE");
    assert.equal(oneLotItem.flags.onHand, 25);
    assert.equal(onHandLabel(oneLotItem), "25片");
    assert.ok(oneLot.id);

    const splitHk = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-TOTAL",
      warehouseId: "wh_hk",
      qty: 55,
      supplier: "行为总量供应商",
    });
    await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-TOTAL",
      warehouseId: "wh_jt",
      qty: 20,
      supplier: "行为总量供应商",
    });
    const totalItem = await findPartItem("BEHAVIOR-PARTS-TOTAL");
    assert.equal(totalItem.flags.onHand, 75);
    assert.equal(onHandLabel(totalItem), "75片");
    assert.ok(!onHandLabel(totalItem).includes("HK"));
    assert.ok(!onHandLabel(totalItem).includes("交通"));
    assert.equal(totalItem.flags.byWarehouse.find((w) => w.code === "HK")?.qty, 55);
    assert.equal(totalItem.flags.byWarehouse.find((w) => w.code === "交通")?.qty, 20);
    assert.ok(splitHk.id);

    await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-MULTI-LOT",
      warehouseId: "wh_hk",
      qty: 10,
    });
    await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-MULTI-LOT",
      warehouseId: "wh_hk",
      qty: 15,
    });
    const multiLotItem = await findPartItem("BEHAVIOR-PARTS-MULTI-LOT");
    assert.equal(multiLotItem.flags.onHand, 25);
    assert.equal(onHandLabel(multiLotItem), "25片");

    const transferSource = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-TRANSFER",
      warehouseId: "wh_hk",
      qty: 20,
    });
    await invoke(stock.stockTransfer_createServerFn_handler, {
      lotId: transferSource.id,
      toWarehouseId: "wh_jt",
      qty: 20,
    });
    const transferItem = await findPartItem("BEHAVIOR-PARTS-TRANSFER");
    assert.equal(transferItem.flags.onHand, 20);
    assert.equal(onHandLabel(transferItem), "20片");
    assert.equal(transferItem.flags.byWarehouse.find((w) => w.code === "HK")?.qty, undefined);
    assert.equal(transferItem.flags.byWarehouse.find((w) => w.code === "交通")?.qty, 20);

    const outboundSource = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-OUT",
      warehouseId: "wh_hk",
      qty: 20,
    });
    await invoke(stock.stockOutbound_createServerFn_handler, { lotId: outboundSource.id, qty: 5 });
    const outboundItem = await findPartItem("BEHAVIOR-PARTS-OUT");
    assert.equal(outboundItem.flags.onHand, 15);
    assert.equal(onHandLabel(outboundItem), "15片");

    const adjustSource = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-ADJUST",
      warehouseId: "wh_hk",
      qty: 20,
    });
    await invoke(stock.stockAdjust_createServerFn_handler, { lotId: adjustSource.id, countedQty: 23 });
    const adjustItem = await findPartItem("BEHAVIOR-PARTS-ADJUST");
    assert.equal(adjustItem.flags.onHand, 23);
    assert.equal(onHandLabel(adjustItem), "23片");

    const closedSource = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-EXCLUDE",
      warehouseId: "wh_hk",
      qty: 5,
    });
    await invoke(stock.stockOutbound_createServerFn_handler, { lotId: closedSource.id, qty: 5 });
    const deletedSource = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-EXCLUDE",
      warehouseId: "wh_jt",
      qty: 7,
    });
    await sql.query("update stock_lots set deleted_at = now() where id = $1", [deletedSource.id]);
    const excludedItem = await findPartItem("BEHAVIOR-PARTS-EXCLUDE");
    assert.equal(excludedItem.flags.onHand, 0);
    assert.equal(onHandLabel(excludedItem), "");

    await invoke(stock.openTransit_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-TRANSIT",
      qty: 30,
      etaText: "下周",
    });
    const transitItem = await findPartItem("BEHAVIOR-PARTS-TRANSIT");
    assert.equal(transitItem.flags.onHand, 0);
    assert.equal(transitItem.flags.inTransit, 30);
    assert.equal(onHandLabel(transitItem), "途 30片");

    const joinPart = await invoke(stock.stockInbound_createServerFn_handler, {
      mpn: "BEHAVIOR-PARTS-JOIN-NO-DUP",
      warehouseId: "wh_hk",
      qty: 75,
    });
    await sql.query("insert into channels (id, name) values ($1, $2)", ["behavior_parts_channel", "行为关联渠道"]);
    await sql.query("insert into customers (id, name) values ($1, $2)", ["behavior_parts_customer", "行为关联客户"]);
    for (let i = 0; i < 3; i += 1) {
      await sql.query(
        "insert into channel_offers (id, channel_id, part_id, qty) values ($1, $2, $3, $4)",
        [`behavior_parts_offer_${i}`, "behavior_parts_channel", joinPart.partId, i + 1],
      );
      await sql.query(
        "insert into customer_inquiries (id, customer_id, part_id, qty) values ($1, $2, $3, $4)",
        [`behavior_parts_inquiry_${i}`, "behavior_parts_customer", joinPart.partId, i + 1],
      );
    }
    const joinItem = await findPartItem("BEHAVIOR-PARTS-JOIN-NO-DUP");
    assert.equal(joinItem.flags.onHand, 75);
    assert.equal(onHandLabel(joinItem), "75片");
    assert.equal(joinItem.flags.offerCount, 3);
    assert.equal(joinItem.flags.inquiryCount, 3);

    await invoke(parts.createPart_createServerFn_handler, { mpn: "BEHAVIOR-PARTS-EMPTY" });
    const emptyItem = await findPartItem("BEHAVIOR-PARTS-EMPTY");
    assert.equal(emptyItem.flags.onHand, 0);
    assert.equal(emptyItem.flags.inTransit, 0);
    assert.equal(onHandLabel(emptyItem), "");
    console.log("inventory behavior: PGlite transactional, cost, duplicate-window, lineage, adjustment, and undo checks passed");
  } finally {
    await vite.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
