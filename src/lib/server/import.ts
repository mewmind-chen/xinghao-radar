/**
 * Import Service —— 预览数据组装 / 重复检测 / 确认写库。
 *
 * 抽取决策在 import-contract：受信内部模板 / 受控文本走确定性 parser；
 * 无界表格与聊天文本走 Platform。needsAgent + 空 candidates 不是失败，
 * 禁止因此用 headerKey / heuristic 冒充成功。confirmImport 仍是唯一写库入口。
 */

import { createServerFn } from "@tanstack/react-start";
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
} from "./helpers";
import { ensureSeed } from "./seed";

function flagIntraFileDuplicates(rows: ImportRow[]) {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const k = [
      row.kind,
      normalizeMpn(row.mpn),
      row.qty ?? "",
      row.dateCode ?? "",
      row.channel ?? "",
      row.customer ?? "",
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

async function markDuplicates(sql: Awaited<ReturnType<typeof sqlClient>>, rows: ImportRow[]) {
  flagIntraFileDuplicates(rows);
  for (const row of rows) {
    if (row.duplicate) continue;
    const key = normalizeMpn(row.mpn);
    const part = await sql`select id from parts where mpn_key = ${key} limit 1`;
    if (!part[0]) continue;
    const partId = String(part[0].id);
    if (row.kind === "offer") {
      const chName = row.channel ?? "";
      const hits = await sql`
        select o.id from channel_offers o
        join channels ch on ch.id = o.channel_id
        where o.part_id = ${partId} and o.deleted_at is null
          and o.offered_at >= now() - (${DUPLICATE_OFFER_HOURS} || ' hours')::interval
          and coalesce(o.qty, -1) = coalesce(${row.qty}, -1)
          and coalesce(o.date_code,'') = coalesce(${row.dateCode ?? ""}, '')
          and o.is_tp = ${row.isTp}
          and coalesce(o.price_amount, -1) = coalesce(${row.priceAmount ?? null}, -1)
          and (${chName} = '' or ch.name = ${chName})
        limit 3
      `;
      if (hits.length > 0) {
        row.duplicate = true;
        row.duplicateReason = `疑似重复：同渠道同型号近 ${DUPLICATE_OFFER_HOURS}h 已有推货`;
        row.selected = false;
      }
    }
    if (row.kind === "inquiry") {
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
  .validator(
    (input: {
      kind: ImportKind;
      sourceType: ImportSource;
      text?: string;
      filename?: string;
      fileBase64?: string;
      mime?: string;
    }) => input,
  )
  .handler(async ({ data }) => {
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

    const rows = resolved.rows;
    const usedAi = resolved.usedAi;
    const providers = defaultProviders();

    await markDuplicates(sql, rows);
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
  .validator(
    (input: {
      kind: ImportKind;
      sourceType: ImportSource;
      filename?: string;
      excerpt?: string;
      defaultChannel?: string;
      defaultCustomer?: string;
      defaultWarehouseId?: string;
      rows: ImportRow[];
    }) => input,
  )
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const selected = data.rows.filter((r) => r.selected && r.mpn);
    const warehouses = await listWarehouses(sql);
    for (const row of selected) {
      const kind = row.kind === "mixed" ? data.kind : row.kind;
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
      }
      if (kind === "transit") {
        requireIntQty(row.qty, "在途");
      }
    }

    const batchId = nid();
    await sql`
      insert into import_batches (id, kind, source_type, filename, raw_excerpt)
      values (${batchId}, ${data.kind}, ${data.sourceType}, ${data.filename ?? null}, ${data.excerpt ?? null})
    `;

    const partIds: string[] = [];
    for (const row of selected) {
      const part = await ensurePart(sql, row.mpn, {
        brand: row.brand,
        package: row.package,
        source: "导入",
      });
      partIds.push(part.id);
    }
    const uniqueIds = [...new Set(partIds)];
    const flagsBefore = await matchFlagsForParts(sql, uniqueIds);

    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      const partId = partIds[i];
      const kind = row.kind === "mixed" ? data.kind : row.kind;

      if (kind === "offer") {
        const chName = row.channel || data.defaultChannel;
        if (!chName) throw new Error(`${row.mpn} 缺少渠道`);
        const ch = await ensureChannel(sql, chName);
        await sql`
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
        const cu = await ensureCustomer(sql, cuName);
        await sql`
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
        const supplier = row.channel ? await ensureChannel(sql, row.channel) : null;
        await sql`
          insert into stock_lots (
            id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
            standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, import_batch_id
          ) values (
            ${lotId}, ${partId}, ${wh.id}, 'on_hand', ${qty}, ${qty}, ${row.dateCode},
            ${row.package}, ${row.standardPack}, ${row.packState},
            ${row.costAmount ?? row.priceAmount}, ${row.costCurrency ?? row.priceCurrency},
            ${row.costTax ?? row.priceTax}, ${supplier?.id ?? null}, ${batchId}
          )
        `;
        await sql`
          insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'in', ${qty}, ${wh.id}, ${batchId})
        `;
      } else if (kind === "transit") {
        const qty = row.qty ?? 0;
        if (qty <= 0) throw new Error(`${row.mpn} 在途数量无效`);
        const parsed = parseLeadTime(row.etaText || row.leadTimeText || "");
        const lotId = nid();
        const supplier = row.channel ? await ensureChannel(sql, row.channel) : null;
        await sql`
          insert into stock_lots (
            id, part_id, status, qty_in, qty_remaining, date_code,
            cost_amount, cost_currency, cost_tax, supplier_id, ordered_at, eta_date, eta_text, eta_precision, import_batch_id
          ) values (
            ${lotId}, ${partId}, 'in_transit', ${qty}, ${qty}, ${row.dateCode},
            ${row.costAmount ?? row.priceAmount}, ${row.costCurrency ?? row.priceCurrency},
            ${row.costTax ?? row.priceTax}, ${supplier?.id ?? null}, now(), ${parsed.etaDate}, ${parsed.original || null},
            ${parsed.precision}, ${batchId}
          )
        `;
        await sql`
          insert into stock_movements (id, part_id, lot_id, type, qty, note, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'transit_open', ${qty}, ${row.etaText}, ${batchId})
        `;
      }
      await sql`update parts set updated_at = now() where id = ${partId}`;
    }

    const flagsAfter = await matchFlagsForParts(sql, uniqueIds);
    const trigger: ImportKind = data.kind === "mixed" ? "offer" : data.kind;
    const summary = {
      identified: selected.length,
      hit: uniqueIds.filter((id) => {
        const f = flagsBefore.get(id);
        return f ? isCrossHit(f, trigger) : false;
      }).length,
      stock: uniqueIds.filter((id) => flagsBefore.get(id)?.stock).length,
      inquiry: uniqueIds.filter((id) => (flagsBefore.get(id)?.inquiryCount ?? 0) > 0).length,
      dual: uniqueIds.filter((id) => flagsBefore.get(id)?.isDual).length,
      watch: uniqueIds.filter((id) => flagsBefore.get(id)?.watch).length,
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
