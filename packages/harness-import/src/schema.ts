/**
 * Harness Import Schema —— 统一结构化事件行。
 *
 * 镜像自 `src/lib/types.ts` 的 `ImportRow`：两处结构必须保持一致，
 * 宿主侧赋值处由 tsc 结构类型守卫；此处独立定义是为了让本包零宿主类型依赖
 * （Node --test 直跑 + 未来可拆独立构建）。
 *
 * 方案第 9 节 Import Schema / 第 10 节 MPN 处理规则：
 * - kind 枚举固定 offer|inquiry|stock|transit（mixed 只在宿主入口存在，agent 出口必收敛）
 * - mpn 只允许 NFKC/trim 后原样展示；AI 怀疑识别错误只能写 warning，禁止改值
 */

export type ImportKind = "offer" | "inquiry" | "stock" | "transit";
export type ImportSource = "excel" | "csv" | "pdf" | "word" | "image" | "text";
export type CostTax = "none" | "exclusive" | "inclusive" | null;
export type Currency = "USD" | "CNY" | null;
export type PackState = "full" | "loose" | "mixed";

export const IMPORT_KINDS: readonly ImportKind[] = ["offer", "inquiry", "stock", "transit"];

/** 模型返回的原始抽取行（未做确定性后处理）。 */
export type RawExtractedRow = Record<string, unknown>;

export type ImportRow = {
  id: string;
  kind: ImportKind;
  mpn: string;
  brand: string | null;
  qty: number | null;
  qtyRaw: string | null;
  dateCode: string | null;
  priceAmount: number | null;
  priceCurrency: Currency;
  priceTax: CostTax;
  isTp: boolean;
  leadTimeText: string | null;
  etaText: string | null;
  warehouse: string | null;
  channel: string | null;
  customer: string | null;
  package: string | null;
  standardPack: string | null;
  packState: PackState | null;
  costAmount: number | null;
  costCurrency: Currency;
  costTax: CostTax;
  note: string | null;
  duplicate: boolean;
  duplicateReason: string | null;
  selected: boolean;
  warning: string | null;
};

export function isImportKind(v: unknown): v is ImportKind {
  return typeof v === "string" && (IMPORT_KINDS as readonly string[]).includes(v);
}

/**
 * schema 守卫：数值字段必须有限，kind 必须合法，mpn 必须非空。
 * 返回过滤后的合法行（不修值、不猜值）。
 */
export function validateImportRows(rows: ImportRow[]): ImportRow[] {
  const out: ImportRow[] = [];
  for (const r of rows) {
    if (!r.mpn || !r.mpn.trim()) continue;
    if (!isImportKind(r.kind)) continue;
    for (const k of ["priceAmount", "costAmount"] as const) {
      const v = r[k];
      if (v != null && !Number.isFinite(v)) r[k] = null;
    }
    if (r.qty != null && !Number.isFinite(r.qty)) r.qty = null;
    out.push(r);
  }
  return out;
}
