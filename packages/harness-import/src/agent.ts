/**
 * Import Agent —— Harness V1 唯一 Agent（方案第 8 节）。
 *
 * 职责：判断输入类型 → 调对应解析插件 → （必要时）AI 结构化抽取 →
 * 确定性后处理 → 返回可预览的 ImportRow[]。
 * 返回 null 语义 = "本输入无法由 harness 处理"，宿主回退自有解析路径。
 *
 * 禁止（PRD 红线）：
 * - 自动入库（写库只发生在宿主 confirmImport）
 * - 自动修改 MPN（domain-adapter 只规范化 + warning）
 * - 判断市场热门/缺货/涨价、自动报 TP（V1 不做，见方案第 2/18 节）
 */

import { routeInput } from "./input-router.ts";
import { pickProvider } from "./model-adapter.ts";
import type { ImportModelProvider } from "./model-adapter.ts";
import { rawRowsToImportRows } from "./domain-adapter.ts";
import { validateImportRows } from "./schema.ts";
import type { ImportKind, ImportRow, ImportSource } from "./schema.ts";
import { heuristicParse } from "./rule-parser.ts";
import { tableToRows } from "./table.ts";
import { isControlledImportText, isTrustedImportTable } from "./input-class.ts";
import { extractTextLines } from "./plugins/text-extractor.ts";
import { toImageDataUrl } from "./plugins/vision-extractor.ts";
import { extractDocumentText } from "./plugins/document-parser.ts";
import { parseExcel } from "./plugins/excel-parser.ts";
import { parseCsv } from "./plugins/csv-parser.ts";

export const IMPORT_SYSTEM_PROMPT = `你是电子元器件现货贸易录入助手。从用户提供的渠道推货/客户询价/库存/在途文本或截图中抽取结构化记录。
硬规则：
1. 型号（MPN）字符必须原样复制，禁止改写、补全、猜测。只允许去掉首尾空格。
2. 数量转成整数：10K=10000，1万=10000。
3. 批次是 Date Code（如 2418、24+），不是 Lot Number。
4. 无价格、要求对方报目标价 → isTp=true。不要发明我方报价。
5. 货期是 LT/交期，不是 AOT。香港仓=HK，板田=坂田。
6. 不要猜测车规/军工等级。
只返回 JSON：{"kind":"offer|inquiry|stock|transit|mixed","rows":[{...}]}
每行字段：kind,mpn,brand,qty,dateCode,priceAmount,priceCurrency(USD|CNY),priceTax(none|exclusive|inclusive),isTp,leadTimeText,etaText,warehouse,channel,customer,package,standardPack,packState(full|loose|mixed),costAmount,costCurrency,costTax,note`;

export type AgentInput = {
  sourceType: ImportSource;
  kind: ImportKind | "mixed";
  text?: string;
  fileBase64?: string;
  mime?: string;
  filename?: string;
};

export type AgentOutcome = {
  rows: ImportRow[];
  usedAi: boolean;
  provider: string | null;
};

export function runImportAgentWith(
  providers: ImportModelProvider[],
  input: AgentInput,
): Promise<AgentOutcome | null> {
  return runImportAgent(input, providers);
}

export async function runImportAgent(
  input: AgentInput,
  providers: ImportModelProvider[] = [],
): Promise<AgentOutcome | null> {
  const route = routeInput(input);
  const kind = input.kind;

  switch (route.plugin) {
    // 仅受信内部模板走确定性表解析。陌生供应商表交给宿主 / Platform Agent。
    case "excel": {
      if (!input.fileBase64) return null;
      try {
        const table = await parseExcel(input.fileBase64);
        if (!isTrustedImportTable(table)) return null;
        return { rows: tableToRows(table, kind), usedAi: false, provider: null };
      } catch {
        return null;
      }
    }
    case "csv": {
      const raw = input.text ?? (input.fileBase64 ? Buffer.from(input.fileBase64, "base64").toString("utf8") : "");
      if (!raw) return null;
      const table = parseCsv(raw);
      if (!isTrustedImportTable(table)) return null;
      return { rows: tableToRows(table, kind), usedAi: false, provider: null };
    }

    case "image": {
      if (!input.fileBase64) return null;
      const provider = pickProvider(providers, true);
      if (!provider) return null; // 无视觉模型 → 宿主降级提示
      const outcome = await aiExtractRows(providers, {
        defaultKind: kind,
        imageDataUrl: toImageDataUrl(input.fileBase64, input.mime),
        userText: `默认类型: ${kind}\n见图片`,
        sourceText: undefined,
      });
      return outcome;
    }

    case "document": {
      let docText = input.text ?? "";
      if (input.fileBase64) {
        const buf = Buffer.from(input.fileBase64, "base64");
        const extracted = await extractDocumentText(buf, { mime: input.mime, filename: input.filename });
        if (extracted) docText = extracted;
      }
      if (!docText.trim()) return null;
      if (isControlledImportText(docText)) {
        return { rows: heuristicParse(docText, kind), usedAi: false, provider: null };
      }
      return aiExtractRows(providers, {
        defaultKind: kind,
        userText: `默认类型: ${kind}\n文本:\n${docText.slice(0, 8000)}`,
        sourceText: docText,
      });
    }

    case "text":
    default: {
      const t = input.text ?? "";
      if (!t.trim()) return null;
      if (isControlledImportText(t)) {
        return { rows: heuristicParse(t, kind), usedAi: false, provider: null };
      }
      return aiExtractRows(providers, {
        defaultKind: kind,
        userText: `默认类型: ${kind}\n文本:\n${extractTextLines(t).normalized.slice(0, 8000)}`,
        sourceText: t,
      });
    }
  }
}

async function aiExtractRows(
  providers: ImportModelProvider[],
  opts: {
    defaultKind: ImportKind | "mixed";
    userText: string;
    imageDataUrl?: string;
    sourceText?: string;
  },
): Promise<AgentOutcome | null> {
  const needVision = Boolean(opts.imageDataUrl);
  const provider = pickProvider(providers, needVision);
  if (!provider) return null;

  // provider 实现自身保证不抛，这里仍兜底：任何第三方异常都降级为 null（宿主回退）
  let extracted;
  try {
    extracted = await provider.extract({
      systemPrompt: IMPORT_SYSTEM_PROMPT,
      userText: opts.userText,
      imageDataUrl: opts.imageDataUrl,
    });
  } catch {
    return null;
  }
  if (!extracted) return null;

  const { parseModelJson } = await import("./model-adapter.ts");
  const parsed = parseModelJson(extracted.raw);
  const raws = parsed?.rows ?? [];
  if (!Array.isArray(raws)) return null;

  const rows = validateImportRows(
    rawRowsToImportRows(raws, {
      defaultKind: opts.defaultKind,
      sourceText: opts.sourceText,
      provenanceCheck: !needVision, // 图片无原文可比
    }),
  );
  if (rows.length === 0) return null;
  return { rows, usedAi: true, provider: extracted.provider };
}
