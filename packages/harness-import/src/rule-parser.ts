/**
 * rule-parser —— 低成本文本启发式解析（方案第 15 节：保留，继续做 fallback）。
 * 逻辑原样迁移自 src/lib/server/import.ts 的 splitLines/MPN_RE/heuristicParse（行为零变化）。
 */

import {
  displayMpn,
  nid,
  parseCost,
  parseQty,
  resolveWarehouseCode,
} from "./radar-domain.ts";
import { extractTextLines } from "./plugins/text-extractor.ts";
import type { ImportKind, ImportRow } from "./schema.ts";

const MPN_RE = /[A-Za-z0-9][A-Za-z0-9._+\-\/]{3,40}/;

export function heuristicParse(text: string, kind: ImportKind | "mixed"): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const line of extractTextLines(text).lines) {
    const mpnMatch = line.match(MPN_RE);
    if (!mpnMatch) continue;
    const mpn = displayMpn(mpnMatch[0]);
    const rest = line.replace(mpnMatch[0], " ");
    const qtyHit = rest.match(/(\d+(?:\.\d+)?)\s*(万|W|K|k|M)?/);
    const qty = qtyHit ? parseQty(qtyHit[0]) : null;
    const cost = parseCost(rest);
    const dc = rest.match(/(?:^|[^A-Za-z0-9])((?:20\d{2}|2[3-6]\d{2})\+?|\d{2}\+)(?=[^A-Za-z0-9+]|$)/);
    const lt = rest.match(/(LT\s*)?(\d+\s*周|现货|\d{1,2}[\/.]\d{1,2}|\d+\s*月底|几天后|8月底)/i);
    const wh = rest.match(/HK|香港|坂田|板田|交通/);
    const isInquiry = kind === "inquiry" || /询|客户/.test(rest);
    const isTransit = kind === "transit" || /在途|到货|货期/.test(rest);
    const isStock = kind === "stock" || /入库|入仓/.test(rest);
    let rowKind: ImportKind = kind === "mixed" ? "offer" : (kind as ImportKind);
    if (kind === "mixed") {
      if (isInquiry) rowKind = "inquiry";
      else if (isTransit) rowKind = "transit";
      else if (isStock) rowKind = "stock";
      else rowKind = "offer";
    }
    const cust = rest.match(/客[户]?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
    const ch = rest.match(/渠道\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
    rows.push({
      id: nid(),
      kind: rowKind,
      mpn,
      brand: null,
      qty,
      qtyRaw: qtyHit ? qtyHit[0] : null,
      dateCode: dc ? dc[1] : null,
      priceAmount: cost.amount,
      priceCurrency: cost.currency,
      priceTax: cost.tax,
      isTp: cost.isTp || /\bTP\b/.test(rest),
      leadTimeText: lt ? lt[0] : null,
      etaText: lt ? lt[0] : null,
      warehouse: wh ? resolveWarehouseCode(wh[0]) : null,
      channel: ch ? ch[1] : null,
      customer: cust ? cust[1] : null,
      package: null,
      standardPack: null,
      packState: null,
      costAmount: cost.amount,
      costCurrency: cost.currency,
      costTax: cost.tax,
      note: line,
      duplicate: false,
      duplicateReason: null,
      selected: true,
      warning: null,
    });
  }
  return rows;
}
