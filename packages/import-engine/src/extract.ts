import { createHash } from "node:crypto";
import { base64Of, bytesOf, extractDocx, extractPdfText, looksLikeDoc, looksLikeDocx, looksLikePdf, MAX_FILE_BYTES, MAX_OUTPUT_ROWS, MAX_PDF_PAGES, MAX_TABLE_ROWS, MAX_TEXT_CHARS, parseCsv, parseExcel, textOf } from "./files.ts";
import { exactSourceEvidence, normalizeRows, validateCandidateRows } from "./normalize.ts";
import { defaultImportProvider, parseJsonEnvelope } from "./provider.ts";
import { applyMapping, inferMapping, tableSummary } from "./table.ts";
import type { CandidateRow, ExtractRequest, ExtractionIssue, ExtractionProvider, ExtractionResult, ImportKindHint, TableDocument, TableMapping } from "./types.ts";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resultBase(requestId: string, sourceDigest: string, route: ExtractionResult["route"]): ExtractionResult {
  return { schemaVersion: "1", requestId, status: "completed", route, sourceDigest, rows: [], mappings: [], issues: [], runs: [] };
}

function issue(code: ExtractionIssue["code"], message: string): ExtractionIssue {
  return { code, message };
}

function looksLikeTextMpn(value: string): boolean {
  const token = value.normalize("NFKC").trim();
  if (token.length < 4 || !/[A-Za-z]/.test(token) || !/\d/.test(token)) return false;
  // Quantities such as 10K/2W and similar compact units are not MPNs.
  if (/^\d+(?:\.\d+)?[KMW]$/i.test(token)) return false;
  const uppercaseLetters = (token.match(/[A-Z]/g) ?? []).length;
  return uppercaseLetters >= 2 || /[-_.+/]/.test(token) || /^[A-Za-z]\d{3,}$/.test(token) || /^\d+[A-Z]\d/.test(token);
}

function findTextMpn(line: string): { value: string; index: number } | null {
  const tokens = line.matchAll(/[A-Za-z0-9][A-Za-z0-9._+/-]{3,64}/g);
  for (const match of tokens) {
    const value = match[0];
    if (value && looksLikeTextMpn(value)) return { value, index: match.index ?? 0 };
  }
  return null;
}

function safeRows(result: ExtractionResult, rows: CandidateRow[]): ExtractionResult {
  if (rows.length > MAX_OUTPUT_ROWS) result.issues.push(issue("too_many_rows", `候选结果超过 ${MAX_OUTPUT_ROWS} 行，已截断并需要复核`));
  const checked = validateCandidateRows(rows.slice(0, MAX_OUTPUT_ROWS));
  result.rows = checked.rows;
  result.issues.push(...checked.issues.map((x) => ({ code: x.code, message: x.message, rowId: x.rowId })));
  for (const row of result.rows) {
    if (row.verification === "visual_only") {
      result.issues.push({ code: "missing_evidence", message: "视觉识别候选必须人工核对", rowId: row.id });
    }
  }
  if (result.rows.length === 0) {
    if (!result.issues.length) result.issues.push(issue("missing_mpn", "没有识别到可写入的有效型号"));
    result.status = "needs_review";
  }
  else if (result.issues.length) result.status = "needs_review";
  return result;
}

function textRows(text: string, kindHint: ImportKindHint): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const match = findTextMpn(line);
    if (!match) continue;
    const mpn = match.value.normalize("NFKC").trim();
    const evidence = exactSourceEvidence(text, mpn);
    let rest = `${line.slice(0, match.index)} ${line.slice(match.index + match.value.length)}`;
    const qtyMatch = rest.match(/(?:^|\s)(\d+(?:\.\d+)?\s*(?:K|k|M|m|W|w|万)?)(?=\s|$)/);
    if (qtyMatch?.[1]) rest = rest.replace(qtyMatch[1], " ");
    const dateMatches = [...rest.matchAll(/(?<![\dA-Za-z])((?:20\d{2}|2[3-9]\d{2})\+|(?:20\d{2}|2[3-9]\d{2})(?=\s|$|[,，;；])|\d{2}\+)(?![A-Za-z])/gi)]
      .filter((match) => {
        const value = match[1] ?? "";
        if (value.endsWith("+")) return true;
        const end = (match.index ?? 0) + match[0].length;
        return !/^\d{4}$/.test(value) || !/^\s*(?:片|pcs?|包|盘|箱)/i.test(rest.slice(end));
      });
    let dateCode: string | null = null;
    if (dateMatches.length) {
      const first = dateMatches[0]!;
      const last = dateMatches[dateMatches.length - 1]!;
      const firstIndex = first.index ?? 0;
      const packagePrefix = rest.slice(0, firstIndex).match(/(\d+(?:\.\d+)?\s*(?:包|packs?)\s*)$/i)?.[1] ?? "";
      const start = firstIndex - packagePrefix.length;
      const end = (last.index ?? 0) + last[0].length;
      dateCode = rest.slice(start, end).trim() || null;
      rest = `${rest.slice(0, start)} ${rest.slice(end)}`;
    } else {
      const descriptiveDate = rest.match(/20\d{2}年(?:以后|之后)/);
      if (descriptiveDate?.[0]) {
        dateCode = descriptiveDate[0];
        rest = rest.replace(descriptiveDate[0], " ");
      }
    }
    const standardPack = rest.match(/(?:每\s*(?:包|盘|箱)?|per\s*(?:pack|tray|box))\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:片|pcs?)?/i)?.[1]?.replace(/,/g, "") ?? null;
    const price = rest.match(/(?:[$¥￥]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:元|USD|CNY)|\b\d+\.\d+\b)/i)?.[0] ?? "";
    const priceInfo = (awaitlessMoney(price));
    if (price) rest = rest.replace(price, " ");
    const leadMatch = rest.match(/现货|\d+\s*周|\d{1,2}[/.]\d{1,2}|\d+\s*月底|几天后/i);
    const leadTimeText = leadMatch?.[0] ?? null;
    if (leadMatch?.[0]) rest = rest.replace(leadMatch[0], " ");
    const kind = kindHint === "mixed"
      ? /客户|询价|求购/.test(line) ? "inquiry" : /在途|到货|月底到|交期/.test(line) ? "transit" : /入库|入仓/.test(line) ? "stock" : null
      : kindHint;
    const row = normalizeRows([{
      mpn, kind, qtyRaw: qtyMatch?.[1] ?? null, dateCode, standardPack, priceRaw: price || null,
      priceAmount: priceInfo.amount, priceCurrency: priceInfo.currency, priceTax: priceInfo.tax,
      isTp: /\bTP\b|目标价|待报价/.test(line), leadTimeText,
      warehouse: /香港|\bHK\b/i.test(line) ? "HK" : /坂田|板田/.test(line) ? "坂田" : null,
      channel: line.match(/渠道\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,30})/)?.[1] ?? null,
      customer: line.match(/客(?:户)?\s*([\u4e00-\u9fa5A-Za-z0-9_-]{2,30})/)?.[1] ?? null,
      note: line, evidence: { mpn: evidence },
    }], { kindHint, sourceText: text })[0];
    if (row) rows.push(row);
  }
  return rows;
}

function hasBusinessSignal(row: CandidateRow): boolean {
  return row.qty != null || row.priceAmount != null || row.dateCode != null || row.leadTimeText != null
    || row.etaText != null || row.warehouse != null || row.channel != null || row.customer != null || row.isTp;
}

function hasUnattachedTextContext(text: string, rows: CandidateRow[]): boolean {
  let remainder = text;
  for (const row of rows) if (row.mpn) remainder = remainder.split(row.mpn).join(" ");
  return /\d/.test(remainder)
    || /供应商|型号|数量|可供|库存|批次|价格|单价|报价|交期|货期|渠道|仓库|现货|supplier|vendor|item\s+code|available|stock|lot|price|delivery|warehouse|maker/i.test(remainder);
}

function awaitlessMoney(value: string): { amount: number | null; currency: "USD" | "CNY" | null; tax: null; isTp: boolean } {
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  const amount = match ? Number(match[0]) : null;
  return { amount: amount != null && Number.isFinite(amount) ? amount : null, currency: /\$|USD/i.test(value) ? "USD" : /¥|￥|CNY|元/i.test(value) ? "CNY" : null, tax: null, isTp: /TP/i.test(value) };
}

function mappingFromEnvelope(envelope: Record<string, unknown>): TableMapping[] {
  if (!Array.isArray(envelope.mappings)) return [];
  return envelope.mappings.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const headerRow = typeof item.headerRow === "number" && Number.isInteger(item.headerRow) ? item.headerRow : null;
    const dataStartRow = typeof item.dataStartRow === "number" && Number.isInteger(item.dataStartRow) ? item.dataStartRow : null;
    if (typeof item.sheet !== "string" || headerRow == null || dataStartRow == null || !item.columns || typeof item.columns !== "object") return [];
    const rawColumns = item.columns as Record<string, unknown>;
    const allowedFields = new Set([
      "mpn", "brand", "qty", "dateCode", "priceAmount", "leadTimeText", "warehouse", "channel", "customer", "package", "standardPack", "costAmount", "note",
    ]);
    const columns: TableMapping["columns"] = {};
    for (const [field, value] of Object.entries(rawColumns)) {
      if (!allowedFields.has(field)) return [];
      if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) return [];
      if (typeof value === "number") columns[field as keyof TableMapping["columns"]] = value;
    }
    return [{
      sheet: item.sheet,
      headerRow,
      dataStartRow,
      columns,
      unmappedHeaders: [],
      needsReview: Boolean(item.needsReview),
      reason: typeof item.reason === "string" ? item.reason : undefined,
    }];
  });
}

async function tableResult(
  request: ExtractRequest,
  table: TableDocument,
  provider: ExtractionProvider | undefined,
  result: ExtractionResult,
): Promise<ExtractionResult> {
  const localMappings = table.sheets.map(inferMapping);
  const needsModel = localMappings.some((mapping) => !mapping || mapping.needsReview);
  if (!needsModel) {
    result.mappings = localMappings.filter((x): x is TableMapping => Boolean(x));
    result.rows = table.sheets.flatMap((sheet) => {
      const mapping = result.mappings.find((candidate) => candidate.sheet === sheet.name);
      return mapping ? applyMapping(sheet, mapping, request.kindHint) : [];
    });
    return safeRows(result, result.rows);
  }
  if (!provider?.available()) {
    result.status = "provider_unavailable";
    result.issues.push(issue("provider_unavailable", "陌生表格需要智能列映射，但当前模型不可用"));
    result.mappings = localMappings.filter((x): x is TableMapping => Boolean(x));
    return result;
  }
  const started = Date.now();
  const response = await provider.extract({
    kindHint: request.kindHint,
    sourceType: request.source.type,
    filename: request.source.filename,
    userText: `业务类型提示: ${request.kindHint}\n请只返回每个工作表的列映射。headerRow、dataStartRow、columns中的所有数字索引都必须是从0开始的 zero-based 索引：第一行是0，第一列是0；严禁使用Excel/人类习惯的从1开始编号。columns只能使用这些规范字段：mpn, brand, qty, dateCode, priceAmount, leadTimeText, warehouse, channel, customer, package, standardPack, costAmount, note；没有对应列就返回null。不要返回行数据。\n${tableSummary(table)}`,
    responseKind: "mapping",
  });
  if (!response) {
    result.status = "provider_error";
    result.issues.push(issue("provider_error", "智能列映射失败"));
    result.runs.push({ provider: provider.name, model: provider.model, upstreamProvider: null, status: "failed", latencyMs: Date.now() - started, promptTokens: null, completionTokens: null, costUsd: null });
    return result;
  }
  result.runs.push({ provider: provider.name, model: response.model, upstreamProvider: response.upstreamProvider, status: "completed", latencyMs: Date.now() - started, promptTokens: response.promptTokens, completionTokens: response.completionTokens, costUsd: response.costUsd });
  const mappings = mappingFromEnvelope(parseJsonEnvelope(response.raw) ?? {});
  const checkedMappings = mappings.map((mapping) => {
    const sheet = table.sheets.find((candidate) => candidate.name === mapping.sheet);
    const maxColumns = sheet ? Math.max(0, ...sheet.rows.map((row) => row.length)) : 0;
    const invalid = !sheet
      || mapping.headerRow < 0
      || mapping.dataStartRow <= mapping.headerRow
      || mapping.headerRow >= sheet.rows.length
      || mapping.dataStartRow > sheet.rows.length
      || mapping.columns.mpn == null
      || Object.values(mapping.columns).some((column) => column != null && column >= maxColumns);
    return invalid
      ? { ...mapping, needsReview: true, reason: mapping.reason || "模型返回的列映射超出原表范围或缺少型号列" }
      : mapping;
  });
  result.mappings = checkedMappings;
  if (!checkedMappings.length) {
    result.status = "needs_mapping";
    result.issues.push(issue("ambiguous_mapping", "模型未返回可用列映射"));
    return result;
  }
  const missingSheetMapping = table.sheets.some((sheet) => sheet.rows.length > 1 && !checkedMappings.some((mapping) => mapping.sheet === sheet.name));
  const mappingNeedsReview = missingSheetMapping || checkedMappings.some((mapping) => mapping.needsReview);
  if (missingSheetMapping) result.issues.push(issue("ambiguous_mapping", "模型没有为每个有数据的工作表返回列映射"));
  const rows = table.sheets.flatMap((sheet) => {
    const mapping = checkedMappings.find((m) => m.sheet === sheet.name);
    return mapping ? applyMapping(sheet, mapping, request.kindHint) : [];
  });
  result.route = "model_mapping";
  result.status = mappingNeedsReview ? "needs_mapping" : "completed";
  if (mappingNeedsReview) {
    for (const row of rows) row.issues.push("表格列映射需要人工复核");
  }
  return safeRows(result, rows);
}

async function modelRows(request: ExtractRequest, provider: ExtractionProvider | undefined, text: string | undefined, fileBase64: string | undefined, visualOnly: boolean, result: ExtractionResult): Promise<ExtractionResult> {
  if (!provider?.available()) {
    result.status = "provider_unavailable";
    result.issues.push(issue("provider_unavailable", "复杂输入需要模型提取，但当前模型不可用"));
    return result;
  }
  const started = Date.now();
  const response = await provider.extract({
    kindHint: request.kindHint,
    sourceType: request.source.type,
    filename: request.source.filename,
    mime: request.source.mime,
    fileBase64,
    userText: `业务类型提示: ${request.kindHint}\n来源类型: ${request.source.type}\n${text ? `来源文本:\n${text.slice(0, MAX_TEXT_CHARS)}` : "请读取附件并提取候选行。"}`,
    responseKind: "rows",
  });
  if (!response) {
    result.status = "provider_error";
    result.issues.push(issue("provider_error", "模型提取失败"));
    result.runs.push({ provider: provider.name, model: provider.model, upstreamProvider: null, status: "failed", latencyMs: Date.now() - started, promptTokens: null, completionTokens: null, costUsd: null });
    return result;
  }
  result.route = "model_rows";
  result.runs.push({ provider: provider.name, model: response.model, upstreamProvider: response.upstreamProvider, status: "completed", latencyMs: Date.now() - started, promptTokens: response.promptTokens, completionTokens: response.completionTokens, costUsd: response.costUsd });
  const envelope = parseJsonEnvelope(response.raw);
  const raws = Array.isArray(envelope?.rows) ? envelope.rows.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object")) : [];
  return safeRows(result, normalizeRows(raws, { kindHint: request.kindHint, sourceText: text, visualOnly }));
}

export async function extractImport(request: ExtractRequest, provider: ExtractionProvider = defaultImportProvider()): Promise<ExtractionResult> {
  const requestId = request.requestId || crypto.randomUUID();
  const bytes = bytesOf(request.source.content);
  const result = resultBase(requestId, digest(bytes), "deterministic");
  if (bytes.length > MAX_FILE_BYTES) {
    result.status = "invalid_input";
    result.issues.push(issue("file_too_large", `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 限制`));
    return result;
  }
  if (request.source.type === "text") {
    const text = textOf(request.source.content);
    if (!text.trim()) { result.status = "invalid_input"; result.issues.push(issue("empty_input", "没有可识别的文本")); return result; }
    if (text.length > MAX_TEXT_CHARS) { result.status = "invalid_input"; result.issues.push(issue("file_too_large", "文本超过20万字符限制")); return result; }
    const deterministic = textRows(text, request.kindHint);
    const deterministicOnly = deterministic.length > 0
      && deterministic.every((row) => row.verification === "exact")
      && (deterministic.every(hasBusinessSignal) || !hasUnattachedTextContext(text, deterministic));
    if (deterministicOnly) return safeRows(result, deterministic);
    return modelRows(request, provider, text, undefined, false, result);
  }
  if (request.source.type === "csv" || request.source.type === "excel") {
    try {
      const table = request.source.type === "csv" ? parseCsv(textOf(request.source.content)) : await parseExcel(bytes);
      const totalRows = table.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
      if (totalRows > MAX_TABLE_ROWS) { result.status = "invalid_input"; result.issues.push(issue("too_many_rows", `表格超过 ${MAX_TABLE_ROWS} 行限制`)); return result; }
      return tableResult(request, table, provider, result);
    } catch {
      result.status = "invalid_input"; result.issues.push(issue("invalid_file", "表格文件无法解析")); return result;
    }
  }
  if (request.source.type === "docx") {
    if (looksLikeDoc(bytes)) { result.status = "unsupported"; result.issues.push(issue("unsupported_file", "老式 .doc 不支持，请另存为 .docx 或 PDF")); return result; }
    try {
      if (!looksLikeDocx(bytes)) { result.status = "invalid_input"; result.issues.push(issue("invalid_file", "文件不是有效 DOCX")); return result; }
      const text = await extractDocx(bytes);
      if (!text) { result.status = "needs_review"; result.issues.push(issue("empty_input", "DOCX 没有可提取文本")); return result; }
      return modelRows(request, provider, text, undefined, false, result);
    } catch {
      result.status = "invalid_input"; result.issues.push(issue("invalid_file", "DOCX 无法解析")); return result;
    }
  }
  if (request.source.type === "pdf") {
    try {
      if (!looksLikePdf(bytes)) { result.status = "invalid_input"; result.issues.push(issue("invalid_file", "文件不是有效 PDF")); return result; }
      const extracted = await extractPdfText(bytes);
      if (extracted && extracted.pageCount > MAX_PDF_PAGES) { result.status = "invalid_input"; result.issues.push(issue("too_many_pages", `PDF超过${MAX_PDF_PAGES}页限制`)); return result; }
      return modelRows(request, provider, extracted?.text, base64Of(bytes), !extracted?.text, result);
    } catch {
      result.status = "invalid_input"; result.issues.push(issue("invalid_file", "PDF无法解析")); return result;
    }
  }
  if (request.source.type === "image") {
    return modelRows(request, provider, undefined, base64Of(bytes), true, result);
  }
  result.status = "unsupported";
  result.issues.push(issue("unsupported_file", "不支持的输入类型"));
  return result;
}
