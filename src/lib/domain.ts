import type {
  CostTax,
  Currency,
  EtaPrecision,
  ImportKind,
  MatchFlags,
  PackState,
} from "./types";

/**
 * 型号雷达 · 业务内核（不可静默改 PRD）
 *
 * A. 型号主档 1 : N 事件（库存批次/流水、在途、渠道推货、客户询价、潜力）
 * B. 库存是资产流水：入/出/调/修/途→仓；禁止“改当前数量”
 * C. 在途不是仓库；途转入库是状态迁移，总敞口不变
 * D. 匹配 = 交叉命中，禁止用本条事件命中自己
 * E. 停用渠道/客户只把门闩上；重新启用不把历史无效记录批量恢复
 * F. 导入必须预览；型号字符只做 trim / 大小写 / NFKC，禁止 AI 改字
 */

export const DEFAULT_INQUIRY_WINDOW = 90;
export const DEFAULT_OFFER_WINDOW = 30;
export const DUPLICATE_OFFER_HOURS = 48;
export const DUPLICATE_INQUIRY_HOURS = 24;

export const PACK_STATE_LABEL: Record<PackState, string> = {
  full: "整包",
  loose: "散料",
  mixed: "混合",
};

export const MOVEMENT_LABEL: Record<string, string> = {
  in: "入",
  out: "出",
  transfer: "调",
  adjust: "修",
  transit_open: "途",
  transit_in: "途入",
};

export function normalizeMpn(raw: string): string {
  return raw.normalize("NFKC").trim().toUpperCase();
}

export function displayMpn(raw: string): string {
  return raw.normalize("NFKC").trim();
}

/** 语音/文本行业纠错。绝不改型号字符。 */
export function correctTradeText(raw: string): string {
  return raw
    .replace(/板田/g, "坂田")
    .replace(/香港仓/g, "HK")
    .replace(/HK仓/gi, "HK")
    .replace(/\bAOT\b/gi, "LT")
    .replace(/货期\s*[:=]?\s*AOT/gi, "货期 LT");
}

export function formatQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n));
  if (abs >= 1_000_000 && abs % 1_000_000 === 0) return `${sign}${abs / 1_000_000}M`;
  if (abs >= 1000 && abs % 1000 === 0) return `${sign}${abs / 1000}K`;
  if (abs >= 1000 && abs % 100 === 0) {
    const k = abs / 1000;
    const s = k.toFixed(1).replace(/\.0$/, "");
    return `${sign}${s}K`;
  }
  return `${sign}${abs.toLocaleString("zh-CN")}`;
}

export function parseQty(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = raw.normalize("NFKC").trim().replace(/,/g, "").replace(/\s+/g, "");
  if (!s) return null;
  s = s.replace(/[片个只颗PCS|EA|pcs]+$/i, "");
  const m = s.match(/^([+-]?)(\d+(?:\.\d+)?)(万|W|K|M)?$/i);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[3] || "").toUpperCase();
  let qty = n;
  if (unit === "K") qty = n * 1000;
  else if (unit === "万" || unit === "W") qty = n * 10000;
  else if (unit === "M") qty = n * 1_000_000;
  return sign * Math.round(qty);
}

function trimNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatCost(
  amount: number | string | null | undefined,
  currency?: string | null,
  tax?: string | null,
): string {
  if (amount == null || amount === "") return "";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "";
  const body = trimNum(n);
  if (currency === "USD") return `$${body}`;
  if (currency === "CNY" && tax === "exclusive") return `¥${body}⁻`;
  if (currency === "CNY" && tax === "inclusive") return `¥${body}⁺`;
  if (currency === "CNY") return `¥${body}`;
  return body;
}

export function parseCost(raw: string | null | undefined): {
  amount: number | null;
  currency: Currency | null;
  tax: CostTax | null;
  isTp: boolean;
} {
  if (!raw) return { amount: null, currency: null, tax: null, isTp: false };
  const s = raw.normalize("NFKC").trim();
  if (!s) return { amount: null, currency: null, tax: null, isTp: false };
  if (/^(TP|目标价|请报价|报TP)$/i.test(s)) {
    return { amount: null, currency: null, tax: null, isTp: true };
  }
  let tax: CostTax | null = null;
  let t = s;
  if (t.includes("⁻") || /未税/.test(t)) tax = "exclusive";
  if (t.includes("⁺") || /含税/.test(t)) tax = "inclusive";
  t = t.replace(/[⁻⁺]|未税|含税/g, "");
  let currency: Currency | null = null;
  if (/[$＄USD|美金|美元]/i.test(t)) currency = "USD";
  if (/[¥￥RMB|CNY|人民币]/i.test(t)) currency = "CNY";
  const num = t.replace(/[^0-9.+-]/g, "");
  const amount = num ? Number(num) : null;
  if (currency === "USD") tax = tax ?? "none";
  if (currency === "CNY" && !tax) tax = "exclusive";
  return {
    amount: amount != null && Number.isFinite(amount) ? amount : null,
    currency,
    tax,
    isTp: false,
  };
}

export function parseLeadTime(
  text: string,
  now = new Date(),
): {
  etaDate: string | null;
  precision: EtaPrecision;
  original: string;
} {
  const original = text.trim();
  const s = original.normalize("NFKC");
  if (!s) return { etaDate: null, precision: "fuzzy", original };
  if (/现货|当天|即有|stock/i.test(s)) {
    return { etaDate: isoDate(now), precision: "stock", original };
  }
  const md = s.match(/(?:^|[^\d])(\d{1,2})[\/.\-月](\d{1,2})日?/);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    const d = new Date(now);
    d.setMonth(month - 1, day);
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return { etaDate: isoDate(d), precision: "date", original };
  }
  const weeks = s.match(/(\d+(?:\.\d+)?)\s*周/);
  if (weeks) {
    const d = new Date(now);
    d.setDate(d.getDate() + Math.round(Number(weeks[1]) * 7));
    return { etaDate: isoDate(d), precision: "week", original };
  }
  if (/月底/.test(s)) {
    const monthHit = s.match(/(\d{1,2})\s*月底/);
    const d = new Date(now);
    if (monthHit) {
      d.setMonth(Number(monthHit[1]) - 1, 1);
      d.setMonth(d.getMonth() + 1, 0);
      if (d < now) d.setFullYear(d.getFullYear() + 1);
    } else {
      d.setMonth(d.getMonth() + 1, 0);
    }
    return { etaDate: isoDate(d), precision: "month", original };
  }
  if (/几天|数天|近期/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 3);
    return { etaDate: isoDate(d), precision: "fuzzy", original };
  }
  return { etaDate: null, precision: "fuzzy", original };
}

export function formatEtaLabel(opts: {
  etaDate?: string | null;
  etaText?: string | null;
  precision?: EtaPrecision | null;
}): string | null {
  if (!opts.etaDate && !opts.etaText) return null;
  if (opts.precision === "date" && opts.etaDate) return formatMd(opts.etaDate);
  if (opts.etaText) return opts.etaText.replace(/^LT\s*/i, "LT ");
  if (opts.etaDate) return `约 ${formatMd(opts.etaDate)}`;
  return null;
}

export function formatMd(iso: string): string {
  const d = iso.slice(0, 10);
  const [, m, day] = d.split("-");
  return `${Number(m)}/${Number(day)}`;
}

export function formatWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}小时前`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}天前`;
  return formatMd(iso);
}

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const WH_ALIASES: Record<string, string> = {
  香港: "HK",
  香港仓: "HK",
  hk: "HK",
  HK: "HK",
  HK仓: "HK",
  板田: "坂田",
  坂田: "坂田",
  坂田仓: "坂田",
  交通: "交通",
  交通仓: "交通",
  交通银行: "交通",
};

export function resolveWarehouseCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize("NFKC").trim();
  if (!s) return null;
  return WH_ALIASES[s] ?? WH_ALIASES[s.toUpperCase()] ?? s;
}

export function brandShort(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize("NFKC").trim();
  if (!s) return null;
  const map: Record<string, string> = {
    "TEXAS INSTRUMENTS": "TI",
    德州仪器: "TI",
    意法: "ST",
    STMicroelectronics: "ST",
    恩智浦: "NXP",
    亚德诺: "ADI",
    "Analog Devices": "ADI",
    乐鑫: "Espressif",
    微芯: "Microchip",
    华邦: "Winbond",
    安森美: "ON",
    英飞凌: "Infineon",
  };
  return map[s] ?? map[s.toUpperCase()] ?? s;
}

export function formatStockLine(
  byWarehouse: { code: string; qty: number }[],
  transitQty: number,
  transitEta?: string | null,
): string {
  const bits = byWarehouse
    .filter((w) => w.qty > 0)
    .map((w) => `${w.code} ${formatQty(w.qty)}`);
  if (transitQty > 0) {
    bits.push(`途 ${formatQty(transitQty)}`);
    if (transitEta) bits.push(transitEta);
  }
  return bits.join(" · ") || "无库存";
}

export function isMatchableOffer(opts: {
  isValid: boolean;
  deleted: boolean;
  channelActive: boolean;
  offeredAt: string;
  windowDays: number;
}): boolean {
  if (opts.deleted || !opts.isValid || !opts.channelActive) return false;
  return withinDays(opts.offeredAt, opts.windowDays);
}

export function isMatchableInquiry(opts: {
  isValid: boolean;
  deleted: boolean;
  customerActive: boolean;
  inquiredAt: string;
  windowDays: number;
}): boolean {
  if (opts.deleted || !opts.isValid || !opts.customerActive) return false;
  return withinDays(opts.inquiredAt, opts.windowDays);
}

export function withinDays(iso: string, days: number): boolean {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= days * 86400000;
}

/**
 * 交叉命中：本条事件不能命中自己。
 * - 新推货 → 库/途/客/潜
 * - 新询价 → 库/途/渠/潜
 * - 库存变化 → 客/渠/潜
 */
export function isCrossHit(
  f: Pick<MatchFlags, "stock" | "transit" | "inquiryCount" | "offerCount" | "watch">,
  trigger: ImportKind | "any" = "any",
): boolean {
  const mine = f.stock || f.transit;
  const demand = f.inquiryCount > 0;
  const channel = f.offerCount > 0;
  if (trigger === "offer") return mine || demand || f.watch;
  if (trigger === "inquiry") return mine || channel || f.watch;
  if (trigger === "stock" || trigger === "transit") return demand || channel || f.watch;
  return (
    (f.stock && demand) ||
    (f.stock && channel) ||
    (f.transit && demand) ||
    (f.transit && channel) ||
    (demand && channel) ||
    (f.watch && (mine || demand || channel))
  );
}

export function finalizeMatchFlags(f: MatchFlags): MatchFlags {
  f.stock = f.onHand > 0;
  f.transit = f.inTransit > 0;
  f.isDual = f.stock && f.inquiryCount > 0;
  f.isHit = isCrossHit(f, "any");
  return f;
}

export function hitText(f: MatchFlags): string {
  const bits: string[] = [];
  if (f.stock) bits.push("库");
  if (f.transit) bits.push("途");
  if (f.inquiryCount > 0) bits.push(`客${f.inquiryCount}`);
  if (f.watch) bits.push("潜");
  return bits.join(" · ");
}

export function sampleImportText(): string {
  return [
    "TPS7A4700RGWR  20K  24+  TP  LT 4周",
    "STM32F103C8T6  10K  2418  $1.15  现货",
    "NRF52840-QIAA  5K   8月底到",
    "ESP32-WROOM-32E  8K  客 瀚博微",
  ].join("\n");
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function iso(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return String(v);
}

export function formatMovementLine(m: {
  type: string;
  qty: number;
  happenedAt: string;
  fromWarehouseCode?: string | null;
  toWarehouseCode?: string | null;
}): string {
  const d = formatMd(m.happenedAt);
  const q = formatQty(m.qty);
  switch (m.type) {
    case "in":
      return `${d} +${q} ${m.toWarehouseCode ?? ""}`.trim();
    case "out":
      return `${d} -${q} ${m.fromWarehouseCode ?? ""}`.trim();
    case "transfer":
      return `${d} 调 ${q} ${m.fromWarehouseCode ?? ""}→${m.toWarehouseCode ?? ""}`;
    case "adjust":
      return `${d} 修 ${m.fromWarehouseCode ? "-" : "+"}${q} ${m.fromWarehouseCode ?? m.toWarehouseCode ?? ""}`.trim();
    case "transit_open":
      return `${d} 途 +${q}`;
    case "transit_in":
      return `${d} 途→${m.toWarehouseCode ?? ""} ${q}`;
    default:
      return `${d} ${m.type} ${q}`;
  }
}

export function formatOfferLine(o: {
  qty?: number | null;
  dateCode?: string | null;
  isTp: boolean;
  priceAmount?: number | null;
  priceCurrency?: string | null;
  priceTax?: string | null;
  leadTimeText?: string | null;
}): string {
  const bits: string[] = [];
  if (o.qty != null) bits.push(formatQty(o.qty));
  if (o.dateCode) bits.push(o.dateCode);
  if (o.isTp) bits.push("TP");
  else {
    const c = formatCost(o.priceAmount ?? null, o.priceCurrency, o.priceTax);
    if (c) bits.push(c);
  }
  if (o.leadTimeText) bits.push(o.leadTimeText.replace(/^LT\s*/i, "LT "));
  return bits.join(" · ");
}
