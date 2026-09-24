import { createServerFn } from "@tanstack/react-start";
import { createHash } from "node:crypto";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  getCurrentPrincipal,
  potentialScopeFor,
  requireRole,
} from "@/lib/auth/authorization.server";
import type { AppPrincipal } from "@/lib/auth/authorization.server";
import { ensureSeed } from "./seed";
import { ensurePart, getSettings, mapPart, matchFlagsForParts, sqlClient } from "./helpers";
import { displayMpn, formatInventoryQty, formatStockLine, iso, normalizeMpn } from "@/lib/domain";
import { cleanBrand } from "./part-identity";
import { listAnalysisTimes, moveAnalysisKeyPreservingTargetWithSql } from "./analysis-db";
import { withTransaction, logOp } from "./helpers";
import type { Sql } from "@/lib/db";
import type { MatchFlags, Part } from "@/lib/types";

export type PartListItem = Part & {
  flags: MatchFlags;
  /** 型号库只展示有效在库批次的总数量；仓位/批次明细在型号详情中展示。 */
  onHandLabel: string;
  /** 最近型号分析时间（part_analyses），无则 null。 */
  analysisAt: string | null;
};

export type PartIdentityImpactCounts = {
  stockLots: number | null;
  stockMovements: number | null;
  channelOffers: number | null;
  customerInquiries: number | null;
  potentialModels: number | null;
  legacyWatchlist: number | null;
};

export type PartIdentityCorrectionPreview = {
  currentMpn: string;
  targetMpn: string;
  targetPartId: string | null;
  counts: PartIdentityImpactCounts;
  sourceAnalysisExists: boolean;
  targetAnalysisExists: boolean;
  revision: string;
};

type PartIdentityCorrectionState = Omit<PartIdentityCorrectionPreview, "revision"> & {
  currentKey: string;
  currentUpdatedAt: string;
};

function partIdentityCorrectionRevision(state: PartIdentityCorrectionState): string {
  return createHash("sha256")
    .update(JSON.stringify(state))
    .digest("base64url");
}

async function countPartIdentityImpact(
  sql: Sql,
  partId: string,
  principal: AppPrincipal,
): Promise<PartIdentityImpactCounts> {
  const canReadStock = principal.permissions.includes("stock.read");
  const canReadMarket = principal.permissions.includes("market.read");
  const potentialScope = potentialScopeFor(principal);
  const rows = await sql.query<Record<string, unknown>>(
    `select
      case when $2::boolean then
        (select count(*)::int from stock_lots where part_id = $1 and deleted_at is null)
      end as stock_lots,
      case when $2::boolean then
        (select count(*)::int from stock_movements where part_id = $1 and deleted_at is null)
      end as stock_movements,
      case when $3::boolean then
        (select count(*)::int from channel_offers where part_id = $1 and deleted_at is null)
      end as channel_offers,
      case when $3::boolean then
        (select count(*)::int from customer_inquiries where part_id = $1 and deleted_at is null)
      end as customer_inquiries,
      case
        when $4::text = 'all' then
          (select count(*)::int from potential_models where part_id = $1)
        when $4::text = 'own' then
          (select count(*)::int from potential_models where part_id = $1 and user_id = $5)
      end as potential_models,
      case when $4::text = 'all' then
        (select count(*)::int from watchlist where part_id = $1)
      end as legacy_watchlist`,
    [partId, canReadStock, canReadMarket, potentialScope, principal.userId],
  );
  const row = rows[0] ?? {};
  return {
    stockLots: row.stock_lots == null ? null : Number(row.stock_lots),
    stockMovements: row.stock_movements == null ? null : Number(row.stock_movements),
    channelOffers: row.channel_offers == null ? null : Number(row.channel_offers),
    customerInquiries: row.customer_inquiries == null ? null : Number(row.customer_inquiries),
    potentialModels: row.potential_models == null ? null : Number(row.potential_models),
    legacyWatchlist: row.legacy_watchlist == null ? null : Number(row.legacy_watchlist),
  };
}

async function readAnalysisPresence(sql: Sql, sourceKey: string, targetKey: string) {
  const rows = await sql.query<{
    source_analysis_exists: boolean;
    target_analysis_exists: boolean;
  }>(
    `select
      exists(select 1 from part_analyses where mpn_key = $1) as source_analysis_exists,
      exists(select 1 from part_analyses where mpn_key = $2) as target_analysis_exists`,
    [sourceKey, targetKey],
  );
  return {
    sourceAnalysisExists: Boolean(rows[0]?.source_analysis_exists),
    targetAnalysisExists: Boolean(rows[0]?.target_analysis_exists),
  };
}

export const bootstrap = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "model.read");
    const sql = await sqlClient();
    await ensureSeed(sql);
    return { ok: true as const };
  });

export const searchParts = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { q?: string; filter?: "all" | "stock" | "hit" | "watch" }) => input)
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "model.read");
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
    const analysisAt = await listAnalysisTimes();
    const flags = await matchFlagsForParts(
      sql,
      parts.map((p) => p.id),
      undefined,
      principal.userId,
      potentialScopeFor(principal),
    );
    let items: PartListItem[] = parts.map((p) => {
      const f = flags.get(p.id)!;
      return {
        ...p,
        flags: f,
        onHandLabel:
          f.onHand > 0
            ? formatInventoryQty(f.onHand)
            : f.inTransit > 0
              ? `途 ${formatInventoryQty(f.inTransit)}`
              : "",
        analysisAt: analysisAt[p.mpnKey] ?? null,
      };
    });
    if (data.filter === "stock") items = items.filter((i) => i.flags.stock || i.flags.transit);
    if (data.filter === "hit") items = items.filter((i) => i.flags.isHit);
    if (data.filter === "watch") items = items.filter((i) => i.flags.watch);
    return items;
  });

export const getPartDetail = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "model.read");
    const sql = await sqlClient();
    await ensureSeed(sql);
    const partRows = await sql`select * from parts where id = ${data.id} limit 1`;
    if (!partRows[0]) throw new Error("型号不存在");
    const part = mapPart(partRows[0]);
    const settings = await getSettings(sql);
    const flagsMap = await matchFlagsForParts(
      sql,
      [part.id],
      settings,
      principal.userId,
      potentialScopeFor(principal),
    );
    const flags = flagsMap.get(part.id)!;

    const canReadStock = principal.permissions.includes("stock.read");
    const lots = !canReadStock
      ? []
      : await sql`
      select l.*, w.code as wh_code, ch.name as supplier_name
      from stock_lots l
      left join warehouses w on w.id = l.warehouse_id
      left join channels ch on ch.id = l.supplier_id
      where l.part_id = ${part.id} and l.deleted_at is null
        and (l.qty_remaining > 0 or l.status = 'in_transit')
      order by l.status asc, l.inbound_at desc
    `;
    const movements = !canReadStock
      ? []
      : await sql`
      select m.*, wf.code as from_code, wt.code as to_code
      from stock_movements m
      left join warehouses wf on wf.id = m.from_warehouse_id
      left join warehouses wt on wt.id = m.to_warehouse_id
      where m.part_id = ${part.id} and m.deleted_at is null
      order by m.happened_at desc
      limit 80
    `;
    const offers = !principal.permissions.includes("market.read")
      ? []
      : await sql`
      select o.*, ch.name as channel_name, ch.is_active as channel_active
      from channel_offers o
      join channels ch on ch.id = o.channel_id
      where o.part_id = ${part.id} and o.deleted_at is null
      order by o.is_valid desc, o.offered_at desc
    `;
    const inquiries = !principal.permissions.includes("market.read")
      ? []
      : await sql`
      select i.*, c.name as customer_name, c.is_active as customer_active
      from customer_inquiries i
      join customers c on c.id = i.customer_id
      where i.part_id = ${part.id} and i.deleted_at is null
      order by i.is_valid desc, i.inquired_at desc
    `;
    const watched = principal.permissions.includes("potential.read")
      ? await sql`select 1 from potential_models where user_id = ${principal.userId} and part_id = ${part.id} limit 1`
      : [];

    const publicFlags = canReadStock
      ? flags
      : {
          ...flags,
          onHand: 0,
          byWarehouse: [],
          inTransit: 0,
          transitEtaLabel: null,
          stock: false,
          transit: false,
        };
    return {
      part,
      flags: publicFlags,
      stockLine: canReadStock
        ? formatStockLine(flags.byWarehouse, flags.inTransit, flags.transitEtaLabel)
        : "",
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
          "in" | "out" | "transfer" | "adjust" | "transit_open" | "transit_in",
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
        tpAmount: r.tp_amount != null ? Number(r.tp_amount) : null,
        tpCurrency: (r.tp_currency as "USD" | "CNY") ?? null,
        inquiredAt: iso(r.inquired_at),
        isValid: Boolean(r.is_valid),
        invalidatedAt: r.invalidated_at ? iso(r.invalidated_at) : null,
      })),
    };
  });

export const createPart = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { mpn: string; brand?: string; category?: string; package?: string }) => input)
  .handler(async ({ data, context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "model.write");
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

export const previewPartIdentityCorrection = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; mpn: string }) => input)
  .handler(async ({ data, context }): Promise<PartIdentityCorrectionPreview> => {
    const principal = requireRole(
      await getCurrentPrincipal(context.bearerToken),
      "model.write",
    );
    const sql = await sqlClient();
    const targetMpn = displayMpn(data.mpn ?? "");
    if (!targetMpn) throw new Error("型号不能为空");
    const targetKey = normalizeMpn(targetMpn);

    const current = await sql.query<{
      mpn: string;
      mpn_key: string;
      updated_at_token: string;
    }>(
      "select mpn, mpn_key, updated_at::text as updated_at_token from parts where id = $1 limit 1",
      [data.id],
    );
    if (!current[0]) throw new Error("型号不存在");
    const target = await sql.query<{ id: string }>(
      "select id from parts where mpn_key = $1 and id <> $2 limit 1",
      [targetKey, data.id],
    );
    const [counts, analysisPresence] = await Promise.all([
      countPartIdentityImpact(sql, data.id, principal),
      readAnalysisPresence(sql, current[0].mpn_key, targetKey),
    ]);

    const state: PartIdentityCorrectionState = {
      currentMpn: current[0].mpn,
      currentKey: current[0].mpn_key,
      currentUpdatedAt: current[0].updated_at_token,
      targetMpn,
      targetPartId: target[0]?.id ?? null,
      counts,
      ...analysisPresence,
    };
    return {
      currentMpn: state.currentMpn,
      targetMpn: state.targetMpn,
      targetPartId: state.targetPartId,
      counts: state.counts,
      sourceAnalysisExists: state.sourceAnalysisExists,
      targetAnalysisExists: state.targetAnalysisExists,
      revision: partIdentityCorrectionRevision(state),
    };
  });

/**
 * 修正型号主档（录入/识别错误时的人工修正入口）。
 * - 主档唯一：新 mpn_key 与其它主档冲突时报错；本档 partId 不变，
 *   库存/渠道/询价/流水等历史事件全部保留。
 * - 可选字段（category/package/description/params）用于带入分析结果，
 *   只覆盖旧值为空或显式传入的列；brand 经 cleanBrand 归一。
 * - 目标 key 没有分析时迁移旧分析；目标已有分析时保留双方记录。
 */
export const updatePartIdentity = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      id: string;
      mpn: string;
      brand?: string;
      category?: string;
      package?: string;
      description?: string;
      params?: string;
      reason: string;
      previewRevision: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "model.write");
    const sql = await sqlClient();
    const mpn = displayMpn(data.mpn ?? "");
    if (!mpn) throw new Error("型号不能为空");
    const key = normalizeMpn(data.mpn);
    const id = data.id;
    const reason = typeof data.reason === "string" ? data.reason.trim() : "";
    if (!reason) throw new Error("修正原因不能为空");
    const previewRevision =
      typeof data.previewRevision === "string" ? data.previewRevision.trim() : "";
    if (!previewRevision) throw new Error("请先检查影响，再确认修正");

    const brand = data.brand ? cleanBrand(data.brand) : null;
    const result = await withTransaction(sql, async (tx) => {
      const before = await tx`
        select *, updated_at::text as updated_at_token
        from parts where id = ${id} for update
      `;
      if (!before[0]) throw new Error("型号不存在");
      const clash = await tx`
        select id from parts where mpn_key = ${key} and id <> ${id} limit 1 for update
      `;
      if (clash[0]) throw new Error("同型号已存在于另一主档，请直接使用该档");
      const counts = await countPartIdentityImpact(tx, id, principal);
      const analysisPresence = await readAnalysisPresence(
        tx,
        String(before[0].mpn_key),
        key,
      );
      const currentRevision = partIdentityCorrectionRevision({
        currentMpn: String(before[0].mpn),
        currentKey: String(before[0].mpn_key),
        currentUpdatedAt: String(before[0].updated_at_token),
        targetMpn: mpn,
        targetPartId: null,
        counts,
        ...analysisPresence,
      });
      if (currentRevision !== previewRevision) {
        throw new Error("型号资料已变化，请重新检查影响后再确认");
      }
      const updated = await tx`
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
        returning *
      `;
      const analysisAction = await moveAnalysisKeyPreservingTargetWithSql(
        tx,
        String(before[0].mpn_key),
        mpn,
      );
      await logOp(tx, "correct", "part", id, {
        principal,
        detail: reason,
        before: before[0],
        after: { ...updated[0], impact: counts, analysisAction },
      });
      return { counts, analysisAction };
    });
    return { ok: true as const, impact: result.counts, analysisAction: result.analysisAction };
  });
