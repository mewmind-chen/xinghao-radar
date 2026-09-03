import type {
  CandidateRow,
  CandidateValues,
  CostTax,
  Currency,
  ImportKind,
  ImportKindHint,
  SourceEvidence,
} from "./types.ts";

const FIELD_NAMES = [
  "mpn", "brand", "qty", "qtyRaw", "dateCode", "priceAmount", "priceCurrency", "priceTax",
  "isTp", "leadTimeText", "etaText", "warehouse", "channel", "customer", "package",
  "standardPack", "packState", "costAmount", "costCurrency", "costTax", "note",
] as const;

export type RawModelRow = Record<string, unknown>;

export function makeId(prefix = "import"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function normalizeMpn(value: unknown): string | null {
  const text = String(value ?? "").normalize("NFKC").trim();
  return text || null;
}

export function parseQty(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").normalize("NFKC").trim().replace(/,/g, "");
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(万|[KkWwMm])?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "万" ? 10000 : unit === "k" ? 1000 : unit === "w" ? 10000 : unit === "m" ? 1000000 : 1;
  return n * multiplier;
}

export function parseMoney(value: unknown): {
  amount: number | null;
  currency: Currency;
  tax: CostTax;
  isTp: boolean;
} {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!raw) return { amount: null, currency: null, tax: null, isTp: false };
  const isTp = /(^|\b)TP(\b|$)|目标价|待报价|询价/.test(raw);
  const amountMatch = raw.replace(/,/g, "").match(/(?:^|[^\d.])(\d+(?:\.\d+)?)(?!\d)/);
  const amount = amountMatch ? Number(amountMatch[1]) : null;
  const currency = /\$|USD|美金|美元/i.test(raw) ? "USD" : /¥|￥|CNY|人民币|元/i.test(raw) ? "CNY" : null;
  const tax = /含税|含增值税/.test(raw) ? "inclusive" : /未税|不含税/.test(raw) ? "exclusive" : null;
  return { amount: amount != null && Number.isFinite(amount) ? amount : null, currency, tax, isTp };
}

export function normalizeKind(value: unknown, hint: ImportKindHint): ImportKind | null {
  if (value === "offer" || value === "inquiry" || value === "stock" || value === "transit") return value;
  return hint === "mixed" ? null : hint;
}

function text(value: unknown): string | null {
  const t = String(value ?? "").normalize("NFKC").trim();
  return t || null;
}

function currency(value: unknown): Currency {
  return value === "USD" || value === "CNY" ? value : null;
}

function tax(value: unknown): CostTax {
  return value === "none" || value === "exclusive" || value === "inclusive" ? value : null;
}

function packState(value: unknown): CandidateValues["packState"] {
  return value === "full" || value === "loose" || value === "mixed" ? value : null;
}

function emptyValues(): CandidateValues {
  return {
    mpn: null, brand: null, qty: null, qtyRaw: null, dateCode: null,
    priceAmount: null, priceCurrency: null, priceTax: null, isTp: false,
    leadTimeText: null, etaText: null, warehouse: null, channel: null, customer: null,
    package: null, standardPack: null, packState: null, costAmount: null,
    costCurrency: null, costTax: null, note: null,
  };
}

function evidenceFor(raw: unknown): Partial<CandidateRow["evidence"]> {
  if (Array.isArray(raw)) {
    const out: Partial<CandidateRow["evidence"]> = {};
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const field = typeof value.field === "string" ? value.field as keyof CandidateValues | "kind" : null;
      const type = value.type;
      if (!field || (type !== "text" && type !== "cell" && type !== "page" && type !== "image")) continue;
      const quote = typeof value.quote === "string" ? value.quote : undefined;
      const evidence: SourceEvidence = type === "text"
        ? { type, start: 0, end: quote?.length ?? 0, quote: quote ?? "" }
        : type === "cell"
          ? { type, sheet: typeof value.sheet === "string" ? value.sheet : "", row: typeof value.row === "number" ? value.row : 0, column: typeof value.column === "number" ? value.column : 0, address: typeof value.address === "string" ? value.address : "", quote: quote ?? "" }
          : type === "page"
            ? { type, page: typeof value.page === "number" ? value.page : 0, quote, region: Array.isArray(value.region) ? value.region as [number, number, number, number] : undefined }
            : { type, quote, region: Array.isArray(value.region) ? value.region as [number, number, number, number] : undefined };
      const list = out[field] ?? [];
      list.push(evidence);
      out[field] = list;
    }
    return out;
  }
  if (!raw || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const out: Partial<CandidateRow["evidence"]> = {};
  for (const field of [...FIELD_NAMES, "kind"] as const) {
    const value = source[field];
    if (!Array.isArray(value)) continue;
    const valid = value.filter((e): e is SourceEvidence => {
      if (!e || typeof e !== "object") return false;
      const type = (e as { type?: unknown }).type;
      return type === "text" || type === "cell" || type === "page" || type === "image";
    });
    if (valid.length) out[field] = valid;
  }
  return out;
}

function hasExactTextEvidence(value: string, evidence: SourceEvidence[], sourceText?: string): boolean {
  if (!sourceText) return false;
  const hay = sourceText.normalize("NFKC").toLowerCase();
  const normalizedValue = value.normalize("NFKC").toLowerCase();
  return hay.includes(normalizedValue) && evidence.some((e) => e.type === "text" && e.quote && hay.includes(e.quote.normalize("NFKC").toLowerCase()) && e.quote.normalize("NFKC").toLowerCase().includes(normalizedValue));
}

export function normalizeModelRow(
  raw: RawModelRow,
  opts: { kindHint: ImportKindHint; sourceText?: string; visualOnly?: boolean; defaultEvidence?: SourceEvidence[] },
): CandidateRow | null {
  const values = emptyValues();
  values.mpn = normalizeMpn(raw.mpn ?? raw.mpnRaw ?? raw["型号"]);
  if (!values.mpn) return null;
  values.brand = text(raw.brand);
  values.qtyRaw = text(raw.qtyRaw ?? raw.qty);
  values.qty = parseQty(raw.qtyRaw ?? raw.qty);
  values.dateCode = text(raw.dateCode ?? raw.dateCodeRaw);
  const price = parseMoney(raw.priceRaw ?? raw.priceAmount ?? raw.price);
  values.priceAmount = typeof raw.priceAmount === "number" && Number.isFinite(raw.priceAmount) ? raw.priceAmount : price.amount;
  values.priceCurrency = currency(raw.priceCurrency) ?? price.currency;
  values.priceTax = tax(raw.priceTax) ?? price.tax;
  values.isTp = Boolean(raw.isTp) || price.isTp;
  values.leadTimeText = text(raw.leadTimeText ?? raw.leadTime);
  values.etaText = text(raw.etaText ?? raw.eta) ?? values.leadTimeText;
  values.warehouse = text(raw.warehouse);
  values.channel = text(raw.channel ?? raw.supplier);
  values.customer = text(raw.customer);
  values.package = text(raw.package ?? raw.pkg);
  values.standardPack = text(raw.standardPack);
  values.packState = packState(raw.packState);
  const cost = parseMoney(raw.costRaw ?? raw.costAmount ?? raw.cost);
  values.costAmount = typeof raw.costAmount === "number" && Number.isFinite(raw.costAmount) ? raw.costAmount : cost.amount;
  values.costCurrency = currency(raw.costCurrency) ?? cost.currency;
  values.costTax = tax(raw.costTax) ?? cost.tax;
  values.note = text(raw.note);

  const evidence = evidenceFor(raw.evidence);
  if (opts.defaultEvidence && !evidence.mpn) evidence.mpn = opts.defaultEvidence;
  const normalizedMpn = values.mpn.normalize("NFKC").trim().toLowerCase();
  const hasTrustedCellEvidence = Boolean(
    evidence.mpn?.some((item) => item.type === "cell" && item.quote?.normalize("NFKC").trim().toLowerCase() === normalizedMpn),
  );
  const verification = opts.visualOnly
    ? "visual_only"
    : evidence.mpn?.length && hasExactTextEvidence(values.mpn, evidence.mpn, opts.sourceText)
      ? "exact"
      : hasTrustedCellEvidence
        ? "exact"
      : evidence.mpn?.length
        ? "unverified"
        : "unverified";
  const issues: string[] = [];
  const kind = normalizeKind(raw.kind, opts.kindHint);
  if (!kind) issues.push("业务类型无法确定，请人工选择");
  if (!evidence.mpn?.length && !opts.visualOnly) issues.push("型号缺少原文证据");
  if (verification === "unverified" && !opts.visualOnly) issues.push("型号无法在来源中精确定位");

  return {
    ...values,
    id: makeId("row"),
    kind,
    evidence,
    verification,
    issues,
  };
}

export function normalizeRows(
  raws: RawModelRow[],
  opts: { kindHint: ImportKindHint; sourceText?: string; visualOnly?: boolean },
): CandidateRow[] {
  return raws.map((raw) => normalizeModelRow(raw, opts)).filter((row): row is CandidateRow => Boolean(row));
}

export function exactSourceEvidence(sourceText: string, value: string): SourceEvidence[] {
  const index = sourceText.normalize("NFKC").toLowerCase().indexOf(value.normalize("NFKC").toLowerCase());
  return index < 0 ? [] : [{ type: "text", start: index, end: index + value.length, quote: sourceText.slice(index, index + value.length) }];
}

export function validateCandidateRows(rows: CandidateRow[]): { rows: CandidateRow[]; issues: { code: "missing_mpn" | "missing_kind" | "missing_evidence"; message: string; rowId: string }[] } {
  const issues: { code: "missing_mpn" | "missing_kind" | "missing_evidence"; message: string; rowId: string }[] = [];
  const valid: CandidateRow[] = [];
  for (const row of rows) {
    if (!row.mpn) {
      issues.push({ code: "missing_mpn", message: "型号为空", rowId: row.id });
      continue;
    }
    if (!row.kind) issues.push({ code: "missing_kind", message: "业务类型无法确定", rowId: row.id });
    if (row.verification === "unverified") issues.push({ code: "missing_evidence", message: "型号缺少可验证来源", rowId: row.id });
    valid.push(row);
  }
  return { rows: valid, issues };
}
