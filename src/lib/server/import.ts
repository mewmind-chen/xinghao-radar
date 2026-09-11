/**
 * Import Service —— 预览数据组装 / 重复检测 / 确认写库。
 *
 * 先把来源抽成与业务目标无关的候选行，再由 prepareImportReview 绑定用户
 * 选择的业务类型并计算类型查重。confirmImport 仍是唯一写库入口。
 */

import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  ForbiddenError,
  getCurrentPrincipal,
  potentialScopeFor,
  requireImportKind,
} from "@/lib/auth/authorization.server";
import {
  DUPLICATE_INQUIRY_HOURS,
  DUPLICATE_OFFER_HOURS,
  brandShort,
  correctTradeText,
  formatStockLine,
  isCrossHit,
  normalizeMpn,
  parseLeadTime,
} from "@/lib/domain";
import type { ImportKind, ImportRow, ImportSource } from "@/lib/types";
import type { CostTax, Currency } from "@/lib/types";
import { defaultProviders, runImportAgent } from "@harness/index";
import { parseCsv } from "@harness/plugins/csv-parser";
import { parseExcel } from "@harness/plugins/excel-parser";
import { resolveImportExtract } from "./import-contract";
import { resolveImportWithEngine } from "./import-engine-adapter";
import {
  ensureChannel,
  ensureCustomer,
  ensurePart,
  listWarehouses,
  matchFlagsForParts,
  nid,
  sqlClient,
  logOp,
  withTransaction,
} from "./helpers";
import { ensureSeed } from "./seed";
import { resolveDateCode } from "@/lib/inventory/date-code";
import { sameNullableNumber } from "@/lib/import-duplicate";
import { inquiryReviewBlockingReason, isCompositeMpn } from "@/lib/import-review";

const IMPORT_KINDS = ["offer", "inquiry", "stock", "transit", "potential", "mixed"] as const;
const IMPORT_PARSE_KINDS = [...IMPORT_KINDS, "neutral"] as const;
const IMPORT_SOURCES = ["excel", "csv", "pdf", "word", "image", "text"] as const;
const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_TEXT_CHARS = 200_000;

export type ParseImportInput = {
  /** `neutral` is extraction-only; a write target is selected after preview. */
  kind: ImportKind | "neutral";
  sourceType: ImportSource;
  text?: string;
  filename?: string;
  fileBase64?: string;
  mime?: string;
  defaultWarehouseId?: string;
  defaultSupplier?: string;
  defaultCurrency?: Currency;
  defaultTax?: CostTax;
};

export type PrepareImportReviewInput = {
  kind: ImportKind;
  defaultChannel?: string;
  defaultCustomer?: string;
  defaultWarehouseId?: string;
  defaultSupplier?: string;
  defaultCurrency?: Currency;
  defaultTax?: CostTax;
  rows: ImportRow[];
};

type ConfirmImportInput = {
  kind: ImportKind;
  sourceType: ImportSource;
  filename?: string;
  excerpt?: string;
  defaultChannel?: string;
  defaultCustomer?: string;
  defaultWarehouseId?: string;
  defaultSupplier?: string;
  defaultCurrency?: Currency;
  defaultTax?: CostTax;
  rows: ImportRow[];
  submissionId?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("导入请求格式无效");
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${field}格式无效`);
  return value;
}

function optionalEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`${field}格式无效`);
  return value as T;
}

function validateFileBase64(value: unknown): string | undefined {
  const encoded = optionalString(value, "文件", Math.ceil(MAX_IMPORT_FILE_BYTES / 3) * 4 + 16);
  if (!encoded) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("文件编码无效");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
  if (bytes > MAX_IMPORT_FILE_BYTES) throw new Error("文件超过 20MB 限制");
  return encoded;
}

function validateParseImportInput(input: unknown): ParseImportInput {
  const value = record(input);
  const kind = optionalEnum(value.kind, IMPORT_PARSE_KINDS, "业务类型");
  const sourceType = optionalEnum(value.sourceType, IMPORT_SOURCES, "来源类型");
  if (!kind || !sourceType) throw new Error("缺少业务类型或来源类型");
  const text = optionalString(value.text, "文本", MAX_IMPORT_TEXT_CHARS);
  return {
    kind,
    sourceType,
    text,
    filename: optionalString(value.filename, "文件名", 255),
    fileBase64: validateFileBase64(value.fileBase64),
    mime: optionalString(value.mime, "文件类型", 150),
    defaultWarehouseId: optionalString(value.defaultWarehouseId, "默认仓库", 200),
    defaultSupplier: optionalString(value.defaultSupplier, "默认供应商", 200),
    defaultCurrency: optionalEnum(value.defaultCurrency, ["USD", "CNY"], "默认币种"),
    defaultTax: optionalEnum(value.defaultTax, ["none", "exclusive", "inclusive"], "默认税别"),
  };
}

function validatePrepareImportReviewInput(input: unknown): PrepareImportReviewInput {
  const value = record(input);
  const kind = optionalEnum(value.kind, IMPORT_KINDS, "业务类型");
  if (!kind) throw new Error("缺少业务类型");
  return {
    kind,
    defaultChannel: optionalString(value.defaultChannel, "默认渠道", 200),
    defaultCustomer: optionalString(value.defaultCustomer, "默认客户", 200),
    defaultWarehouseId: optionalString(value.defaultWarehouseId, "默认仓库", 200),
    defaultSupplier: optionalString(value.defaultSupplier, "默认供应商", 200),
    defaultCurrency: optionalEnum(value.defaultCurrency, ["USD", "CNY"], "默认币种"),
    defaultTax: optionalEnum(value.defaultTax, ["none", "exclusive", "inclusive"], "默认税别"),
    rows: validateImportRows(value.rows),
  };
}

function validateImportRows(rows: unknown): ImportRow[] {
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error("导入行数无效");
  const stringFields = [
    "id",
    "mpn",
    "brand",
    "qtyRaw",
    "dateCode",
    "leadTimeText",
    "etaText",
    "warehouse",
    "channel",
    "customer",
    "package",
    "standardPack",
    "note",
    "duplicateReason",
    "warning",
    "brandConflict",
  ];
  return rows.map((raw, index) => {
    const row = record(raw);
    if (
      typeof row.id !== "string" ||
      row.id.length > 200 ||
      typeof row.mpn !== "string" ||
      row.mpn.length > 200
    ) {
      throw new Error(`第 ${index + 1} 行型号格式无效`);
    }
    if (typeof row.kind !== "string" || !IMPORT_KINDS.includes(row.kind as ImportKind))
      throw new Error(`第 ${index + 1} 行业务类型无效`);
    for (const field of stringFields) {
      const fieldValue = row[field];
      if (fieldValue != null && typeof fieldValue !== "string")
        throw new Error(`第 ${index + 1} 行字段格式无效`);
      if (typeof fieldValue === "string" && fieldValue.length > 2000)
        throw new Error(`第 ${index + 1} 行文本过长`);
    }
    for (const field of [
      "qty",
      "priceAmount",
      "priceCurrency",
      "priceTax",
      "costAmount",
      "costCurrency",
      "costTax",
    ] as const) {
      const fieldValue = row[field];
      if (
        fieldValue != null &&
        fieldValue !== "" &&
        (field.endsWith("Amount") || field === "qty") &&
        (typeof fieldValue !== "number" || !Number.isFinite(fieldValue))
      ) {
        throw new Error(`第 ${index + 1} 行数值格式无效`);
      }
    }
    for (const [field, values] of [
      ["priceCurrency", ["USD", "CNY"]],
      ["costCurrency", ["USD", "CNY"]],
      ["priceTax", ["none", "exclusive", "inclusive"]],
      ["costTax", ["none", "exclusive", "inclusive"]],
      ["packState", ["full", "loose", "mixed"]],
    ] as const) {
      const fieldValue = row[field];
      if (fieldValue != null && !values.includes(fieldValue as never))
        throw new Error(`第 ${index + 1} 行枚举字段无效`);
    }
    for (const field of ["selected", "duplicate", "isTp"] as const) {
      if (typeof row[field] !== "boolean") throw new Error(`第 ${index + 1} 行状态格式无效`);
    }
    return row as unknown as ImportRow;
  });
}

function validateConfirmImportInput(input: unknown): ConfirmImportInput {
  const value = record(input);
  const kind = optionalEnum(value.kind, IMPORT_KINDS, "业务类型");
  const sourceType = optionalEnum(value.sourceType, IMPORT_SOURCES, "来源类型");
  if (!kind || !sourceType) throw new Error("缺少业务类型或来源类型");
  return {
    kind,
    sourceType,
    filename: optionalString(value.filename, "文件名", 255),
    excerpt: optionalString(value.excerpt, "摘要", 500),
    defaultChannel: optionalString(value.defaultChannel, "默认渠道", 200),
    defaultCustomer: optionalString(value.defaultCustomer, "默认客户", 200),
    defaultWarehouseId: optionalString(value.defaultWarehouseId, "默认仓库", 200),
    defaultSupplier: optionalString(value.defaultSupplier, "默认供应商", 200),
    defaultCurrency: optionalEnum(value.defaultCurrency, ["USD", "CNY"], "默认币种"),
    defaultTax: optionalEnum(value.defaultTax, ["none", "exclusive", "inclusive"], "默认税别"),
    rows: validateImportRows(value.rows),
    submissionId: optionalString(value.submissionId, "幂等键", 200),
  };
}

function appendWarning(row: ImportRow, warning: string) {
  row.warning = [...new Set([row.warning, warning].filter(Boolean))].join("；") || null;
  row.selected = false;
}

async function annotateImportReviewRows(
  sql: Awaited<ReturnType<typeof sqlClient>>,
  rows: ImportRow[],
) {
  for (const row of rows) {
    if (isCompositeMpn(row.mpn)) {
      appendWarning(row, "型号包含多个候选，请拆分为一行一个型号");
    }
    if (!row.brand?.trim() || !normalizeMpn(row.mpn)) continue;
    const existing =
      await sql`select brand_code from parts where mpn_key = ${normalizeMpn(row.mpn)} limit 1`;
    const existingBrandRaw = String(existing[0]?.brand_code ?? "").trim();
    const importedBrandRaw = row.brand.trim();
    const existingBrand = brandShort(existingBrandRaw)?.trim().toUpperCase() ?? "";
    const importedBrand = brandShort(importedBrandRaw)?.trim().toUpperCase() ?? "";
    if (existingBrand && importedBrand && existingBrand !== importedBrand) {
      row.brandConflict = `主档品牌 ${existingBrandRaw} 与导入品牌 ${importedBrandRaw} 冲突`;
      appendWarning(row, row.brandConflict);
    }
  }
}

function normalizeImportDateCodes(rows: ImportRow[]): ImportRow[] {
  const output: ImportRow[] = [];
  for (const row of rows) {
    const resolved = resolveDateCode(row.dateCode, row.qty, row.standardPack);
    if (resolved.splits.length > 1) {
      for (const split of resolved.splits) {
        output.push({
          ...row,
          id: nid(),
          qty: split.qty,
          qtyRaw: String(split.qty),
          dateCode: split.dateCode,
          selected: row.selected,
          warning: "已按包数 × 标准装量拆分 DC，请确认",
        });
      }
      continue;
    }
    if (row.dateCode && !resolved.dateCode) appendWarning(row, resolved.warning || "DC 无法确认");
    output.push({ ...row, dateCode: resolved.dateCode });
  }
  return output;
}

function effectiveImportKind(row: ImportRow, selectedKind: ImportKind): ImportKind {
  // A user-selected import target is authoritative.  Only the explicit
  // mixed mode may use the row-level kind returned by an extractor.
  return selectedKind === "mixed" ? row.kind : selectedKind;
}

function requireImportRecognition(principal: Awaited<ReturnType<typeof getCurrentPrincipal>>) {
  if (
    principal.permissions.includes("inventory.import") ||
    principal.permissions.includes("market.write") ||
    principal.permissions.includes("potential.write")
  ) {
    return principal;
  }
  throw new ForbiddenError("无权使用导入识别");
}

function stripKindSelectionWarning(warning: string | null): string | null {
  return (
    warning
      ?.split("；")
      .filter(
        (message) =>
          !message.includes("业务类型无法确定") && !message.includes("业务类型已人工修改"),
      )
      .join("；") || null
  );
}

function rowsForImportReview(
  rows: ImportRow[],
  selectedKind: ImportKind,
  defaultCustomer?: string,
): ImportRow[] {
  return rows.map((row) => {
    const warning = stripKindSelectionWarning(row.warning);
    const wasNeutral = row.kind === "mixed";
    const targetKind = selectedKind === "mixed" ? row.kind : selectedKind;
    const eligible =
      targetKind === "inquiry"
        ? !inquiryReviewBlockingReason({ ...row, warning }, defaultCustomer)
        : targetKind !== "mixed" && Boolean(row.mpn.trim()) && !warning && !row.brandConflict;
    return {
      ...row,
      ...(targetKind === "inquiry" ? { costAmount: null, costCurrency: null, costTax: null } : {}),
      kind: targetKind,
      warning,
      duplicate: false,
      duplicateReason: null,
      // A fresh extraction is only “待确认”; a checkbox is an explicit user
      // confirmation and must never be inferred from the extractor output.
      selected: selectedKind === "mixed" ? false : wasNeutral ? false : row.selected && eligible,
    };
  });
}

async function importLookups(sql: Awaited<ReturnType<typeof sqlClient>>) {
  const warehouses = await listWarehouses(sql);
  const channels = await sql`select id, name from channels where is_active = true order by name`;
  const customers = await sql`select id, name from customers order by name`;
  return {
    warehouses,
    channels: channels.map((r) => ({ id: String(r.id), name: String(r.name) })),
    customers: customers.map((r) => ({ id: String(r.id), name: String(r.name) })),
  };
}

const DUPLICATE_STOCK_DAYS = 90;

function flagIntraFileDuplicates(
  rows: ImportRow[],
  selectedKind: ImportKind,
  defaults?: { warehouseId?: string; supplier?: string; channel?: string; customer?: string },
) {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const rowKind = effectiveImportKind(row, selectedKind);
    const k = [
      rowKind,
      normalizeMpn(row.mpn),
      row.qty ?? "",
      row.dateCode ?? "",
      rowKind === "stock"
        ? (row.channel ?? defaults?.supplier ?? "")
        : (row.channel ?? defaults?.channel ?? ""),
      rowKind === "inquiry" ? (row.customer ?? defaults?.customer ?? "") : (row.customer ?? ""),
      row.warehouse ?? defaults?.warehouseId ?? "",
      row.isTp ? "tp" : (row.priceAmount ?? ""),
    ].join("|");
    if (seen.has(k)) {
      row.duplicate = true;
      row.duplicateReason = "本表内重复行";
      row.selected = false;
    } else {
      seen.set(k, 1);
    }
  }
}

async function markDuplicates(
  sql: Awaited<ReturnType<typeof sqlClient>>,
  rows: ImportRow[],
  selectedKind: ImportKind,
  defaultWarehouseId?: string,
  defaultSupplier?: string,
  potentialUserId?: string,
  defaultChannel?: string,
  defaultCustomer?: string,
  defaultCurrency?: Currency,
  defaultTax?: CostTax,
) {
  flagIntraFileDuplicates(rows, selectedKind, {
    warehouseId: defaultWarehouseId,
    supplier: defaultSupplier,
    channel: defaultChannel,
    customer: defaultCustomer,
  });
  const keys = [...new Set(rows.map((row) => normalizeMpn(row.mpn)).filter(Boolean))];
  const parts = keys.length
    ? await sql.query<{ id: string; mpn_key: string }>(
        `select id, mpn_key from parts where mpn_key in (${keys.map((_, index) => `$${index + 1}`).join(",")})`,
        keys,
      )
    : [];
  const partByKey = new Map(parts.map((row) => [String(row.mpn_key), String(row.id)]));
  const partIds = [...partByKey.values()];
  const placeholders = partIds.map((_, index) => `$${index + 1}`).join(",");
  const existingLots = partIds.length
    ? await sql.query<Record<string, unknown>>(
        `select l.part_id, l.qty_in, l.date_code, l.cost_amount, l.cost_currency, l.cost_tax,
            w.id as warehouse_id, w.code as warehouse_code, ch.name as supplier_name
         from stock_lots l left join warehouses w on w.id = l.warehouse_id left join channels ch on ch.id = l.supplier_id
         where l.part_id in (${placeholders}) and l.deleted_at is null and l.status in ('on_hand','in_transit')
           and l.inbound_at >= now() - (${DUPLICATE_STOCK_DAYS} || ' days')::interval`,
        partIds,
      )
    : [];
  const existingOffers = partIds.length
    ? await sql.query<Record<string, unknown>>(
        `select o.part_id, o.qty, o.date_code, o.price_amount, o.is_tp, ch.name as channel_name
         from channel_offers o join channels ch on ch.id = o.channel_id
         where o.part_id in (${placeholders}) and o.deleted_at is null
           and o.offered_at >= now() - (${DUPLICATE_OFFER_HOURS} || ' hours')::interval`,
        partIds,
      )
    : [];
  const existingInquiries = partIds.length
    ? await sql.query<Record<string, unknown>>(
        `select i.part_id, i.qty, c.name as customer_name
         from customer_inquiries i join customers c on c.id = i.customer_id
         where i.part_id in (${placeholders}) and i.deleted_at is null
           and i.inquired_at >= now() - (${DUPLICATE_INQUIRY_HOURS} || ' hours')::interval`,
        partIds,
      )
    : [];
  const followed =
    potentialUserId && partIds.length
      ? await sql.query<{ part_id: string }>(
          `select part_id from potential_models where user_id = $${partIds.length + 1} and part_id in (${placeholders})`,
          [...partIds, potentialUserId],
        )
      : [];
  const followedSet = new Set(followed.map((row) => String(row.part_id)));
  const sameName = (a: unknown, b: unknown) =>
    String(a ?? "")
      .trim()
      .toLowerCase() ===
    String(b ?? "")
      .trim()
      .toLowerCase();
  for (const row of rows) {
    if (row.duplicate) continue;
    const partId = partByKey.get(normalizeMpn(row.mpn));
    if (!partId) continue;
    const kind = effectiveImportKind(row, selectedKind);
    if (kind === "stock") {
      const warehouse = row.warehouse ?? defaultWarehouseId ?? "";
      const supplierName = row.channel ?? defaultSupplier ?? "";
      const cost = row.costAmount;
      const currency = cost == null ? null : (row.costCurrency ?? defaultCurrency ?? null);
      const tax = cost == null ? null : (row.costTax ?? defaultTax ?? null);
      const hit = existingLots.some(
        (lot) =>
          String(lot.part_id) === partId &&
          sameNullableNumber(lot.qty_in ?? 0, row.qty ?? 0) &&
          String(lot.date_code ?? "") === String(row.dateCode ?? "") &&
          sameNullableNumber(lot.cost_amount ?? -1, cost ?? -1) &&
          String(lot.cost_currency ?? "") === String(currency ?? "") &&
          String(lot.cost_tax ?? "") === String(tax ?? "") &&
          (!warehouse ||
            String(lot.warehouse_id ?? "") === warehouse ||
            String(lot.warehouse_code ?? "") === warehouse) &&
          (!supplierName || sameName(lot.supplier_name, supplierName)),
      );
      if (hit) {
        row.duplicate = true;
        row.duplicateReason =
          "疑似重复：相同型号、仓库、数量、DC 和成本已有库存批次（若确为新批次可勾选）";
        row.selected = false;
      }
    }
    if (kind === "offer") {
      const chName = row.channel ?? defaultChannel ?? "";
      const hit = existingOffers.some(
        (offer) =>
          String(offer.part_id) === partId &&
          sameNullableNumber(offer.qty ?? -1, row.qty ?? -1) &&
          String(offer.date_code ?? "") === String(row.dateCode ?? "") &&
          Boolean(offer.is_tp) === Boolean(row.isTp) &&
          sameNullableNumber(offer.price_amount ?? -1, row.priceAmount ?? -1) &&
          (!chName || sameName(offer.channel_name, chName)),
      );
      if (hit) {
        row.duplicate = true;
        row.duplicateReason = `疑似重复：同渠道同型号近 ${DUPLICATE_OFFER_HOURS}h 已有推货`;
        row.selected = false;
      }
    }
    if (kind === "inquiry") {
      const cuName = row.customer ?? defaultCustomer ?? "";
      const hit = existingInquiries.some(
        (inquiry) =>
          String(inquiry.part_id) === partId &&
          sameNullableNumber(inquiry.qty ?? -1, row.qty ?? -1) &&
          (!cuName || sameName(inquiry.customer_name, cuName)),
      );
      if (hit) {
        row.duplicate = true;
        row.duplicateReason = `疑似重复：同客户同型号近 ${DUPLICATE_INQUIRY_HOURS}h 已有询价（若确为再次询价可勾选）`;
        row.selected = false;
      }
    }
    if (kind === "potential" && potentialUserId) {
      if (followedSet.has(partId)) {
        row.duplicate = true;
        row.duplicateReason = "当前用户已关注，默认不重复加入";
        row.selected = false;
      }
    }
  }
}

export const parseImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validateParseImportInput)
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    if (data.kind === "neutral") requireImportRecognition(principal);
    else requireImportKind(principal, data.kind);
    const sql = await sqlClient();
    await ensureSeed(sql);
    // Extraction is intentionally independent from the eventual write target.
    // The old targeted modes remain supported for callers outside the new UI,
    // while the UI uses `neutral` and selects the target after seeing rows.
    const extractKind: ImportKind | "neutral" = data.kind === "potential" ? "offer" : data.kind;
    const legacyExtractKind: ImportKind | "mixed" =
      data.kind === "neutral" ? "mixed" : data.kind === "potential" ? "offer" : data.kind;

    const resolved =
      process.env.IMPORT_ENGINE_V2_ENABLED === "true"
        ? await resolveImportWithEngine({
            kind: extractKind,
            sourceType: data.sourceType,
            text: data.text ? correctTradeText(data.text) : undefined,
            fileBase64: data.fileBase64,
            mime: data.mime,
            filename: data.filename,
          })
        : await (async () => {
            const { extractViaPlatform } = await import("./agent-platform");
            return resolveImportExtract(
              {
                kind: legacyExtractKind,
                sourceType: data.sourceType,
                text: data.text ? correctTradeText(data.text) : undefined,
                fileBase64: data.fileBase64,
                mime: data.mime,
                filename: data.filename,
              },
              {
                readTable: async () => {
                  try {
                    if (data.sourceType === "excel" && data.fileBase64)
                      return await parseExcel(data.fileBase64);
                    if (data.sourceType === "csv") {
                      const raw =
                        (data.text ? correctTradeText(data.text) : undefined) ??
                        (data.fileBase64
                          ? Buffer.from(data.fileBase64, "base64").toString("utf8")
                          : "");
                      return raw ? parseCsv(raw) : null;
                    }
                  } catch {
                    return null;
                  }
                  return null;
                },
                extractViaPlatform: (input) =>
                  extractViaPlatform({
                    ...input,
                    kind: input.kind === "neutral" ? "mixed" : input.kind,
                  }),
                runLocalImageFallback: async () => {
                  if (data.sourceType !== "image") return null;
                  const providers = defaultProviders();
                  const outcome = await runImportAgent(
                    {
                      sourceType: "image",
                      kind: legacyExtractKind,
                      fileBase64: data.fileBase64,
                      mime: data.mime,
                      filename: data.filename,
                    },
                    providers,
                  );
                  if (!outcome?.rows.length) return null;
                  return { rows: outcome.rows, usedAi: outcome.usedAi };
                },
              },
            );
          })();

    const normalizedRows = normalizeImportDateCodes(resolved.rows);
    const rows = normalizedRows.map((row) =>
      data.kind === "neutral"
        ? {
            ...row,
            kind: "mixed" as const,
            selected: false,
            duplicate: false,
            duplicateReason: null,
          }
        : data.kind === "mixed"
          ? row
          : { ...row, kind: data.kind },
    );
    // Some local/fallback extractors keep only the first token of a line such as
    // "TDA21472 / TDA21472AUMA1". Preserve the human-review gate from the raw
    // input so the shortened candidate cannot be written silently.
    if (data.text && isCompositeMpn(data.text) && rows.length === 1) {
      appendWarning(rows[0], "原始输入包含多个型号候选，请拆分为一行一个型号");
    }
    const usedAi = resolved.usedAi;
    const providers = process.env.IMPORT_ENGINE_V2_ENABLED === "true" ? [] : defaultProviders();

    if (data.kind !== "neutral") {
      await markDuplicates(
        sql,
        rows,
        data.kind,
        data.defaultWarehouseId,
        data.defaultSupplier,
        principal.userId,
        undefined,
        undefined,
        data.defaultCurrency,
        data.defaultTax,
      );
    }
    await annotateImportReviewRows(sql, rows);
    const lookups = await importLookups(sql);
    return {
      rows,
      usedAi,
      aiAvailable: resolved.aiAvailable ?? providers.some((p) => p.available()),
      extractOrigin: resolved.extractOrigin,
      extractChannel: resolved.extractChannel ?? null,
      extractState: resolved.extractState,
      extractMessage: resolved.extractMessage,
      ...lookups,
    };
  });

/**
 * Apply the user-selected business target to an already extracted candidate
 * list and recalculate target-specific duplicate checks. This is deliberately
 * separate from parseImport so changing the target never calls the model a
 * second time and never lets model output choose the write destination.
 */
export const prepareImportReview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validatePrepareImportReviewInput)
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireImportKind(principal, data.kind);
    const sql = await sqlClient();
    await ensureSeed(sql);
    const rows = rowsForImportReview(data.rows, data.kind, data.defaultCustomer);
    await markDuplicates(
      sql,
      rows,
      data.kind,
      data.defaultWarehouseId,
      data.defaultSupplier,
      principal.userId,
      data.defaultChannel,
      data.defaultCustomer,
      data.defaultCurrency,
      data.defaultTax,
    );
    await annotateImportReviewRows(sql, rows);
    return { rows, ...(await importLookups(sql)) };
  });

export const confirmImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(validateConfirmImportInput)
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    const sql = await sqlClient();
    const submissionId = data.submissionId || nid();
    const existing =
      await sql`select id, status, result_json, error_message, writing_started_at from import_batches where submission_id = ${submissionId} limit 1`;
    if (existing[0]) {
      if (existing[0].status === "success" && existing[0].result_json)
        return JSON.parse(String(existing[0].result_json));
      const startedAt = existing[0].writing_started_at
        ? new Date(String(existing[0].writing_started_at)).getTime()
        : 0;
      const stale = !startedAt || Date.now() - startedAt > 10 * 60 * 1000;
      if (existing[0].status === "writing" && !stale)
        throw new Error("这份导入正在写入，请勿重复提交");
      if (existing[0].status === "writing" || existing[0].status === "failed") {
        await sql`
          update import_batches set status = 'writing', error_message = null, result_json = null,
            writing_started_at = now(), finished_at = null
          where id = ${existing[0].id}
        `;
      } else {
        throw new Error(
          String(existing[0].error_message || "这份导入状态不可重试，请重新生成预览"),
        );
      }
    }
    const selected = data.rows.filter((r) => r.selected && r.mpn);
    if (selected.length === 0) throw new Error("没有勾选可写入的行");
    for (const row of selected) {
      if (!normalizeMpn(row.mpn)) throw new Error("型号不能为空");
      if (isCompositeMpn(row.mpn))
        throw new Error(`${row.mpn} 包含多个型号候选，请拆分为一行一个型号`);
      if (row.warning?.includes("多个型号候选"))
        throw new Error(`${row.mpn} 原始输入包含多个型号候选，请拆分为一行一个型号`);
      if (row.brandConflict) throw new Error(`${row.mpn} 存在品牌冲突，请人工修改并重新勾选`);
      const targetKind = effectiveImportKind(row, data.kind);
      if (targetKind === "inquiry") {
        const inquiryIssue = inquiryReviewBlockingReason(row, data.defaultCustomer);
        if (inquiryIssue) throw new Error(`${row.mpn}：${inquiryIssue}`);
      }
    }
    for (const row of selected) {
      const effectiveKind = effectiveImportKind(row, data.kind);
      if (effectiveKind === "mixed") throw new Error(`${row.mpn} 业务类型未确定`);
      requireImportKind(principal, effectiveKind);
    }
    const warehouses = await listWarehouses(sql);
    for (const row of selected) {
      const kind = effectiveImportKind(row, data.kind);
      if (kind === "offer" && !(row.channel || data.defaultChannel)) {
        throw new Error(`${row.mpn} 缺少渠道`);
      }
      if (kind === "inquiry" && !(row.customer || data.defaultCustomer)) {
        throw new Error(`${row.mpn} 缺少客户`);
      }
      // 数量必须为正整数：识别层偶发把价格当数量（如 $1.15 → 1.15），
      // 在写库前给出可理解的错误而非 Postgres integer 语法错。
      const requireIntQty = (qty: number | null, what: string): number => {
        const n = qty ?? 0;
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${row.mpn} ${what}数量无效`);
        if (!Number.isInteger(n)) {
          throw new Error(
            `${row.mpn} ${what}数量必须是整数：${n}（像价格被识别成了数量，请检查该行）`,
          );
        }
        return n;
      };
      if (kind === "offer") {
        if (row.qty != null && !Number.isInteger(row.qty)) {
          throw new Error(
            `${row.mpn} 推货数量必须是整数：${row.qty}（像价格被识别成了数量，请检查该行）`,
          );
        }
      }
      if (kind === "inquiry") {
        if (row.qty != null && !Number.isInteger(row.qty)) {
          throw new Error(
            `${row.mpn} 询价数量必须是整数：${row.qty}（像价格被识别成了数量，请检查该行）`,
          );
        }
      }
      if (kind === "stock") {
        const dc = resolveDateCode(row.dateCode, row.qty, row.standardPack);
        if (row.dateCode && (!dc.dateCode || dc.splits.length > 1 || dc.warning)) {
          throw new Error(`${row.mpn} DC 无法确认：${dc.warning || "请先拆分并核对"}`);
        }
        const wh =
          warehouses.find((w) => w.code === row.warehouse) ??
          warehouses.find((w) => w.id === data.defaultWarehouseId);
        if (!wh) throw new Error(`${row.mpn} 缺少仓库`);
        requireIntQty(row.qty, "入库");
        const amount = row.costAmount;
        const currency = amount == null ? null : (row.costCurrency ?? data.defaultCurrency ?? null);
        const tax = amount == null ? null : (row.costTax ?? data.defaultTax ?? null);
        if (amount == null && (row.costCurrency != null || row.costTax != null)) {
          throw new Error(`${row.mpn} 成本为空时币种和税别必须为空`);
        }
        if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
          throw new Error(`${row.mpn} 成本必须为空或不小于 0`);
        }
        if (amount != null && !currency) throw new Error(`${row.mpn} 填写成本时必须选择币种`);
        if (amount != null && currency === "USD" && tax !== "none")
          throw new Error(`${row.mpn} 美元成本税别只能是无`);
        if (amount != null && currency === "CNY" && tax !== "exclusive" && tax !== "inclusive") {
          throw new Error(`${row.mpn} 人民币成本必须选择含税或未税`);
        }
      }
      if (kind === "transit") {
        requireIntQty(row.qty, "在途");
      }
    }

    const batchId = existing[0]?.id ? String(existing[0].id) : nid();
    if (!existing[0]) {
      await sql`
        insert into import_batches (id, kind, source_type, filename, raw_excerpt, created_by, submission_id, status, writing_started_at)
        values (${batchId}, ${data.kind}, ${data.sourceType}, ${data.filename ?? null}, ${data.excerpt ?? null}, ${principal.userId}, ${submissionId}, 'writing', now())
      `;
    }
    try {
      // Keep confirmImport's transactional write boundary explicit: return withTransaction(sql, ...).
      return await withTransaction(sql, async (tx) => {
        const partIds: string[] = [];
        let potentialAdded = 0;
        const writtenByKind: Record<Exclude<ImportKind, "mixed">, number> = {
          offer: 0,
          inquiry: 0,
          stock: 0,
          transit: 0,
          potential: 0,
        };
        const inquiryCustomers = new Set<string>();
        for (const row of selected) {
          const part = await ensurePart(tx, row.mpn, {
            brand: row.brand,
            package: row.package,
            source: "导入",
          });
          partIds.push(part.id);
        }
        const uniqueIds = [...new Set(partIds)];
        const flagsBefore = await matchFlagsForParts(
          tx,
          uniqueIds,
          undefined,
          principal.userId,
          potentialScopeFor(principal),
        );

        for (let i = 0; i < selected.length; i++) {
          const row = selected[i];
          const partId = partIds[i];
          const kind = effectiveImportKind(row, data.kind);

          if (kind === "offer") {
            const chName = row.channel || data.defaultChannel;
            if (!chName) throw new Error(`${row.mpn} 缺少渠道`);
            const ch = await ensureChannel(tx, chName);
            await tx`
          insert into channel_offers (
            id, channel_id, part_id, qty, date_code, price_amount, price_currency, price_tax,
            is_tp, lead_time_text, import_batch_id
          ) values (
            ${nid()}, ${ch.id}, ${partId}, ${row.qty}, ${row.dateCode},
            ${row.priceAmount}, ${row.priceCurrency}, ${row.priceTax},
            ${row.isTp}, ${row.leadTimeText}, ${batchId}
          )
        `;
            writtenByKind.offer += 1;
          } else if (kind === "inquiry") {
            const cuName = row.customer || data.defaultCustomer;
            if (!cuName) throw new Error(`${row.mpn} 缺少客户`);
            const cu = await ensureCustomer(tx, cuName);
            inquiryCustomers.add(cu.name);
            await tx`
          insert into customer_inquiries (
            id, customer_id, part_id, qty, tp_amount, tp_currency, import_batch_id
          ) values (
            ${nid()}, ${cu.id}, ${partId}, ${row.qty}, ${row.priceAmount}, ${row.priceCurrency}, ${batchId}
          )
        `;
            writtenByKind.inquiry += 1;
          } else if (kind === "potential") {
            const inserted = await tx`
          insert into potential_models (user_id, part_id, note, import_batch_id)
          values (${principal.userId}, ${partId}, ${row.note}, ${batchId})
          on conflict (user_id, part_id) do nothing
          returning part_id
        `;
            if (inserted.length) {
              potentialAdded += 1;
              writtenByKind.potential += inserted.length;
            }
          } else if (kind === "stock") {
            const code = row.warehouse;
            const wh =
              warehouses.find((w) => w.code === code) ??
              warehouses.find((w) => w.id === data.defaultWarehouseId);
            if (!wh) throw new Error(`${row.mpn} 缺少仓库`);
            const lotId = nid();
            const qty = row.qty ?? 0;
            if (qty <= 0) throw new Error(`${row.mpn} 入库数量无效`);
            const supplierName = row.channel || data.defaultSupplier;
            const supplier = supplierName ? await ensureChannel(tx, supplierName) : null;
            const amount = row.costAmount;
            const currency =
              amount == null ? null : (row.costCurrency ?? data.defaultCurrency ?? null);
            const tax = amount == null ? null : (row.costTax ?? data.defaultTax ?? null);
            await tx`
          insert into stock_lots (
            id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
            standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, import_batch_id, origin_lot_id
          ) values (
            ${lotId}, ${partId}, ${wh.id}, 'on_hand', ${qty}, ${qty}, ${row.dateCode},
            ${row.package}, ${row.standardPack}, ${row.packState},
            ${amount}, ${currency}, ${tax}, ${supplier?.id ?? null}, ${batchId}, ${lotId}
          )
            `;
            writtenByKind.stock += 1;
            await tx`
          insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'in', ${qty}, ${wh.id}, ${batchId})
        `;
          } else if (kind === "transit") {
            const qty = row.qty ?? 0;
            if (qty <= 0) throw new Error(`${row.mpn} 在途数量无效`);
            const parsed = parseLeadTime(row.etaText || row.leadTimeText || "");
            const lotId = nid();
            const supplierName = row.channel || data.defaultSupplier;
            const supplier = supplierName ? await ensureChannel(tx, supplierName) : null;
            const amount = row.costAmount;
            const currency = row.costCurrency;
            const tax = row.costTax;
            await tx`
          insert into stock_lots (
            id, part_id, status, qty_in, qty_remaining, date_code,
            cost_amount, cost_currency, cost_tax, supplier_id, ordered_at, eta_date, eta_text, eta_precision, import_batch_id, origin_lot_id
          ) values (
            ${lotId}, ${partId}, 'in_transit', ${qty}, ${qty}, ${row.dateCode},
            ${amount}, ${currency}, ${tax}, ${supplier?.id ?? null}, now(), ${parsed.etaDate}, ${parsed.original || null},
            ${parsed.precision}, ${batchId}, ${lotId}
          )
        `;
            await tx`
          insert into stock_movements (id, part_id, lot_id, type, qty, note, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'transit_open', ${qty}, ${row.etaText}, ${batchId})
        `;
            writtenByKind.transit += 1;
          }
          await tx`update parts set updated_at = now() where id = ${partId}`;
        }

        const writtenCount = Object.values(writtenByKind).reduce((sum, count) => sum + count, 0);
        if (writtenCount !== selected.length) {
          throw new Error(`导入未完整写入：预期 ${selected.length} 行，实际 ${writtenCount} 行`);
        }

        const flagsAfter = await matchFlagsForParts(
          tx,
          uniqueIds,
          undefined,
          principal.userId,
          potentialScopeFor(principal),
        );
        const trigger: ImportKind =
          data.kind === "mixed" ? "offer" : data.kind === "potential" ? "offer" : data.kind;
        const summary = {
          identified: selected.length,
          hit: uniqueIds.filter((id) => {
            const f = flagsBefore.get(id);
            return f ? isCrossHit(f, trigger) : false;
          }).length,
          stock: uniqueIds.filter((id) => flagsAfter.get(id)?.stock).length,
          inquiry: uniqueIds.filter((id) => (flagsAfter.get(id)?.inquiryCount ?? 0) > 0).length,
          dual: uniqueIds.filter((id) => flagsAfter.get(id)?.isDual).length,
          watch: uniqueIds.filter((id) => flagsAfter.get(id)?.watch).length,
          potential: potentialAdded,
        };
        const hitParts = uniqueIds.map((id) => {
          const f = flagsAfter.get(id)!;
          return {
            partId: id,
            flags: f,
            stockLine: formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel),
          };
        });
        const result = {
          batchId,
          summary,
          hitParts,
          writtenCount,
          writtenByKind,
          customerCount: inquiryCustomers.size,
        };
        await tx`update import_batches set status = 'success', result_json = ${JSON.stringify(result)}, error_message = null, finished_at = now() where id = ${batchId}`;
        await logOp(tx, "confirm", "import_batch", batchId, {
          principal,
          requestId: submissionId,
          importBatchId: batchId,
          after: {
            kind: data.kind,
            writtenCount,
            writtenByKind,
            customerCount: inquiryCustomers.size,
          },
        });
        return result;
      });
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      await sql`update import_batches set status = 'failed', error_message = ${failureReason}, finished_at = now() where id = ${batchId}`;
      await logOp(sql, "confirm_failed", "import_batch", batchId, {
        principal,
        outcome: "failure",
        failureReason,
        requestId: submissionId,
        importBatchId: batchId,
      }).catch(() => undefined);
      throw error;
    }
  });
