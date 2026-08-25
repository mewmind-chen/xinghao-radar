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

const MPN_RE = /[A-Za-z0-9][-A-Za-z0-9._+/]{3,40}/;

/**
 * 从剩余文本挑选数量：
 * 1) 优先「数字+数量单位」（K/W/万）—— "10K 2418 $1.15" → 10K(10000)；
 * 2) 无单位时取首个裸数字，但跳过紧跟币符/价格词的数字（$1.15、￥8.5、1.15元
 *    → 那是价格不是数量）；仍可能返回小数（如裸 "1.15"），由写库层整数校验兜底。
 */
function pickQtyRaw(rest: string): { raw: string; qty: number | null } | null {
  const unit = rest.match(
    /(?:^|[^A-Za-z0-9])((\d+(?:\.\d+)?)\s*(万|W|K|k|M))(?![A-Za-z0-9])/,
  );
  if (unit) return { raw: unit[1], qty: parseQty(unit[1]) };
  const plain = rest.match(/(?:^|[^A-Za-z0-9])(\d+(?:\.\d+)?)(?=[^A-Za-z0-9]|$)/);
  if (!plain) return null;
  const prefix = rest[plain.index ?? 0] ?? "";
  const digitsEnd = (plain.index ?? 0) + 1 + plain[1].length;
  const after = rest[digitsEnd] ?? "";
  // 数字前是币符（$1.15）或后接币符/价格词（1.15元）→ 是价格不是数量
  if (/[$¥￥]/.test(prefix) || /[$¥￥]|元|价格/.test(after)) return null;
  return { raw: plain[1], qty: parseQty(plain[1]) };
}

export function heuristicParse(text: string, kind: ImportKind | "mixed"): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const line of extractTextLines(text).lines) {
    const mpnMatch = line.match(MPN_RE);
    if (!mpnMatch) continue;
    const mpn = displayMpn(mpnMatch[0]);
    const rest = line.replace(mpnMatch[0], " ");
    // 逐段摘除已识别字段，价格只用残余文本解析（避免把数量/批次/货期数字吸进价格）
    let tail = " " + rest;
    const take = (rx: RegExp): string => {
      const m = tail.match(rx);
      if (m && m[0] && m[0].trim()) {
        tail = tail.replace(m[0], " ");
        return m[0].trim();
      }
      return "";
    };
    const qtyPick = pickQtyRaw(tail);
    if (qtyPick) {
      const hit = tail.indexOf(qtyPick.raw);
      if (hit >= 0) tail = tail.slice(0, hit) + " " + tail.slice(hit + qtyPick.raw.length);
    }
    const qty = qtyPick?.qty ?? null;
    const dcRaw = take(/(?:^|[^A-Za-z0-9])(?:(?:DC|D[/]C)\s*)?((?:20\d{2}|2[3-6]\d{2})\+?|\d{2}\+)(?=[^A-Za-z0-9+]|$)/i);
    const ltRaw = take(/(?<![$¥￥\d.])(LT\s*)?(\d+\s*周|现货|\d{1,2}[/.]\d{1,2}|\d+\s*月底|几天后|8月底)/i);
    const whRaw = take(/HK|香港|坂田|板田|交通/);
    const chRaw = take(/渠道\s*[\u4e00-\u9fa5A-Za-z0-9]{2,12}/);
    const custRaw = take(/客[户]?\s*[\u4e00-\u9fa5A-Za-z0-9]{2,12}/);
    const cost = parseCost(tail);

    const isInquiry = kind === "inquiry" || /询|客户|客\s/.test(rest);
    const isTransit = kind === "transit" || /在途|到货|货期|月底到/.test(rest);
    const isStock = kind === "stock" || /入库|入仓/.test(rest);
    let rowKind: ImportKind = kind === "mixed" ? "offer" : (kind as ImportKind);
    if (kind === "mixed") {
      if (isInquiry) rowKind = "inquiry";
      else if (isTransit) rowKind = "transit";
      else if (isStock) rowKind = "stock";
      else rowKind = "offer";
    }
    const cust = custRaw.match(/客[户]?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
    const ch = chRaw.match(/渠道\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
    const dc = dcRaw.match(/((?:20\d{2}|2[3-6]\d{2})\+?|\d{2}\+)/);
    rows.push({
      id: nid(),
      kind: rowKind,
      mpn,
      brand: null,
      qty,
      qtyRaw: qtyPick?.raw ?? null,
      dateCode: dc ? dc[1] : null,
      priceAmount: cost.amount,
      priceCurrency: cost.currency,
      priceTax: cost.tax,
      isTp: cost.isTp || /\bTP\b/.test(rest),
      leadTimeText: ltRaw || null,
      etaText: ltRaw || null,
      warehouse: whRaw ? resolveWarehouseCode(whRaw) : null,
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
