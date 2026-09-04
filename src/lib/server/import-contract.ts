/**
 * Radar interpretation of POST /v1/import/extract.
 * Does not change the Platform contract. Does not write a database.
 */
import {
  heuristicParse,
  isControlledImportText,
  isTrustedImportTable,
  tableToRows,
} from "../../../packages/harness-import/src/index.ts";
import type { ImportKind, ImportRow, ImportSource } from "@/lib/types";

export type ExtractOrigin =
  | "platform"
  | "trusted_template"
  | "controlled_text"
  | "local_fallback"
  | "engine_deterministic"
  | "engine_ai";
export type ExtractState =
  | "completed"
  | "needs_review"
  | "needs_mapping"
  | "agent_unavailable"
  | "vision_unavailable"
  | "invalid"
  | "invalid_input"
  | "unsupported"
  | "provider_unavailable"
  | "provider_error"
  | "platform_unavailable";

export type PlatformExtractRaw = {
  status: number;
  body: unknown | null;
  failureReason?: string;
};

export type ImportExtractResult = {
  rows: ImportRow[];
  usedAi: boolean;
  extractOrigin: ExtractOrigin | null;
  extractState: ExtractState;
  extractMessage: string | null;
  calledPlatform: boolean;
  aiAvailable?: boolean;
};

export type ImportExtractInput = {
  kind: ImportKind | "mixed";
  sourceType: ImportSource;
  text?: string;
  filename?: string;
  fileBase64?: string;
  mime?: string;
};

export type ImportExtractDeps = {
  readTable?: () => Promise<string[][] | null | undefined>;
  extractViaPlatform?: (input: ImportExtractInput) => Promise<PlatformExtractRaw>;
  runLocalImageFallback?: () => Promise<{ rows: Array<Partial<ImportRow> & { mpn: string }>; usedAi: boolean } | null>;
};

function nid(): string {
  return crypto.randomUUID();
}

function emptyRow(kind: ImportKind, mpn: string, extra: Partial<ImportRow> = {}): ImportRow {
  return {
    id: extra.id || nid(),
    kind: (extra.kind as ImportKind) || kind,
    mpn,
    brand: extra.brand ?? null,
    qty: extra.qty ?? null,
    qtyRaw: extra.qtyRaw ?? null,
    dateCode: extra.dateCode ?? null,
    priceAmount: extra.priceAmount ?? null,
    priceCurrency: extra.priceCurrency ?? null,
    priceTax: extra.priceTax ?? null,
    isTp: Boolean(extra.isTp),
    leadTimeText: extra.leadTimeText ?? null,
    etaText: extra.etaText ?? null,
    warehouse: extra.warehouse ?? null,
    channel: extra.channel ?? null,
    customer: extra.customer ?? null,
    package: extra.package ?? null,
    standardPack: extra.standardPack ?? null,
    packState: extra.packState ?? null,
    costAmount: extra.costAmount ?? null,
    costCurrency: extra.costCurrency ?? null,
    costTax: extra.costTax ?? null,
    note: extra.note ?? null,
    duplicate: extra.duplicate ?? false,
    duplicateReason: extra.duplicateReason ?? null,
    selected: extra.selected ?? true,
    warning: extra.warning ?? null,
  };
}

function fallbackKind(kind: ImportKind | "mixed"): ImportKind {
  return kind === "mixed" ? "offer" : kind;
}

function extractionKind(kind: ImportKind | "mixed") {
  return kind === "potential" ? "offer" : kind;
}

function candidateToRow(c: Record<string, unknown>, kind: ImportKind): ImportRow | null {
  const mpn = String(c.mpn || "").normalize("NFKC").trim();
  if (!mpn) return null;
  const rowKind = c.kind && c.kind !== "mixed" ? String(c.kind) : kind;
  const warnings = Array.isArray(c.warnings)
    ? (c.warnings as { message?: string }[]).map((w) => w.message).filter(Boolean).join("；")
    : null;
  return emptyRow(rowKind as ImportKind, mpn, {
    brand: (c.brand as string | null) ?? null,
    qty: typeof c.qty === "number" ? c.qty : null,
    qtyRaw: (c.qtyRaw as string | null) ?? null,
    dateCode: (c.dateCode as string | null) ?? null,
    priceAmount: typeof c.priceAmount === "number" ? c.priceAmount : null,
    priceCurrency: (c.priceCurrency as ImportRow["priceCurrency"]) ?? null,
    priceTax: (c.priceTax as ImportRow["priceTax"]) ?? null,
    isTp: Boolean(c.isTp),
    leadTimeText: (c.leadTimeText as string | null) ?? null,
    etaText: (c.etaText as string | null) ?? null,
    warehouse: (c.warehouse as string | null) ?? null,
    channel: (c.channel as string | null) ?? null,
    customer: (c.customer as string | null) ?? null,
    package: (c.package as string | null) ?? null,
    standardPack: (c.standardPack as string | null) ?? null,
    packState: (c.packState as ImportRow["packState"]) ?? null,
    costAmount: typeof c.costAmount === "number" ? c.costAmount : null,
    costCurrency: (c.costCurrency as ImportRow["costCurrency"]) ?? null,
    costTax: (c.costTax as ImportRow["costTax"]) ?? null,
    note: (c.note as string | null) ?? null,
    warning: warnings || null,
  });
}

export function interpretPlatformExtract(raw: PlatformExtractRaw): {
  state: ExtractState;
  rows: ImportRow[];
  usedAi: boolean;
  reason: string | null;
} {
  const fail = raw.failureReason;
  if (fail === "timeout" || fail === "network_error" || fail === "unauthorized" || fail === "server_error") {
    return { state: "platform_unavailable", rows: [], usedAi: false, reason: fail };
  }
  if (!raw.status || raw.status <= 0) {
    return { state: "platform_unavailable", rows: [], usedAi: false, reason: fail || "network_error" };
  }
  if (raw.status === 401 || raw.status === 403 || raw.status >= 500) {
    return { state: "platform_unavailable", rows: [], usedAi: false, reason: fail || "http_error" };
  }

  const body = raw.body && typeof raw.body === "object" ? (raw.body as Record<string, unknown>) : null;
  const error = String(body?.error || "");
  const reason = String(body?.reason || error || "");
  const needsAgent = Boolean(body?.needsAgent);
  const usedAi = Boolean(body?.usedAi);
  const candidates = Array.isArray(body?.candidates) ? (body.candidates as Record<string, unknown>[]) : [];
  const rows = candidates.map((c) => candidateToRow(c, "offer")).filter(Boolean) as ImportRow[];

  if (error === "vision_unavailable" || reason === "vision_unavailable") {
    return { state: "vision_unavailable", rows, usedAi, reason: "vision_unavailable" };
  }
  if (raw.status === 422 || error === "contract_error" || error === "invalid ImportRequest") {
    if (needsAgent && !rows.length) {
      return { state: "needs_mapping", rows: [], usedAi, reason: reason || "needsAgent" };
    }
    if (error === "agent_unavailable" || reason === "agent_unavailable") {
      return { state: "agent_unavailable", rows: [], usedAi, reason: "agent_unavailable" };
    }
    return { state: "invalid", rows: [], usedAi, reason: error || "invalid" };
  }
  if (rows.length > 0) {
    return { state: "completed", rows, usedAi, reason: reason || null };
  }
  const fallbackFrom = String(body?.fallbackFrom || "");
  if (error === "agent_unavailable" || reason === "agent_unavailable" || fallbackFrom === "agent_unavailable") {
    return { state: "agent_unavailable", rows: [], usedAi, reason: "agent_unavailable" };
  }
  if (needsAgent) {
    return { state: "needs_mapping", rows: [], usedAi, reason: reason || "needsAgent" };
  }
  return { state: "completed", rows: [], usedAi, reason: reason || null };
}

export { isControlledImportText, isTrustedImportTable };

function asPreviewRows(kind: ImportKind | "mixed", rows: ImportRow[]): ImportRow[] {
  const k = fallbackKind(kind);
  return rows.map((row) => ({ ...row, kind: row.kind || k }));
}

export async function resolveImportExtract(
  input: ImportExtractInput,
  deps: ImportExtractDeps = {},
): Promise<ImportExtractResult> {
  const kind = fallbackKind(input.kind);
  const table = deps.readTable ? await deps.readTable() : null;

  if ((input.sourceType === "excel" || input.sourceType === "csv") && isTrustedImportTable(table)) {
    return {
      rows: asPreviewRows(input.kind, tableToRows(table || [], extractionKind(input.kind))),
      usedAi: false,
      extractOrigin: "trusted_template",
      extractState: "completed",
      extractMessage: null,
      calledPlatform: false,
    };
  }

  if (input.sourceType === "text" && isControlledImportText(input.text)) {
    return {
      rows: asPreviewRows(input.kind, heuristicParse(input.text || "", extractionKind(input.kind))),
      usedAi: false,
      extractOrigin: "controlled_text",
      extractState: "completed",
      extractMessage: null,
      calledPlatform: false,
    };
  }

  const raw = deps.extractViaPlatform
    ? await deps.extractViaPlatform(input)
    : { status: 0, body: null, failureReason: "network_error" };
  const interp = interpretPlatformExtract(raw);
  const mapped = (interp.rows.length
    ? interp.rows.map((row) => candidateToRow(row as unknown as Record<string, unknown>, kind) || row)
    : interp.rows) as ImportRow[];

  if (interp.state === "completed" && mapped.length > 0) {
    return {
      rows: mapped,
      usedAi: interp.usedAi,
      extractOrigin: "platform",
      extractState: "completed",
      extractMessage: null,
      calledPlatform: true,
    };
  }

  if (interp.state === "needs_mapping") {
    return {
      rows: [],
      usedAi: false,
      extractOrigin: null,
      extractState: "needs_mapping",
      extractMessage: "需要智能列映射或语义抽取，未使用猜测表头。",
      calledPlatform: true,
    };
  }

  if (interp.state === "vision_unavailable") {
    const local = deps.runLocalImageFallback ? await deps.runLocalImageFallback() : null;
    if (local?.rows?.length) {
      return {
        rows: local.rows.map((row) => ("id" in row && row.mpn ? emptyRow(kind, row.mpn, row) : emptyRow(kind, String(row.mpn), row))),
        usedAi: true,
        extractOrigin: "local_fallback",
        extractState: "vision_unavailable",
        extractMessage: "Platform 视觉不可用，已用本地视觉降级。请人工核对。",
        calledPlatform: true,
      };
    }
    return {
      rows: [],
      usedAi: false,
      extractOrigin: null,
      extractState: "vision_unavailable",
      extractMessage: "当前无法识别图片（视觉不可用）。",
      calledPlatform: true,
    };
  }

  if (interp.state === "invalid") {
    return {
      rows: [],
      usedAi: false,
      extractOrigin: null,
      extractState: "invalid",
      extractMessage: "导入内容无法解析。",
      calledPlatform: true,
    };
  }

  if (interp.state === "agent_unavailable" || interp.state === "platform_unavailable") {
    if (input.sourceType === "image") {
      const local = deps.runLocalImageFallback ? await deps.runLocalImageFallback() : null;
      if (local?.rows?.length) {
        return {
          rows: local.rows.map((row) => emptyRow(kind, String(row.mpn), row)),
          usedAi: Boolean(local.usedAi),
          extractOrigin: "local_fallback",
          extractState: interp.state,
          extractMessage: "Platform 不可用，已用本地视觉降级。请人工核对。",
          calledPlatform: true,
        };
      }
    }
    if (input.sourceType === "text" && input.text && interp.state === "platform_unavailable") {
      const rows = heuristicParse(input.text, extractionKind(input.kind));
      if (rows.length) {
        return {
          rows: asPreviewRows(input.kind, rows),
          usedAi: false,
          extractOrigin: "local_fallback",
          extractState: "platform_unavailable",
          extractMessage: "Platform 不可用，已用本地文本降级。请人工核对。",
          calledPlatform: true,
        };
      }
    }
    return {
      rows: [],
      usedAi: false,
      extractOrigin: null,
      extractState: interp.state,
      extractMessage:
        interp.state === "agent_unavailable"
          ? "智能抽取暂不可用，未知表格/文本未使用猜测解析。"
          : "Platform 暂不可用，未知表格未使用猜测表头。",
      calledPlatform: true,
    };
  }

  return {
    rows: mapped,
    usedAi: interp.usedAi,
    extractOrigin: mapped.length ? "platform" : null,
    extractState: "completed",
    extractMessage: mapped.length ? null : "没有识别到型号",
    calledPlatform: true,
  };
}

export const EXTRACT_ORIGIN_LABEL: Record<ExtractOrigin, string> = {
  platform: "AI 识别（Platform）",
  trusted_template: "固定模板",
  controlled_text: "受控格式",
  local_fallback: "本地降级",
  engine_deterministic: "本地确定性识别",
  engine_ai: "OpenRouter AI 识别",
};
