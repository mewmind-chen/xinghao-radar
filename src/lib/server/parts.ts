import { createServerFn } from "@tanstack/react-start";
import { ensureSeed } from "./seed";
import {
  ensurePart,
  getSettings,
  mapPart,
  matchFlagsForParts,
  sqlClient,
} from "./helpers";
import { displayMpn, formatStockLine, iso, normalizeMpn } from "@/lib/domain";
import { cleanBrand } from "./part-identity";
import { listAnalysisTimes, moveAnalysisKey } from "./analysis-db";
import type { MatchFlags, Part } from "@/lib/types";

export type PartListItem = Part & {
  flags: MatchFlags;
  stockLine: string;
  /** 最近型号分析时间（part_analyses），无则 null。 */
  analysisAt: string | null;
};

export const bootstrap = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await ensureSeed(sql);
  return { ok: true as const };
});

export const searchParts = createServerFn({ method: "GET" })
  .validator((input: { q?: string; filter?: "all" | "stock" | "hit" | "watch" }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await ensureSeed(sql);
    const q = (data.q ?? "").trim();
    let rows: Record<string, unknown>[];
    if (q) {
      const like = `%${q}%`;
      const key = `%${q.normalize("NFKC").trim().toUpperCase()}%`;
      rows = await sql`
        select * from parts
        where mpn_key like ${key} or mpn ilike ${like} or coalesce(brand_code,'') ilike ${like}
          or coalesce(category,'') ilike ${like}
        order by mpn
        limit 200
      `;
    } else {
      rows = await sql`select * from parts order by updated_at desc, mpn limit 200`;
    }
    const parts = rows.map(mapPart);
    const analysisAt = listAnalysisTimes();
    const flags = await matchFlagsForParts(
      sql,
      parts.map((p) => p.id),
    );
    let items: PartListItem[] = parts.map((p) => {
      const f = flags.get(p.id)!;
      return {
        ...p,
        flags: f,
        stockLine: formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel),
        analysisAt: analysisAt[p.mpnKey] ?? null,
      };
    });
    if (data.filter === "stock") items = items.filter((i) => i.flags.stock || i.flags.transit);
    if (data.filter === "hit") items = items.filter((i) => i.flags.isHit);
    if (data.filter === "watch") items = items.filter((i) => i.flags.watch);
    return items;
  });

export const getPartDetail = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await ensureSeed(sql);
    const partRows = await sql`select * from parts where id = ${data.id} limit 1`;
    if (!partRows[0]) throw new Error("型号不存在");
    const part = mapPart(partRows[0]);
    const settings = await getSettings(sql);
    const flagsMap = await matchFlagsForParts(sql, [part.id], settings);
    const flags = flagsMap.get(part.id)!;

    const lots = await sql`
      select l.*, w.code as wh_code, ch.name as supplier_name
      from stock_lots l
      left join warehouses w on w.id = l.warehouse_id
      left join channels ch on ch.id = l.supplier_id
      where l.part_id = ${part.id} and l.deleted_at is null
        and (l.qty_remaining > 0 or l.status = 'in_transit')
      order by l.status asc, l.inbound_at desc
    `;
    const movements = await sql`
      select m.*, wf.code as from_code, wt.code as to_code
      from stock_movements m
      left join warehouses wf on wf.id = m.from_warehouse_id
      left join warehouses wt on wt.id = m.to_warehouse_id
      where m.part_id = ${part.id} and m.deleted_at is null
      order by m.happened_at desc
      limit 80
    `;
    const offers = await sql`
      select o.*, ch.name as channel_name, ch.is_active as channel_active
      from channel_offers o
      join channels ch on ch.id = o.channel_id
      where o.part_id = ${part.id} and o.deleted_at is null
      order by o.is_valid desc, o.offered_at desc
    `;
    const inquiries = await sql`
      select i.*, c.name as customer_name, c.is_active as customer_active
      from customer_inquiries i
      join customers c on c.id = i.customer_id
      where i.part_id = ${part.id} and i.deleted_at is null
      order by i.is_valid desc, i.inquired_at desc
    `;
    const watched = await sql`select 1 from watchlist where part_id = ${part.id} limit 1`;

    return {
      part,
      flags,
      stockLine: formatStockLine(flags.byWarehouse, flags.inTransit, flags.transitEtaLabel),
      watched: watched.length > 0,
      settings,
      lots: lots.map((r) => ({
        id: String(r.id),
        partId: String(r.part_id),
        warehouseId: r.warehouse_id ? String(r.warehouse_id) : null,
        warehouseCode: r.wh_code ? String(r.wh_code) : null,
        status: r.status as "on_hand" | "in_transit" | "closed",
        qtyIn: Number(r.qty_in),
        qtyRemaining: Number(r.qty_remaining),
        dateCode: r.date_code ? String(r.date_code) : null,
        package: r.package ? String(r.package) : null,
        standardPack: r.standard_pack ? String(r.standard_pack) : null,
        packState: (r.pack_state as "full" | "loose" | "mixed") ?? null,
        costAmount: r.cost_amount != null ? Number(r.cost_amount) : null,
        costCurrency: (r.cost_currency as "USD" | "CNY") ?? null,
        costTax: (r.cost_tax as "none" | "exclusive" | "inclusive") ?? null,
        supplierId: r.supplier_id ? String(r.supplier_id) : null,
        supplierName: r.supplier_name ? String(r.supplier_name) : null,
        inboundAt: iso(r.inbound_at),
        orderedAt: r.ordered_at ? String(r.ordered_at) : null,
        etaDate: r.eta_date ? String(r.eta_date) : null,
        etaText: r.eta_text ? String(r.eta_text) : null,
        etaPrecision: (r.eta_precision as "date" | "week" | "month" | "fuzzy" | "stock") ?? null,
      })),
      movements: movements.map((r) => ({
        id: String(r.id),
        partId: String(r.part_id),
        lotId: r.lot_id ? String(r.lot_id) : null,
        type: String(r.type) as
          | "in"
          | "out"
          | "transfer"
          | "adjust"
          | "transit_open"
          | "transit_in",
        qty: Number(r.qty),
        fromWarehouseId: r.from_warehouse_id ? String(r.from_warehouse_id) : null,
        fromWarehouseCode: r.from_code ? String(r.from_code) : null,
        toWarehouseId: r.to_warehouse_id ? String(r.to_warehouse_id) : null,
        toWarehouseCode: r.to_code ? String(r.to_code) : null,
        happenedAt: iso(r.happened_at),
        note: r.note ? String(r.note) : null,
      })),
      offers: offers.map((r) => ({
        id: String(r.id),
        channelId: String(r.channel_id),
        channelName: String(r.channel_name),
        channelActive: Boolean(r.channel_active),
        partId: String(r.part_id),
        mpn: part.mpn,
        brandCode: part.brandCode,
        qty: r.qty != null ? Number(r.qty) : null,
        dateCode: r.date_code ? String(r.date_code) : null,
        priceAmount: r.price_amount != null ? Number(r.price_amount) : null,
        priceCurrency: (r.price_currency as "USD" | "CNY") ?? null,
        priceTax: (r.price_tax as "none" | "exclusive" | "inclusive") ?? null,
        isTp: Boolean(r.is_tp),
        leadTimeText: r.lead_time_text ? String(r.lead_time_text) : null,
        offeredAt: iso(r.offered_at),
        isValid: Boolean(r.is_valid),
        invalidatedAt: r.invalidated_at ? iso(r.invalidated_at) : null,
      })),
      inquiries: inquiries.map((r) => ({
        id: String(r.id),
        customerId: String(r.customer_id),
        customerName: String(r.customer_name),
        customerActive: Boolean(r.customer_active),
        partId: String(r.part_id),
        mpn: part.mpn,
        brandCode: part.brandCode,
        qty: r.qty != null ? Number(r.qty) : null,
        inquiredAt: iso(r.inquired_at),
        isValid: Boolean(r.is_valid),
        invalidatedAt: r.invalidated_at ? iso(r.invalidated_at) : null,
      })),
    };
  });

export const createPart = createServerFn({ method: "POST" })
  .validator((input: { mpn: string; brand?: string; category?: string; package?: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const part = await ensurePart(sql, data.mpn, {
      brand: data.brand,
      package: data.package,
      source: "手工",
    });
    if (data.category) {
      await sql`update parts set category = ${data.category}, updated_at = now() where id = ${part.id}`;
    }
    return part;
  });

/**
 * 修正型号主档（录入/识别错误时的人工修正入口）。
 * - 主档唯一：新 mpn_key 与其它主档冲突时报错；本档 partId 不变，
 *   库存/渠道/询价/流水等历史事件全部保留。
 * - 可选字段（category/package/description/params）用于带入分析结果，
 *   只覆盖旧值为空或显式传入的列；brand 经 cleanBrand 归一。
 * - 已保存的型号分析记录随新 key 迁移（保留时间戳）。
 */
export const updatePartIdentity = createServerFn({ method: "POST" })
  .validator(
    (input: {
      id: string;
      mpn: string;
      brand?: string;
      category?: string;
      package?: string;
      description?: string;
      params?: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const mpn = displayMpn(data.mpn ?? "");
    if (!mpn) throw new Error("型号不能为空");
    const key = normalizeMpn(data.mpn);
    const id = data.id;
    const current = await sql`select mpn, mpn_key from parts where id = ${id} limit 1`;
    if (!current[0]) throw new Error("型号不存在");
    const oldKey = String(current[0].mpn_key);

    const clash = await sql`
      select id from parts where mpn_key = ${key} and id <> ${id} limit 1
    `;
    if (clash[0]) throw new Error("同型号已存在于另一主档，请直接使用该档");

    const brand = data.brand ? cleanBrand(data.brand) : null;
    await sql`
      update parts set
        mpn = ${mpn},
        mpn_key = ${key},
        brand_code = coalesce(${brand}, brand_code),
        category = coalesce(${data.category ?? null}, category),
        package = coalesce(${data.package ?? null}, package),
        description = coalesce(${data.description ?? null}, description),
        params = coalesce(${data.params ?? null}, params),
        updated_at = now()
      where id = ${id}
    `;
    moveAnalysisKey(oldKey, mpn);
    return { ok: true as const };
  });
