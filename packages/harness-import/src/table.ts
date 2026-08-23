/**
 * table.ts —— 表格矩阵 → ImportRow（确定性表头映射，无 AI 参与）。
 * 逻辑原样迁移自 src/lib/server/import.ts 的 headerKey/tableToRows（行为零变化）。
 */

import { brandShort, displayMpn, nid, parseCost, parseQty, resolveWarehouseCode } from "./radar-domain.ts";
import type { ImportKind, ImportRow } from "./schema.ts";

export function headerKey(h: string): string | null {
  const s = h.normalize("NFKC").trim().toLowerCase();
  if (/型号|mpn|p\/n|pn|part\s*number|料号/.test(s)) return "mpn";
  if (/品牌|brand|mfr|厂牌/.test(s)) return "brand";
  if (/数量|qty|quantity/.test(s)) return "qty";
  if (/批次|date\s*code|^dc$|d\/c/.test(s)) return "dateCode";
  if (/价格|单价|price|tp/.test(s)) return "price";
  if (/货期|交期|lead|lt/.test(s)) return "lt";
  if (/仓库|仓位|warehouse/.test(s)) return "warehouse";
  if (/客户|customer/.test(s)) return "customer";
  if (/渠道|供应商|vendor|supplier/.test(s)) return "channel";
  if (/封装|package|pkg/.test(s)) return "package";
  if (/成本|cost/.test(s)) return "cost";
  return null;
}

export function tableToRows(table: string[][], kind: ImportKind | "mixed"): ImportRow[] {
  if (table.length === 0) return [];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(table.length, 8); i++) {
    const mapped = table[i].map(headerKey);
    if (mapped.includes("mpn")) {
      headerIdx = i;
      break;
    }
  }
  const headers = table[headerIdx].map(headerKey);
  const rows: ImportRow[] = [];
  for (const line of table.slice(headerIdx + 1)) {
    const get = (k: string) => {
      const i = headers.indexOf(k);
      return i >= 0 ? String(line[i] ?? "").trim() : "";
    };
    const mpn = displayMpn(get("mpn"));
    if (!mpn) continue;
    const cost = parseCost(get("price") || get("cost"));
    rows.push({
      id: nid(),
      kind: kind === "mixed" ? (get("customer") ? "inquiry" : get("warehouse") ? "stock" : "offer") : (kind as ImportKind),
      mpn,
      brand: get("brand") ? brandShort(get("brand")) : null,
      qty: parseQty(get("qty")),
      qtyRaw: get("qty") || null,
      dateCode: get("dateCode") || null,
      priceAmount: cost.amount,
      priceCurrency: cost.currency,
      priceTax: cost.tax,
      isTp: cost.isTp || /tp/i.test(get("price")),
      leadTimeText: get("lt") || null,
      etaText: get("lt") || null,
      warehouse: resolveWarehouseCode(get("warehouse")) || null,
      channel: get("channel") || null,
      customer: get("customer") || null,
      package: get("package") || null,
      standardPack: null,
      packState: null,
      costAmount: cost.amount,
      costCurrency: cost.currency,
      costTax: cost.tax,
      note: line.filter(Boolean).join(" | "),
      duplicate: false,
      duplicateReason: null,
      selected: true,
      warning: null,
    });
  }
  return rows;
}
