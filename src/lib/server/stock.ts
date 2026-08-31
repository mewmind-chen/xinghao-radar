import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getCurrentPrincipal, potentialScopeFor, requireRole } from "@/lib/auth/authorization.server";
import { formatStockLine, iso, parseLeadTime } from "@/lib/domain";
import type { CostTax, Currency, PackState, StockMovement } from "@/lib/types";
import {
  asCostTax,
  asCurrency,
  asPack,
  ensureChannel,
  ensurePart,
  getSettings,
  listWarehouses,
  logOp,
  matchFlagsForParts,
  nid,
  sqlClient,
  withTransaction,
} from "./helpers";
import { ensureSeed } from "./seed";

type LotRow = Record<string, unknown>;

function positiveInteger(value: number, label = "数量"): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}必须是大于 0 的整数`);
  }
  return value;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error("盘点数量必须是大于等于 0 的整数");
  }
  return value;
}

function validateCost(
  amount: number | null,
  currency: Currency | null,
  tax: CostTax | null,
): void {
  if (amount == null) {
    if (currency != null || tax != null) throw new Error("成本为空时币种和税别也必须为空");
    return;
  }
  if (!Number.isFinite(amount) || amount < 0) throw new Error("成本必须为空或不小于 0");
  if (!currency) throw new Error("填写成本时必须选择币种");
  if (currency === "USD" && tax !== "none") throw new Error("美元成本税别只能是无");
  if (currency === "CNY" && tax !== "exclusive" && tax !== "inclusive") {
    throw new Error("人民币成本必须选择含税或未税");
  }
}

async function readOnHandLot(
  sql: Awaited<ReturnType<typeof sqlClient>>,
  lotId: string,
): Promise<LotRow> {
  const rows = await sql`
    select * from stock_lots
    where id = ${lotId} and deleted_at is null and status in ('on_hand', 'closed')
    for update
  `;
  if (!rows[0]) throw new Error("库存批次不存在或已关闭");
  if (!rows[0].warehouse_id) throw new Error("该批次不属于仓库库存");
  return rows[0];
}

async function debitLot(
  sql: Awaited<ReturnType<typeof sqlClient>>,
  lotId: string,
  qty: number,
): Promise<{ lot: LotRow; next: number }> {
  const lot = await readOnHandLot(sql, lotId);
  const remaining = Number(lot.qty_remaining);
  if (remaining < qty) throw new Error(`批次库存不足，当前仅剩 ${remaining}`);
  const next = remaining - qty;
  const updated = await sql`
    update stock_lots
    set qty_remaining = ${next}, status = ${next === 0 ? "closed" : "on_hand"}
    where id = ${lotId}
      and deleted_at is null
      and status in ('on_hand', 'closed')
      and qty_remaining >= ${qty}
    returning id
  `;
  if (!updated[0]) throw new Error("库存已被其他操作改变，请刷新后重试");
  return { lot, next };
}

async function creditLot(
  sql: Awaited<ReturnType<typeof sqlClient>>,
  lotId: string,
  delta: number,
): Promise<LotRow> {
  const lot = await readOnHandLot(sql, lotId);
  const remaining = Number(lot.qty_remaining);
  if (delta < 0 && remaining < -delta) throw new Error(`批次库存不足，当前仅剩 ${remaining}`);
  const next = remaining + delta;
  const updated = await sql`
    update stock_lots
    set qty_remaining = ${next}, status = ${next === 0 ? "closed" : "on_hand"}
    where id = ${lotId}
      and deleted_at is null
      and status in ('on_hand', 'closed')
      and qty_remaining >= ${delta < 0 ? -delta : 0}
    returning *
  `;
  if (!updated[0]) throw new Error("库存已被其他操作改变，请刷新后重试");
  return updated[0];
}

function mapMovement(r: Record<string, unknown>): StockMovement {
  return {
    id: String(r.id),
    partId: String(r.part_id),
    lotId: r.lot_id ? String(r.lot_id) : null,
    sourceLotId: r.source_lot_id ? String(r.source_lot_id) : null,
    type: String(r.type) as StockMovement["type"],
    qty: Number(r.qty),
    fromWarehouseId: r.from_warehouse_id ? String(r.from_warehouse_id) : null,
    fromWarehouseCode: r.from_warehouse_code ? String(r.from_warehouse_code) : null,
    toWarehouseId: r.to_warehouse_id ? String(r.to_warehouse_id) : null,
    toWarehouseCode: r.to_warehouse_code ? String(r.to_warehouse_code) : null,
    happenedAt: iso(r.happened_at),
    note: r.note ? String(r.note) : null,
  };
}

export const listStock = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { warehouseId?: string; q?: string } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "stock.read");
    const sql = await sqlClient();
    await ensureSeed(sql);
    const warehouses = await listWarehouses(sql);
    const lots = await sql`
      select l.*, p.mpn, p.brand_code, w.code as wh_code, ch.name as supplier_name
      from stock_lots l
      join parts p on p.id = l.part_id
      left join warehouses w on w.id = l.warehouse_id
      left join channels ch on ch.id = l.supplier_id
      where l.deleted_at is null and l.qty_remaining > 0
        and l.status in ('on_hand','in_transit')
      order by p.mpn, l.status, l.inbound_at desc
    `;
    const partIds = [...new Set(lots.map((r) => String(r.part_id)))];
    const flags = await matchFlagsForParts(sql, partIds, undefined, principal.userId, potentialScopeFor(principal));
    let items = lots.map((r) => ({
      id: String(r.id),
      partId: String(r.part_id),
      mpn: String(r.mpn),
      brandCode: r.brand_code ? String(r.brand_code) : null,
      warehouseId: r.warehouse_id ? String(r.warehouse_id) : null,
      warehouseCode: r.wh_code ? String(r.wh_code) : null,
      status: String(r.status) as "on_hand" | "in_transit" | "closed",
      qtyIn: Number(r.qty_in),
      qtyRemaining: Number(r.qty_remaining),
      dateCode: r.date_code ? String(r.date_code) : null,
      package: r.package ? String(r.package) : null,
      standardPack: r.standard_pack ? String(r.standard_pack) : null,
      packState: asPack(r.pack_state),
      costAmount: r.cost_amount != null ? Number(r.cost_amount) : null,
      costCurrency: asCurrency(r.cost_currency),
      costTax: asCostTax(r.cost_tax),
      supplierId: r.supplier_id ? String(r.supplier_id) : null,
      supplierName: r.supplier_name ? String(r.supplier_name) : null,
      sourceLotId: r.source_lot_id ? String(r.source_lot_id) : null,
      originLotId: r.origin_lot_id ? String(r.origin_lot_id) : String(r.id),
      inboundAt: iso(r.inbound_at),
      etaDate: r.eta_date ? String(r.eta_date) : null,
      etaText: r.eta_text ? String(r.eta_text) : null,
      etaPrecision: r.eta_precision ? String(r.eta_precision) : null,
      flags: flags.get(String(r.part_id)) ?? null,
    }));
    if (data.warehouseId === "transit") items = items.filter((i) => i.status === "in_transit");
    else if (data.warehouseId) items = items.filter((i) => i.warehouseId === data.warehouseId);
    if (data.q) {
      const q = data.q.trim().toUpperCase();
      items = items.filter(
        (i) => i.mpn.toUpperCase().includes(q) || (i.brandCode ?? "").toUpperCase().includes(q),
      );
    }
    const summary = {
      onHand: items.filter((i) => i.status === "on_hand").reduce((a, b) => a + b.qtyRemaining, 0),
      transit: items.filter((i) => i.status === "in_transit").reduce((a, b) => a + b.qtyRemaining, 0),
      sku: new Set(items.map((i) => i.partId)).size,
      lots: items.length,
    };
    return { warehouses, items, summary };
  });

export const listLotMovements = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { lotId: string }) => input)
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.read");
    const sql = await sqlClient();
    const rows = await sql`
      select m.*, fw.code as from_warehouse_code, tw.code as to_warehouse_code
      from stock_movements m
      left join warehouses fw on fw.id = m.from_warehouse_id
      left join warehouses tw on tw.id = m.to_warehouse_id
      where m.deleted_at is null and (m.lot_id = ${data.lotId} or m.source_lot_id = ${data.lotId})
      order by m.happened_at desc
    `;
    return rows.map(mapMovement);
  });

export const stockInbound = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      mpn: string;
      warehouseId: string;
      qty: number;
      dateCode?: string;
      package?: string;
      standardPack?: string;
      packState?: PackState;
      costAmount?: number;
      costCurrency?: Currency;
      costTax?: CostTax;
      supplier?: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.write");
    positiveInteger(data.qty);
    validateCost(data.costAmount ?? null, data.costCurrency ?? null, data.costTax ?? null);
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const wh = await tx`select id from warehouses where id = ${data.warehouseId} and is_active = true`;
      if (!wh[0]) throw new Error("仓库不存在或已停用");
      const part = await ensurePart(tx, data.mpn, { package: data.package, source: "入库" });
      const supplier = data.supplier ? await ensureChannel(tx, data.supplier) : null;
      const id = nid();
      await tx`
        insert into stock_lots (
          id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
          standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, origin_lot_id
        ) values (
          ${id}, ${part.id}, ${data.warehouseId}, 'on_hand', ${data.qty}, ${data.qty},
          ${data.dateCode ?? null}, ${data.package ?? null}, ${data.standardPack ?? null},
          ${data.packState ?? null}, ${data.costAmount ?? null}, ${data.costCurrency ?? null},
          ${data.costTax ?? null}, ${supplier?.id ?? null}, ${id}
        )
      `;
      await tx`
        insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id)
        values (${nid()}, ${part.id}, ${id}, 'in', ${data.qty}, ${data.warehouseId})
      `;
      await tx`update parts set updated_at = now() where id = ${part.id}`;
      return { id, partId: part.id };
    });
  });

export const stockOutbound = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { lotId: string; qty: number; note?: string }) => input)
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.write");
    positiveInteger(data.qty);
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const used = await debitLot(tx, data.lotId, data.qty);
      const warehouseId = String(used.lot.warehouse_id);
      await tx`
        insert into stock_movements (id, part_id, lot_id, type, qty, from_warehouse_id, note)
        values (${nid()}, ${used.lot.part_id}, ${data.lotId}, 'out', ${data.qty}, ${warehouseId}, ${data.note ?? null})
      `;
      await tx`update parts set updated_at = now() where id = ${used.lot.part_id}`;
      return { ok: true as const, lotId: data.lotId, qtyRemaining: used.next };
    });
  });

export const stockTransfer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: { lotId: string; toWarehouseId: string; qty: number; note?: string }) => input,
  )
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.write");
    positiveInteger(data.qty);
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const to = await tx`select id from warehouses where id = ${data.toWarehouseId} and is_active = true`;
      if (!to[0]) throw new Error("目标仓库不存在或已停用");
      const lot = await readOnHandLot(tx, data.lotId);
      if (String(lot.warehouse_id) === data.toWarehouseId) throw new Error("调拨仓库不能相同");
      const used = await debitLot(tx, data.lotId, data.qty);
      const newId = nid();
      await tx`
        insert into stock_lots (
          id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
          standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id,
          inbound_at, source_lot_id, origin_lot_id
        ) values (
          ${newId}, ${lot.part_id}, ${data.toWarehouseId}, 'on_hand', ${data.qty}, ${data.qty},
          ${lot.date_code ?? null}, ${lot.package ?? null}, ${lot.standard_pack ?? null},
          ${lot.pack_state ?? null}, ${lot.cost_amount ?? null}, ${lot.cost_currency ?? null},
          ${lot.cost_tax ?? null}, ${lot.supplier_id ?? null}, now(), ${data.lotId}, ${String(lot.origin_lot_id || lot.id)}
        )
      `;
      await tx`
        insert into stock_movements (
          id, part_id, lot_id, source_lot_id, type, qty, from_warehouse_id, to_warehouse_id, note
        ) values (
          ${nid()}, ${lot.part_id}, ${newId}, ${data.lotId}, 'transfer', ${data.qty},
          ${lot.warehouse_id}, ${data.toWarehouseId}, ${data.note ?? null}
        )
      `;
      await tx`update parts set updated_at = now() where id = ${lot.part_id}`;
      return { ok: true as const, sourceLotId: data.lotId, destinationLotId: newId, qtyRemaining: used.next };
    });
  });

export const stockAdjust = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { lotId: string; countedQty: number; note?: string }) => input)
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.write");
    nonNegativeInteger(data.countedQty);
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const before = await readOnHandLot(tx, data.lotId);
      const beforeQty = Number(before.qty_remaining);
      const delta = data.countedQty - beforeQty;
      if (delta === 0) return { ok: true as const, lotId: data.lotId, qtyRemaining: beforeQty, unchanged: true as const };
      const after = await creditLot(tx, data.lotId, delta);
      const warehouseId = String(before.warehouse_id);
      await tx`
        insert into stock_movements (
          id, part_id, lot_id, type, qty, from_warehouse_id, to_warehouse_id, note
        ) values (
          ${nid()}, ${before.part_id}, ${data.lotId}, 'adjust', ${Math.abs(delta)},
          ${delta < 0 ? warehouseId : null}, ${delta > 0 ? warehouseId : null},
          ${data.note ?? `修 ${beforeQty} → ${data.countedQty}`}
        )
      `;
      await logOp(tx, "adjust", "lot", data.lotId, `${beforeQty}→${data.countedQty}`);
      await tx`update parts set updated_at = now() where id = ${before.part_id}`;
      return { ok: true as const, lotId: data.lotId, qtyRemaining: Number(after.qty_remaining), beforeQty, countedQty: data.countedQty };
    });
  });

export const stockLotUpdate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      lotId: string;
      costAmount: number | null;
      costCurrency: Currency | null;
      costTax: CostTax | null;
      supplier?: string | null;
      dateCode?: string | null;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.write");
    validateCost(data.costAmount, data.costCurrency, data.costTax);
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const current = await tx`
        select part_id, supplier_id, date_code, coalesce(origin_lot_id, id) as origin_lot_id
        from stock_lots
        where id = ${data.lotId} and deleted_at is null
      `;
      if (!current[0]) throw new Error("批次不存在");
      const supplierProvided = data.supplier !== undefined;
      const dateCodeProvided = data.dateCode !== undefined;
      const supplier = supplierProvided && data.supplier?.trim() ? await ensureChannel(tx, data.supplier.trim()) : null;
      const originLotId = String(current[0].origin_lot_id);
      const supplierId = supplierProvided ? supplier?.id ?? null : current[0].supplier_id ?? null;
      const dateCode = dateCodeProvided ? data.dateCode?.trim() || null : current[0].date_code ?? null;
      const rows = await tx`
        update stock_lots
        set cost_amount = ${data.costAmount},
            cost_currency = ${data.costCurrency},
            cost_tax = ${data.costTax},
            supplier_id = ${supplierId},
            date_code = ${dateCode}
        where deleted_at is null and coalesce(origin_lot_id, id) = ${originLotId}
        returning id
      `;
      if (!rows[0]) throw new Error("批次不存在");
      await logOp(tx, "cost_update", "lot", data.lotId);
      return { ok: true as const, originLotId, updatedLots: rows.length };
    });
  });

// 保留第一轮调用名，所有成本编辑都走同一原始批次事实。
export const stockCostUpdate = stockLotUpdate;

export const openTransit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      mpn: string;
      qty: number;
      etaText?: string;
      dateCode?: string;
      costAmount?: number;
      costCurrency?: Currency;
      costTax?: CostTax;
      supplier?: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.write");
    positiveInteger(data.qty);
    validateCost(data.costAmount ?? null, data.costCurrency ?? null, data.costTax ?? null);
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const part = await ensurePart(tx, data.mpn, { source: "在途" });
      const supplier = data.supplier ? await ensureChannel(tx, data.supplier) : null;
      const parsed = data.etaText ? parseLeadTime(data.etaText) : null;
      const id = nid();
      await tx`
        insert into stock_lots (
          id, part_id, status, qty_in, qty_remaining, date_code,
          cost_amount, cost_currency, cost_tax, supplier_id, ordered_at, eta_date, eta_text, eta_precision,
          origin_lot_id
        ) values (
          ${id}, ${part.id}, 'in_transit', ${data.qty}, ${data.qty}, ${data.dateCode ?? null},
          ${data.costAmount ?? null}, ${data.costCurrency ?? null}, ${data.costTax ?? null},
          ${supplier?.id ?? null}, now(), ${parsed?.etaDate ?? null}, ${parsed?.original ?? data.etaText ?? null},
          ${parsed?.precision ?? null}, ${id}
        )
      `;
      await tx`
        insert into stock_movements (id, part_id, lot_id, type, qty, note)
        values (${nid()}, ${part.id}, ${id}, 'transit_open', ${data.qty}, ${data.etaText ?? null})
      `;
      return { id, partId: part.id };
    });
  });

export const receiveTransit = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { lotId: string; warehouseId: string; qty: number }) => input)
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "stock.write");
    positiveInteger(data.qty);
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const wh = await tx`select id from warehouses where id = ${data.warehouseId} and is_active = true`;
      if (!wh[0]) throw new Error("仓库不存在或已停用");
      const rows = await tx`
        select * from stock_lots
        where id = ${data.lotId} and deleted_at is null and status = 'in_transit' and qty_remaining >= ${data.qty}
        for update
      `;
      const lot = rows[0];
      if (!lot) throw new Error("在途记录不存在、已接收或数量不足");
      const next = Number(lot.qty_remaining) - data.qty;
      const updated = await tx`
        update stock_lots set qty_remaining = ${next}, status = ${next === 0 ? "closed" : "in_transit"}
        where id = ${data.lotId} and status = 'in_transit' and qty_remaining >= ${data.qty}
        returning id
      `;
      if (!updated[0]) throw new Error("在途已被其他操作改变，请刷新后重试");
      const newId = nid();
      await tx`
        insert into stock_lots (
          id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
          standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, inbound_at,
          source_lot_id, origin_lot_id
        ) values (
          ${newId}, ${lot.part_id}, ${data.warehouseId}, 'on_hand', ${data.qty}, ${data.qty}, ${lot.date_code ?? null},
          ${lot.package ?? null}, ${lot.standard_pack ?? null}, ${lot.pack_state ?? null}, ${lot.cost_amount ?? null},
          ${lot.cost_currency ?? null}, ${lot.cost_tax ?? null}, ${lot.supplier_id ?? null}, now(),
          ${data.lotId}, ${String(lot.origin_lot_id || lot.id)}
        )
      `;
      await tx`
        insert into stock_movements (id, part_id, lot_id, source_lot_id, type, qty, to_warehouse_id, note)
        values (${nid()}, ${lot.part_id}, ${newId}, ${data.lotId}, 'transit_in', ${data.qty}, ${data.warehouseId}, ${"途→仓"})
      `;
      await logOp(tx, "transit_in", "lot", data.lotId, data.warehouseId);
      return { ok: true as const, partId: String(lot.part_id), destinationLotId: newId };
    });
  });

export const stockMeta = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(async ({ context }) => {
  requireRole(await getCurrentPrincipal(context.bearerToken), "stock.read");
  const sql = await sqlClient();
  await ensureSeed(sql);
  const warehouses = await listWarehouses(sql);
  const channels = await sql`select id, name from channels where is_active = true order by name`;
  const settings = await getSettings(sql);
  return {
    warehouses,
    channels: channels.map((r) => ({ id: String(r.id), name: String(r.name) })),
    settings,
  };
});

export { formatStockLine };
