/**
 * Adapter between the project-owned extraction engine and Radar's existing
 * preview/write contract. The engine only produces candidates; this adapter
 * deliberately keeps unresolved candidates unselected so confirmImport stays
 * the sole business-data write boundary.
 */
import {
  defaultImportProvider,
  extractImport,
  type CandidateRow,
  type ExtractRequest,
  type SourceType,
} from "../../../packages/import-engine/src/index.ts";
import type { ImportExtractInput, ImportExtractResult } from "./import-contract";
import type { ImportRow } from "@/lib/types";

function sourceTypeFor(value: ImportExtractInput["sourceType"]): SourceType {
  if (value === "word") return "docx";
  return value;
}

function candidateWarning(row: CandidateRow): string | null {
  const messages = [...row.issues];
  if (row.verification === "visual_only") messages.push("来自图片/扫描内容，型号需要人工核对");
  if (row.verification === "unverified") messages.push("型号没有可验证的原文定位");
  return [...new Set(messages)].join("；") || null;
}

function candidateToRadarRow(row: CandidateRow): ImportRow {
  const unresolvedKind = row.kind == null;
  return {
    id: row.id,
    // ImportRow is still the compatibility shape. A mixed value is a visible
    // placeholder only; selected=false prevents it from reaching the writer.
    kind: row.kind ?? "mixed",
    mpn: row.mpn as string,
    brand: row.brand,
    qty: row.qty,
    qtyRaw: row.qtyRaw,
    dateCode: row.dateCode,
    priceAmount: row.priceAmount,
    priceCurrency: row.priceCurrency,
    priceTax: row.priceTax,
    isTp: row.isTp,
    leadTimeText: row.leadTimeText,
    etaText: row.etaText,
    warehouse: row.warehouse,
    channel: row.channel,
    customer: row.customer,
    package: row.package,
    standardPack: row.standardPack,
    packState: row.packState,
    costAmount: row.costAmount,
    costCurrency: row.costCurrency,
    costTax: row.costTax,
    note: row.note,
    duplicate: false,
    duplicateReason: null,
    selected: !unresolvedKind && row.verification === "exact" && row.issues.length === 0,
    warning: candidateWarning(row),
  };
}

function modelMessage(result: Awaited<ReturnType<typeof extractImport>>): string | null {
  if (result.status === "provider_unavailable") return "当前未配置 OpenRouter，复杂输入无法交给模型识别。";
  if (result.status === "provider_error") return "模型识别失败，请稍后重试或改用文本/标准表格。";
  if (result.status === "needs_mapping") return "表格列名不明确，需要模型映射或人工确认。";
  if (result.status === "needs_review") return "部分候选缺少业务类型或型号证据，已阻止自动写入。";
  if (result.status === "unsupported") return result.issues[0]?.message ?? "文件类型不支持。";
  if (result.status === "invalid_input") return result.issues[0]?.message ?? "导入内容不合法。";
  return result.issues[0]?.message ?? null;
}

export async function resolveImportWithEngine(input: ImportExtractInput): Promise<ImportExtractResult> {
  const sourceType = sourceTypeFor(input.sourceType);
  const content = input.fileBase64
    ? Uint8Array.from(Buffer.from(input.fileBase64, "base64"))
    : input.text ?? "";
  const request: ExtractRequest = {
    kindHint: input.kind,
    source: {
      type: sourceType,
      filename: input.filename,
      mime: input.mime,
      content,
    },
  };
  const provider = defaultImportProvider();
  const result = await extractImport(request, provider);
  const rows = result.rows.map((row) => candidateToRadarRow(row));
  return {
    rows,
    usedAi: result.runs.some((run) => run.status === "completed"),
    aiAvailable: provider.available(),
    extractOrigin: result.runs.length > 0 ? "engine_ai" : "engine_deterministic",
    extractState: result.status,
    extractMessage: modelMessage(result),
    calledPlatform: false,
  };
}
