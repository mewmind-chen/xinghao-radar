import type { CandidateRow, CandidateValues, ImportKindHint, TableDocument, TableMapping, TableSheet } from "./types.ts";
import { normalizeModelRow, parseMoney } from "./normalize.ts";

const ALIASES: Record<string, keyof CandidateValues | null> = {
  "型号": "mpn", mpn: "mpn", "part number": "mpn", "part no": "mpn", pn: "mpn", "p/n": "mpn", "料号": "mpn",
  "品牌": "brand", brand: "brand", mfr: "brand", 厂牌: "brand",
  "数量": "qty", qty: "qty", quantity: "qty", 库存: "qty", stock: "qty",
  "批次": "dateCode", "date code": "dateCode", dc: "dateCode", "d/c": "dateCode",
  "价格": "priceAmount", 单价: "priceAmount", price: "priceAmount", "unit price": "priceAmount", 报价: "priceAmount",
  "货期": "leadTimeText", 交期: "leadTimeText", lead: "leadTimeText", lt: "leadTimeText", leadtime: "leadTimeText",
  "仓库": "warehouse", warehouse: "warehouse", 仓位: "warehouse",
  "渠道": "channel", 供应商: "channel", supplier: "channel", vendor: "channel",
  "客户": "customer", customer: "customer",
  "封装": "package", package: "package", pkg: "package",
  "成本": "costAmount", cost: "costAmount", "cost price": "costAmount",
  "标准包装": "standardPack", "standard pack": "standardPack",
  "备注": "note", note: "note", 说明: "note",
};

export function headerKey(value: string): keyof CandidateValues | null {
  const key = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (ALIASES[key]) return ALIASES[key];
  return null;
}

function headerRowFor(sheet: TableSheet): { index: number; mapped: (keyof CandidateValues | null)[] } | null {
  let best: { index: number; mapped: (keyof CandidateValues | null)[]; score: number } | null = null;
  for (let i = 0; i < Math.min(sheet.rows.length, 12); i++) {
    const mapped = sheet.rows[i].map((v) => headerKey(v));
    const score = mapped.filter(Boolean).length + (mapped.includes("mpn") ? 10 : 0);
    if (mapped.includes("mpn") && (!best || score > best.score)) best = { index: i, mapped, score };
  }
  return best ? { index: best.index, mapped: best.mapped } : null;
}

export function inferMapping(sheet: TableSheet): TableMapping | null {
  const header = headerRowFor(sheet);
  if (!header) return null;
  const columns: TableMapping["columns"] = {};
  const duplicates = new Set<string>();
  const unmappedHeaders: string[] = [];
  header.mapped.forEach((field, index) => {
    const raw = sheet.rows[header.index][index] ?? "";
    if (!field) {
      if (raw.trim()) unmappedHeaders.push(raw.trim());
      return;
    }
    if (field in columns) duplicates.add(field);
    else columns[field] = index;
  });
  const needsReview = columns.mpn == null || duplicates.size > 0 || unmappedHeaders.length > 0;
  return {
    sheet: sheet.name,
    headerRow: header.index,
    dataStartRow: header.index + 1,
    columns,
    unmappedHeaders,
    needsReview,
    reason: needsReview ? (duplicates.size ? "表头存在重复字段" : "需要智能列映射") : undefined,
  };
}

function cell(sheet: TableSheet, row: string[], field: keyof CandidateValues, mapping: TableMapping): string {
  const index = mapping.columns[field];
  return index == null ? "" : String(row[index] ?? "").trim();
}

function columnLetters(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

export function applyMapping(sheet: TableSheet, mapping: TableMapping, kindHint: ImportKindHint): CandidateRow[] {
  const rows: CandidateRow[] = [];
  for (let rowIndex = mapping.dataStartRow; rowIndex < sheet.rows.length; rowIndex++) {
    const row = sheet.rows[rowIndex];
    const mpn = cell(sheet, row, "mpn", mapping).normalize("NFKC").trim();
    if (!mpn) continue;
    const priceRaw = cell(sheet, row, "priceAmount", mapping);
    const costRaw = cell(sheet, row, "costAmount", mapping);
    const price = parseMoney(priceRaw);
    const cost = parseMoney(costRaw);
    const qtyRaw = cell(sheet, row, "qty", mapping);
    const candidate = normalizeModelRow(
      {
        mpn,
        brand: cell(sheet, row, "brand", mapping) || null,
        qtyRaw,
        dateCode: cell(sheet, row, "dateCode", mapping) || null,
        priceRaw,
        priceAmount: price.amount,
        priceCurrency: price.currency,
        priceTax: price.tax,
        isTp: price.isTp,
        leadTimeText: cell(sheet, row, "leadTimeText", mapping) || null,
        warehouse: cell(sheet, row, "warehouse", mapping) || null,
        channel: cell(sheet, row, "channel", mapping) || null,
        customer: cell(sheet, row, "customer", mapping) || null,
        package: cell(sheet, row, "package", mapping) || null,
        standardPack: cell(sheet, row, "standardPack", mapping) || null,
        costRaw,
        costAmount: cost.amount,
        costCurrency: cost.currency,
        costTax: cost.tax,
        note: row.filter(Boolean).join(" | "),
        kind: kindHint === "mixed" ? undefined : kindHint,
      },
      {
        kindHint,
        defaultEvidence: [{ type: "cell", sheet: sheet.name, row: rowIndex + 1, column: mapping.columns.mpn ?? 0, address: `${sheet.name}!${columnLetters(mapping.columns.mpn ?? 0)}${rowIndex + 1}`, quote: mpn }],
      },
    );
    if (!candidate) continue;
    candidate.evidence = {
      ...candidate.evidence,
      mpn: [{ type: "cell", sheet: sheet.name, row: rowIndex + 1, column: mapping.columns.mpn ?? 0, address: `${sheet.name}!${columnLetters(mapping.columns.mpn ?? 0)}${rowIndex + 1}`, quote: mpn }],
    };
    candidate.verification = "exact";
    rows.push(candidate);
  }
  return rows;
}

export function sampleTable(sheet: TableSheet, mapping: TableMapping | null, maxRows = 40): string {
  const start = mapping?.headerRow ?? 0;
  return sheet.rows.slice(start, start + maxRows).map((row, i) => `row[${start + i}]: ${row.map((v, j) => `col[${j}] ${v}`).join(" | ")}`).join("\n");
}

export function tableSummary(table: TableDocument): string {
  return table.sheets.map((sheet) => {
    const mapping = inferMapping(sheet);
    return `工作表: ${sheet.name}\n${sampleTable(sheet, mapping)}`;
  }).join("\n\n");
}
