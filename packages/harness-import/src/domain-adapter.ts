/**
 * domain-adapter —— 模型原始抽取行 → ImportRow 的确定性后处理
 * （方案第 6 节"确定性后处理"、第 9 节"AI 只负责抽取"、第 10 节 MPN 处理规则）。
 *
 * 对抗性不变量（验收 8）：
 * - MPN 只做 NFKC/trim，禁止任何"看起来更对"的改写
 * - AI 返回的 MPN 若在原文中找不到（NFKC+小写比对）→ 只加 warning
 *   "疑似识别异常，请人工确认"，绝不改值 —— 判断留给预览页的人
 */

import {
  brandShort,
  displayMpn,
  nid,
  parseCost,
  parseQty,
  resolveWarehouseCode,
} from "./radar-domain.ts";
import { asCostTax, asCurrency, asPackState } from "./model-adapter.ts";
import { isImportKind } from "./schema.ts";
import type { ImportKind, ImportRow, RawExtractedRow } from "./schema.ts";

export function verifyMpnProvenance(
  mpn: string,
  sourceText: string | undefined,
): string | null {
  if (!sourceText) return null; // 图片等无原文可比，交给预览页人工核对
  const hay = sourceText.normalize("NFKC").toLowerCase();
  const needle = mpn.normalize("NFKC").trim().toLowerCase();
  if (!needle) return "缺少型号";
  return hay.includes(needle) ? null : "疑似识别异常，请人工确认";
}

export function rawRowsToImportRows(
  raws: RawExtractedRow[],
  opts: {
    defaultKind: ImportKind | "mixed";
    sourceText?: string;
    /** 是否做 MPN 原文比对（图片输入无原文时为 false） */
    provenanceCheck?: boolean;
  },
): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const r of raws) {
    if (!r || typeof r !== "object") continue;
    // MPN：只允许 NFKC + trim。AI 给什么就展示什么，绝不改写。
    const mpn = displayMpn(String(r.mpn ?? ""));
    if (!mpn) continue;

    // 数量/成本回落确定性 parser：模型给数值就用数值，给文本就本地解析
    const cost = parseCost(
      r.priceAmount != null ? String(r.priceAmount) : r.costAmount != null ? String(r.costAmount) : "",
    );
    const qty =
      typeof r.qty === "number"
        ? Number.isFinite(r.qty)
          ? Math.round(r.qty)
          : null
        : parseQty(String(r.qty ?? ""));

    const kind = isImportKind(r.kind)
      ? r.kind
      : opts.defaultKind === "mixed"
        ? "offer"
        : opts.defaultKind;

    const warnings: string[] = [];
    if (opts.provenanceCheck !== false) {
      const w = verifyMpnProvenance(mpn, opts.sourceText);
      if (w) warnings.push(w);
    }

    rows.push({
      id: nid(),
      kind,
      mpn,
      brand: r.brand ? brandShort(String(r.brand)) : null,
      qty: Number.isFinite(qty) ? qty : null,
      qtyRaw: r.qty != null ? String(r.qty) : null,
      dateCode: r.dateCode ? String(r.dateCode) : null,
      priceAmount: r.priceAmount != null ? Number(r.priceAmount) : cost.amount,
      priceCurrency: asCurrency(r.priceCurrency) ?? cost.currency,
      priceTax: asCostTax(r.priceTax) ?? cost.tax,
      isTp: Boolean(r.isTp) || cost.isTp,
      leadTimeText: r.leadTimeText ? String(r.leadTimeText) : null,
      etaText: r.etaText ? String(r.etaText) : r.leadTimeText ? String(r.leadTimeText) : null,
      warehouse: resolveWarehouseCode(r.warehouse ? String(r.warehouse) : null),
      channel: r.channel ? String(r.channel) : null,
      customer: r.customer ? String(r.customer) : null,
      package: r.package ? String(r.package) : null,
      standardPack: r.standardPack ? String(r.standardPack) : null,
      packState: asPackState(r.packState),
      costAmount: r.costAmount != null ? Number(r.costAmount) : cost.amount,
      costCurrency: asCurrency(r.costCurrency) ?? cost.currency,
      costTax: asCostTax(r.costTax) ?? cost.tax,
      note: r.note ? String(r.note) : null,
      duplicate: false,
      duplicateReason: null,
      selected: true,
      warning: warnings.length ? warnings.join("；") : null,
    });
  }
  return rows;
}
