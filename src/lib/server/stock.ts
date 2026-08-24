import { createServerFn } from "@tanstack/react-start";
import { formatStockLine, iso, parseLeadTime } from "@/lib/domain";
import type { CostTax, Currency, PackState } from "@/lib/types";
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
} from "./helpers";
import { ensureSeed } from "./seed";

type LotRow = Record<string, unknown>;

async function consumeLots(
  sql: Awaited<ReturnType<typeof sqlClient>>,
  partId: string,
  warehouseId: string,
  qty: number,
): Promise<{ lot: LotRow; take: number }[]> {
  if (qty <= 0) throw new Error("数量必须大于 0");
  const lots = await sql`
    select * from stock_lots
    where part_id = ${partId}
      and warehouse_id = ${warehouseId}
      and status = 'on_hand'
      and deleted_at is null
      and qty_remaining > 0
    order by inbound_at asc, id asc
  `;
  let left = qty;
  const used: { lot: LotRow; take: number }[] = [];
  for (const lot of lots) {
    if (left <= 0) break;
    const remain = Number(lot.qty_remaining);
    const take = Math.min(remain, left);
    const next = remain - take;
    await sql`
      update stock_lots
      set qty_remaining = ${next}, status = ${next === 0 ? "closed" : "on_hand"}
      where id = ${lot.id}
    `;
    used.push({ lot, take });
    left -= take;
  }
  if (left > 0) throw new Error("库存不足，无法出库/调拨");
  return used;
}

export const listStock = createServerFn({ method: "GET" })
  .validator((input: { warehouseId?: string; q?: string } | undefined) => input ?? {})
  .handler(async ({ data }) => {
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
    const flags = await matchFlagsForParts(sql, partIds);
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
      supplierName: r.supplier_name ? String(r.supplier_name) : null,
      inboundAt: iso(r.inbound_at),
      etaDate: r.eta_date ? String(r.eta_date) : null,
      etaText: r.eta_text ? String(r.eta_text) : null,
      etaPrecision: r.eta_precision ? String(r.eta_precision) : null,
      flags: flags.get(String(r.part_id)) ?? null,
    }));
    if (data.warehouseId === "transit") {
      items = items.filter((i) => i.status === "in_transit");
    } else if (data.warehouseId) {
      items = items.filter((i) => i.warehouseId === data.warehouseId);
    }
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
    };
    return { warehouses, items, summary };
  });

export const stockInbound = createServerFn({ method: "POST" })
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
  .handler(async ({ data }) => {
    if (data.qty <= 0) throw new Error("数量必须大于 0");
    const sql = await sqlClient();
    const part = await ensurePart(sql, data.mpn, { package: data.package, source: "入库" });
    const supplier = data.supplier ? await ensureChannel(sql, data.supplier) : null;
    const id = nid();
    await sql`
      insert into stock_lots (
        id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
        standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id
      ) values (
        ${id}, ${part.id}, ${data.warehouseId}, 'on_hand', ${data.qty}, ${data.qty},
        ${data.dateCode ?? null}, ${data.package ?? null}, ${data.standardPack ?? null},
        ${data.packState ?? null}, ${data.costAmount ?? null}, ${data.costCurrency ?? null},
        ${data.costTax ?? null}, ${supplier?.id ?? null}
      )
    `;
    await sql`
      insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id)
      values (${nid()}, ${part.id}, ${id}, 'in', ${data.qty}, ${data.warehouseId})
    `;
    await sql`update parts set updated_at = now() where id = ${part.id}`;
    return { id, partId: part.id };
  });

export const stockOutbound = createServerFn({ method: "POST" })
  .validator((input: { partId: string; warehouseId: string; qty: number; note?: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const used = await consumeLots(sql, data.partId, data.warehouseId, data.qty);
    for (const u of used) {
      await sql`
        insert into stock_movements (id, part_id, lot_id, type, qty, from_warehouse_id, note)
        values (${nid()}, ${data.partId}, ${u.lot.id}, 'out', ${u.take}, ${data.warehouseId}, ${data.note ?? null})
      `;
    }
    await sql`update parts set updated_at = now() where id = ${data.partId}`;
    return { ok: true as const };
  });

export const stockTransfer = createServerFn({ method: "POST" })
  .validator(
    (input: { partId: string; fromWarehouseId: string; toWarehouseId: string; qty: number }) =>
      input,
  )
  .handler(async ({ data }) => {
    if (data.fromWarehouseId === data.toWarehouseId) throw new Error("调拨仓库不能相同");
    const sql = await sqlClient();
    const used = await consumeLots(sql, data.partId, data.fromWarehouseId, data.qty);
    for (const u of used) {
      const newId = nid();
      const lot = u.lot;
      await sql`
        insert into stock_lots (
          id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
          standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, inbound_at
        ) values (
          ${newId}, ${data.partId}, ${data.toWarehouseId}, 'on_hand', ${u.take}, ${u.take},
          ${lot.date_code ?? null}, ${lot.package ?? null}, ${lot.standard_pack ?? null},
          ${lot.pack_state ?? null}, ${lot.cost_amount ?? null}, ${lot.cost_currency ?? null},
          ${lot.cost_tax ?? null}, ${lot.supplier_id ?? null}, ${lot.inbound_at}
        )
      `;
      await sql`
        insert into stock_movements (id, part_id, lot_id, type, qty, from_warehouse_id, to_warehouse_id)
        values (${nid()}, ${data.partId}, ${newId}, 'transfer', ${u.take}, ${data.fromWarehouseId}, ${data.toWarehouseId})
      `;
    }
    await sql`update parts set updated_at = now() where id = ${data.partId}`;
    return { ok: true as const };
  });

export const stockAdjust = createServerFn({ method: "POST" })
  .validator((input: { partId: string; warehouseId: string; qtyDelta: number; note?: string }) => input)
  .handler(async ({ data }) => {
    if (data.qtyDelta === 0) throw new Error("调整数量不能为 0");
    const sql = await sqlClient();
    if (data.qtyDelta > 0) {
      const id = nid();
      await sql`
        insert into stock_lots (
          id, part_id, warehouse_id, status, qty_in, qty_remaining
        ) values (${id}, ${data.partId}, ${data.warehouseId}, 'on_hand', ${data.qtyDelta}, ${data.qtyDelta})
      `;
      await sql`
        insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id, note)
        values (${nid()}, ${data.partId}, ${id}, 'adjust', ${data.qtyDelta}, ${data.warehouseId}, ${data.note ?? "盘点"})
      `;
    } else {
      const used = await consumeLots(sql, data.partId, data.warehouseId, -data.qtyDelta);
      for (const u of used) {
        await sql`
          insert into stock_movements (id, part_id, lot_id, type, qty, from_warehouse_id, note)
          values (${nid()}, ${data.partId}, ${u.lot.id}, 'adjust', ${u.take}, ${data.warehouseId}, ${data.note ?? "盘点"})
        `;
      }
    }
    await logOp(sql, "adjust", "part", data.partId, String(data.qtyDelta));
    await sql`update parts set updated_at = now() where id = ${data.partId}`;
    return { ok: true as const };
  });

export const openTransit = createServerFn({ method: "POST" })
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
  .handler(async ({ data }) => {
    if (data.qty <= 0) throw new Error("数量必须大于 0");
    const sql = await sqlClient();
    const part = await ensurePart(sql, data.mpn, { source: "在途" });
    const supplier = data.supplier ? await ensureChannel(sql, data.supplier) : null;
    const parsed = data.etaText ? parseLeadTime(data.etaText) : null;
    const id = nid();
    await sql`
      insert into stock_lots (
        id, part_id, status, qty_in, qty_remaining, date_code,
        cost_amount, cost_currency, cost_tax, supplier_id, ordered_at, eta_date, eta_text, eta_precision
      ) values (
        ${id}, ${part.id}, 'in_transit', ${data.qty}, ${data.qty}, ${data.dateCode ?? null},
        ${data.costAmount ?? null}, ${data.costCurrency ?? null}, ${data.costTax ?? null},
        ${supplier?.id ?? null}, now(), ${parsed?.etaDate ?? null}, ${parsed?.original ?? data.etaText ?? null},
        ${parsed?.precision ?? null}
      )
    `;
    await sql`
      insert into stock_movements (id, part_id, lot_id, type, qty, note)
      values (${nid()}, ${part.id}, ${id}, 'transit_open', ${data.qty}, ${data.etaText ?? null})
    `;
    return { id, partId: part.id };
  });

export const receiveTransit = createServerFn({ method: "POST" })
  .validator((input: { lotId: string; warehouseId: string; qty: number }) => input)
  .handler(async ({ data }) => {
    if (data.qty <= 0) throw new Error("数量必须大于 0");
    const sql = await sqlClient();
    const lots = await sql`select * from stock_lots where id = ${data.lotId} and deleted_at is null`;
    const lot = lots[0];
    if (!lot) throw new Error("在途记录不存在");
    if (lot.status !== "in_transit") throw new Error("该批次不是在途");
    const remain = Number(lot.qty_remaining);
    if (data.qty > remain) throw new Error("接收数量超过在途剩余");
    const next = remain - data.qty;
    await sql`
      update stock_lots
      set qty_remaining = ${next}, status = ${next === 0 ? "closed" : "in_transit"}
      where id = ${lot.id}
    `;
    const newId = nid();
    await sql`
      insert into stock_lots (
        id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
        standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, inbound_at
      ) values (
        ${newId}, ${lot.part_id}, ${data.warehouseId}, 'on_hand', ${data.qty}, ${data.qty},
        ${lot.date_code ?? null}, ${lot.package ?? null}, ${lot.standard_pack ?? null},
        ${lot.pack_state ?? null}, ${lot.cost_amount ?? null}, ${lot.cost_currency ?? null},
        ${lot.cost_tax ?? null}, ${lot.supplier_id ?? null}, now()
      )
    `;
    await sql`
      insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id, note)
      values (${nid()}, ${lot.part_id}, ${newId}, 'transit_in', ${data.qty}, ${data.warehouseId}, ${"途→仓 敞口不变"})
    `;
    await logOp(sql, "transit_in", "lot", String(lot.id), data.warehouseId);
    return { ok: true as const, partId: String(lot.part_id) };
  });

export const stockMeta = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await ensureSeed(sql);
  const warehouses = await listWarehouses(sql);
  const settings = await getSettings(sql);
  return { warehouses, settings };
});

export { formatStockLine };

