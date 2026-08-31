/**
 * Import Service —— 预览数据组装 / 重复检测 / 确认写库。
 *
 * 抽取决策在 import-contract：受信内部模板 / 受控文本走确定性 parser；
 * 无界表格与聊天文本走 Platform。needsAgent + 空 candidates 不是失败，
 * 禁止因此用 headerKey / heuristic 冒充成功。confirmImport 仍是唯一写库入口。
 */

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getCurrentPrincipal, potentialScopeFor, requireImportKind } from "@/lib/auth/authorization.server";
import {
  DUPLICATE_INQUIRY_HOURS,
  DUPLICATE_OFFER_HOURS,
  correctTradeText,
  formatStockLine,
  isCrossHit,
  normalizeMpn,
  parseLeadTime,
} from "@/lib/domain";
import type { ImportKind, ImportRow, ImportSource } from "@/lib/types";
import type { CostTax, Currency } from "@/lib/types";
import {
  defaultProviders,
  runImportAgent,
} from "@harness/index";
import { parseCsv } from "@harness/plugins/csv-parser";
import { parseExcel } from "@harness/plugins/excel-parser";
import { resolveImportExtract } from "./import-contract";
import {
  ensureChannel,
  ensureCustomer,
  ensurePart,
  listWarehouses,
  matchFlagsForParts,
  nid,
  sqlClient,
  withTransaction,
} from "./helpers";
import { ensureSeed } from "./seed";

function effectiveImportKind(row: ImportRow, selectedKind: ImportKind): ImportKind {
  if (selectedKind === "stock") return "stock";
  return row.kind === "mixed" ? selectedKind : row.kind;
}

const DUPLICATE_STOCK_DAYS = 90;

function flagIntraFileDuplicates(
  rows: ImportRow[],
  selectedKind: ImportKind,
  defaults?: { warehouseId?: string; supplier?: string },
) {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const k = [
      effectiveImportKind(row, selectedKind),
      normalizeMpn(row.mpn),
      row.qty ?? "",
      row.dateCode ?? "",
      row.channel ?? defaults?.supplier ?? "",
      row.customer ?? "",
      row.warehouse ?? defaults?.warehouseId ?? "",
      row.isTp ? "tp" : (row.priceAmount ?? ""),
    ].join("|");
    if (seen.has(k)) {
      row.duplicate = true;
      row.duplicateReason = "本表内重复行";
      row.selected = false;
    } else {
      seen.set(k, 1);
    }
  }
}

async function markDuplicates(
  sql: Awaited<ReturnType<typeof sqlClient>>,
  rows: ImportRow[],
  selectedKind: ImportKind,
  defaultWarehouseId?: string,
  defaultSupplier?: string,
) {
  flagIntraFileDuplicates(rows, selectedKind, { warehouseId: defaultWarehouseId, supplier: defaultSupplier });
  for (const row of rows) {
    if (row.duplicate) continue;
    const key = normalizeMpn(row.mpn);
    const part = await sql`select id from parts where mpn_key = ${key} limit 1`;
    if (!part[0]) continue;
    const partId = String(part[0].id);
    const kind = effectiveImportKind(row, selectedKind);
    if (kind === "stock") {
      const warehouse = row.warehouse ?? defaultWarehouseId ?? "";
      const supplierName = row.channel ?? defaultSupplier ?? "";
      const cost = row.costAmount;
      const currency = row.costCurrency;
      const tax = row.costTax;
      const hits = await sql`
        select l.id
        from stock_lots l
        left join warehouses w on w.id = l.warehouse_id
        left join channels ch on ch.id = l.supplier_id
        where l.part_id = ${partId} and l.deleted_at is null
          and l.status in ('on_hand', 'in_transit')
          and l.inbound_at >= now() - (${DUPLICATE_STOCK_DAYS} || ' days')::interval
          and coalesce(l.qty_in, 0) = coalesce(${row.qty}, 0)
          and coalesce(l.date_code, '') = coalesce(${row.dateCode ?? ""}, '')
          and coalesce(l.cost_amount, -1::numeric) = coalesce(${cost ?? null}::numeric, -1::numeric)
          and coalesce(l.cost_currency, '') = coalesce(${currency ?? ""}, '')
          and coalesce(l.cost_tax, '') = coalesce(${tax ?? ""}, '')
          and (${warehouse} = '' or w.id = ${warehouse} or w.code = ${warehouse})
          and (${supplierName} = '' or ch.name = ${supplierName})
        limit 3
      `;
      if (hits.length > 0) {
        row.duplicate = true;
        row.duplicateReason = "疑似重复：相同型号、仓库、数量、DC 和成本已有库存批次（若确为新批次可勾选）";
        row.selected = false;
      }
    }
    if (kind === "offer") {
      const chName = row.channel ?? "";
      const hits = await sql`
        select o.id from channel_offers o
        join channels ch on ch.id = o.channel_id
        where o.part_id = ${partId} and o.deleted_at is null
          and o.offered_at >= now() - (${DUPLICATE_OFFER_HOURS} || ' hours')::interval
          and coalesce(o.qty, -1) = coalesce(${row.qty}, -1)
          and coalesce(o.date_code,'') = coalesce(${row.dateCode ?? ""}, '')
          and o.is_tp = ${row.isTp}
          -- price_amount is numeric; keep the NULL sentinel numeric as well.
          -- Otherwise PGlite/Postgres infer the parameter as integer from -1
          -- and reject valid decimal prices such as 1.32 during preview.
          and coalesce(o.price_amount, -1::numeric) = coalesce(${row.priceAmount ?? null}::numeric, -1::numeric)
          and (${chName} = '' or ch.name = ${chName})
        limit 3
      `;
      if (hits.length > 0) {
        row.duplicate = true;
        row.duplicateReason = `疑似重复：同渠道同型号近 ${DUPLICATE_OFFER_HOURS}h 已有推货`;
        row.selected = false;
      }
    }
    if (kind === "inquiry") {
      const cuName = row.customer ?? "";
      const hits = await sql`
        select i.id from customer_inquiries i
        join customers c on c.id = i.customer_id
        where i.part_id = ${partId} and i.deleted_at is null
          and i.inquired_at >= now() - (${DUPLICATE_INQUIRY_HOURS} || ' hours')::interval
          and coalesce(i.qty, -1) = coalesce(${row.qty}, -1)
          and (${cuName} = '' or c.name = ${cuName})
        limit 3
      `;
      if (hits.length > 0) {
        row.duplicate = true;
        row.duplicateReason = `疑似重复：同客户同型号近 ${DUPLICATE_INQUIRY_HOURS}h 已有询价（若确为再次询价可勾选）`;
        row.selected = false;
      }
    }
  }
}

export const parseImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      kind: ImportKind;
      sourceType: ImportSource;
      text?: string;
      filename?: string;
      fileBase64?: string;
      mime?: string;
      defaultWarehouseId?: string;
      defaultSupplier?: string;
      defaultCurrency?: Currency;
      defaultTax?: CostTax;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireImportKind(principal, data.kind);
    const sql = await sqlClient();
    await ensureSeed(sql);

    const { extractViaPlatform } = await import("./agent-platform");
    const resolved = await resolveImportExtract(
      {
        kind: data.kind,
        sourceType: data.sourceType,
        text: data.text ? correctTradeText(data.text) : undefined,
        fileBase64: data.fileBase64,
        mime: data.mime,
        filename: data.filename,
      },
      {
        readTable: async () => {
          try {
            if (data.sourceType === "excel" && data.fileBase64) {
              return await parseExcel(data.fileBase64);
            }
            if (data.sourceType === "csv") {
              const raw =
                (data.text ? correctTradeText(data.text) : undefined) ??
                (data.fileBase64 ? Buffer.from(data.fileBase64, "base64").toString("utf8") : "");
              return raw ? parseCsv(raw) : null;
            }
          } catch {
            return null;
          }
          return null;
        },
        extractViaPlatform,
        runLocalImageFallback: async () => {
          if (data.sourceType !== "image") return null;
          const providers = defaultProviders();
          const outcome = await runImportAgent(
            {
              sourceType: "image",
              kind: data.kind,
              fileBase64: data.fileBase64,
              mime: data.mime,
              filename: data.filename,
            },
            providers,
          );
          if (!outcome?.rows.length) return null;
          return { rows: outcome.rows, usedAi: outcome.usedAi };
        },
      },
    );

    const rows = resolved.rows.map((row) =>
      data.kind === "stock" ? { ...row, kind: "stock" as const } : row,
    );
    const usedAi = resolved.usedAi;
    const providers = defaultProviders();

    await markDuplicates(sql, rows, data.kind, data.defaultWarehouseId, data.defaultSupplier);
    const warehouses = await listWarehouses(sql);
    const channels = await sql`select id, name from channels order by name`;
    const customers = await sql`select id, name from customers order by name`;
    return {
      rows,
      usedAi,
      aiAvailable: providers.some((p) => p.available()),
      extractOrigin: resolved.extractOrigin,
      extractState: resolved.extractState,
      extractMessage: resolved.extractMessage,
      warehouses,
      channels: channels.map((r) => ({ id: String(r.id), name: String(r.name) })),
      customers: customers.map((r) => ({ id: String(r.id), name: String(r.name) })),
    };
  });

export const confirmImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      kind: ImportKind;
      sourceType: ImportSource;
      filename?: string;
      excerpt?: string;
      defaultChannel?: string;
      defaultCustomer?: string;
      defaultWarehouseId?: string;
      defaultSupplier?: string;
      defaultCurrency?: Currency;
      defaultTax?: CostTax;
      rows: ImportRow[];
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    const sql = await sqlClient();
    const selected = data.rows.filter((r) => r.selected && r.mpn);
    if (selected.length === 0) throw new Error("没有勾选可写入的行");
    for (const row of selected) requireImportKind(principal, effectiveImportKind(row, data.kind));
    const warehouses = await listWarehouses(sql);
    for (const row of selected) {
      const kind = effectiveImportKind(row, data.kind);
      if (kind === "offer" && !(row.channel || data.defaultChannel)) {
        throw new Error(`${row.mpn} 缺少渠道`);
      }
      if (kind === "inquiry" && !(row.customer || data.defaultCustomer)) {
        throw new Error(`${row.mpn} 缺少客户`);
      }
      // 数量必须为正整数：识别层偶发把价格当数量（如 $1.15 → 1.15），
      // 在写库前给出可理解的错误而非 Postgres integer 语法错。
      const requireIntQty = (qty: number | null, what: string): number => {
        const n = qty ?? 0;
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${row.mpn} ${what}数量无效`);
        if (!Number.isInteger(n)) {
          throw new Error(
            `${row.mpn} ${what}数量必须是整数：${n}（像价格被识别成了数量，请检查该行）`,
          );
        }
        return n;
      };
      if (kind === "offer") {
        if (row.qty != null && !Number.isInteger(row.qty)) {
          throw new Error(`${row.mpn} 推货数量必须是整数：${row.qty}（像价格被识别成了数量，请检查该行）`);
        }
      }
      if (kind === "inquiry") {
        if (row.qty != null && !Number.isInteger(row.qty)) {
          throw new Error(`${row.mpn} 询价数量必须是整数：${row.qty}（像价格被识别成了数量，请检查该行）`);
        }
      }
      if (kind === "stock") {
        const wh =
          warehouses.find((w) => w.code === row.warehouse) ??
          warehouses.find((w) => w.id === data.defaultWarehouseId);
        if (!wh) throw new Error(`${row.mpn} 缺少仓库`);
        requireIntQty(row.qty, "入库");
        const amount = row.costAmount;
        const currency = amount == null ? null : (row.costCurrency ?? data.defaultCurrency ?? null);
        const tax = amount == null ? null : (row.costTax ?? data.defaultTax ?? null);
        if (amount == null && (row.costCurrency != null || row.costTax != null)) {
          throw new Error(`${row.mpn} 成本为空时币种和税别必须为空`);
        }
        if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
          throw new Error(`${row.mpn} 成本必须为空或不小于 0`);
        }
        if (amount != null && !currency) throw new Error(`${row.mpn} 填写成本时必须选择币种`);
        if (amount != null && currency === "USD" && tax !== "none") throw new Error(`${row.mpn} 美元成本税别只能是无`);
        if (amount != null && currency === "CNY" && tax !== "exclusive" && tax !== "inclusive") {
          throw new Error(`${row.mpn} 人民币成本必须选择含税或未税`);
        }
      }
      if (kind === "transit") {
        requireIntQty(row.qty, "在途");
      }
    }

    return withTransaction(sql, async (tx) => {
      const batchId = nid();
      await tx`
      insert into import_batches (id, kind, source_type, filename, raw_excerpt, created_by)
      values (${batchId}, ${data.kind}, ${data.sourceType}, ${data.filename ?? null}, ${data.excerpt ?? null}, ${principal.userId})
      `;

      const partIds: string[] = [];
      for (const row of selected) {
        const part = await ensurePart(tx, row.mpn, {
        brand: row.brand,
        package: row.package,
        source: "导入",
        });
        partIds.push(part.id);
      }
      const uniqueIds = [...new Set(partIds)];
      const flagsBefore = await matchFlagsForParts(tx, uniqueIds, undefined, principal.userId, potentialScopeFor(principal));

      for (let i = 0; i < selected.length; i++) {
        const row = selected[i];
        const partId = partIds[i];
        const kind = effectiveImportKind(row, data.kind);

      if (kind === "offer") {
        const chName = row.channel || data.defaultChannel;
        if (!chName) throw new Error(`${row.mpn} 缺少渠道`);
        const ch = await ensureChannel(tx, chName);
        await tx`
          insert into channel_offers (
            id, channel_id, part_id, qty, date_code, price_amount, price_currency, price_tax,
            is_tp, lead_time_text, import_batch_id
          ) values (
            ${nid()}, ${ch.id}, ${partId}, ${row.qty}, ${row.dateCode},
            ${row.priceAmount}, ${row.priceCurrency}, ${row.priceTax},
            ${row.isTp}, ${row.leadTimeText}, ${batchId}
          )
        `;
      } else if (kind === "inquiry") {
        const cuName = row.customer || data.defaultCustomer;
        if (!cuName) throw new Error(`${row.mpn} 缺少客户`);
        const cu = await ensureCustomer(tx, cuName);
        await tx`
          insert into customer_inquiries (id, customer_id, part_id, qty, import_batch_id)
          values (${nid()}, ${cu.id}, ${partId}, ${row.qty}, ${batchId})
        `;
      } else if (kind === "stock") {
        const code = row.warehouse;
        const wh =
          warehouses.find((w) => w.code === code) ??
          warehouses.find((w) => w.id === data.defaultWarehouseId);
        if (!wh) throw new Error(`${row.mpn} 缺少仓库`);
        const lotId = nid();
        const qty = row.qty ?? 0;
        if (qty <= 0) throw new Error(`${row.mpn} 入库数量无效`);
        const supplierName = row.channel || data.defaultSupplier;
        const supplier = supplierName ? await ensureChannel(tx, supplierName) : null;
        const amount = row.costAmount;
        const currency = amount == null ? null : (row.costCurrency ?? data.defaultCurrency ?? null);
        const tax = amount == null ? null : (row.costTax ?? data.defaultTax ?? null);
        await tx`
          insert into stock_lots (
            id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
            standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, import_batch_id, origin_lot_id
          ) values (
            ${lotId}, ${partId}, ${wh.id}, 'on_hand', ${qty}, ${qty}, ${row.dateCode},
            ${row.package}, ${row.standardPack}, ${row.packState},
            ${amount}, ${currency}, ${tax}, ${supplier?.id ?? null}, ${batchId}, ${lotId}
          )
        `;
        await tx`
          insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'in', ${qty}, ${wh.id}, ${batchId})
        `;
      } else if (kind === "transit") {
        const qty = row.qty ?? 0;
        if (qty <= 0) throw new Error(`${row.mpn} 在途数量无效`);
        const parsed = parseLeadTime(row.etaText || row.leadTimeText || "");
        const lotId = nid();
        const supplierName = row.channel || data.defaultSupplier;
        const supplier = supplierName ? await ensureChannel(tx, supplierName) : null;
        const amount = row.costAmount;
        const currency = row.costCurrency;
        const tax = row.costTax;
        await tx`
          insert into stock_lots (
            id, part_id, status, qty_in, qty_remaining, date_code,
            cost_amount, cost_currency, cost_tax, supplier_id, ordered_at, eta_date, eta_text, eta_precision, import_batch_id, origin_lot_id
          ) values (
            ${lotId}, ${partId}, 'in_transit', ${qty}, ${qty}, ${row.dateCode},
            ${amount}, ${currency}, ${tax}, ${supplier?.id ?? null}, now(), ${parsed.etaDate}, ${parsed.original || null},
            ${parsed.precision}, ${batchId}, ${lotId}
          )
        `;
        await tx`
          insert into stock_movements (id, part_id, lot_id, type, qty, note, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'transit_open', ${qty}, ${row.etaText}, ${batchId})
        `;
      }
        await tx`update parts set updated_at = now() where id = ${partId}`;
      }

      const flagsAfter = await matchFlagsForParts(tx, uniqueIds, undefined, principal.userId, potentialScopeFor(principal));
    const trigger: ImportKind = data.kind === "mixed" ? "offer" : data.kind;
    const summary = {
      identified: selected.length,
      hit: uniqueIds.filter((id) => {
        const f = flagsBefore.get(id);
        return f ? isCrossHit(f, trigger) : false;
      }).length,
      stock: uniqueIds.filter((id) => flagsAfter.get(id)?.stock).length,
      inquiry: uniqueIds.filter((id) => (flagsAfter.get(id)?.inquiryCount ?? 0) > 0).length,
      dual: uniqueIds.filter((id) => flagsAfter.get(id)?.isDual).length,
      watch: uniqueIds.filter((id) => flagsAfter.get(id)?.watch).length,
    };
    const hitParts = uniqueIds.map((id) => {
      const f = flagsAfter.get(id)!;
      return {
        partId: id,
        flags: f,
        stockLine: formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel),
      };
    });
      return { batchId, summary, hitParts };
    });
  });
