/**
 * 型号知识服务 —— 调用 huaqiangbei-workbench 的型号分析（产品知识区）。
 *
 * - 通道: hqb 本机 Agent API `/api/agent/lookup.full`（回环，零凭据透传；
 *   抓取凭据只存在于 hqb 服务端环境，本服务不接触）。
 * - 可配置: `HQB_BASE_URL`（默认 http://127.0.0.1:8081）。
 * - 降级不变量: 服务不可达 / 超时 / 空结果一律返回 `{ ok:false, error }`，
 *   绝不 throw —— 型号详情页无论何时照常渲染。
 * - 语义: 只消费 hqb 的确定性抓取与聚合结果，不在本服务内让任何模型猜参数。
 * - 持久化: 成功结果写入本地 DB `part_analyses`（按 mpn_key 覆盖），
 *   详情页进入即读保存记录、列表页显示「已分析」，无需重复抓外部平台。
 */

import { createServerFn } from "@tanstack/react-start";
import { mapHqbResponse } from "./knowledge-map";
import { getAnalysis, saveAnalysisFull } from "./analysis-db";
import type { PartKnowledgeAnalysis } from "./knowledge-map";

const HQB_BASE_URL = (process.env.HQB_BASE_URL || "http://127.0.0.1:8081").replace(/\/+$/, "");

export type {
  KnowledgeSpec,
  KnowledgeReplacement,
  PartKnowledgeAnalysis,
} from "./knowledge-map";

type HqbLookupFull = {
  ok?: boolean;
  truncated?: boolean;
  record?: {
    identity?: {
      imageUrl?: string;
      lcscUrl?: string;
      lcscStock?: number | null;
      priceBreaks?: { qty: number; price: number }[];
      applications?: string[];
    };
    offers?: {
      sourceKey?: string;
      model?: string;
      stock?: number | null;
      price?: number | null;
    }[];
  };
  dossier?: {
    headline?: string;
    positioning?: string;
    specs?: { label: string; value: string }[];
    apps?: string[];
    replacements?: {
      mpn: string;
      brand: string;
      package: string;
      similarity: string;
      stock: number | null;
      price: number | null;
    }[];
  };
};

export const analyzePartMpn = createServerFn({ method: "POST" })
  .validator((input: { mpn: string }) => input)
  .handler(async ({ data }): Promise<PartKnowledgeAnalysis> => {
    const mpn = data.mpn?.trim();
    if (!mpn) return { ok: false, error: "型号为空" };
    try {
      const res = await fetch(`${HQB_BASE_URL}/api/agent/lookup.full`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: mpn, steps: ["lcsc", "hqew"] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return { ok: false, error: `分析服务异常（${res.status}）` };
      const body = (await res.json()) as HqbLookupFull;
      const result = mapHqbResponse(body);
      if (result.ok) {
        // 成功即持久化（本地 node:sqlite DB），写库失败不阻断本次展示
        try {
          saveAnalysisFull(mpn, {
            analyzedAt: result.analyzedAt ?? new Date().toISOString(),
            sourceUrl: result.sourceUrl,
            json: JSON.stringify(result),
          });
        } catch {
          /* 持久化失败不阻断展示 */
        }
      }
      return result;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error && /timeout|abort/i.test(err.message)
          ? "分析超时（外部抓取较慢，稍后重试）"
          : "型号分析暂不可用",
      };
    }
  });

export type StoredPartAnalysis = {
  analyzedAt: string;
  sourceUrl?: string;
  analysis: PartKnowledgeAnalysis;
};

/** 读取本型号已保存的分析（无则 null）。供详情页进入即展示与列表标记。 */
export const getPartAnalysis = createServerFn({ method: "GET" })
  .validator((input: { mpn: string }) => input)
  .handler(async ({ data }): Promise<StoredPartAnalysis | null> => {
    const mpn = data.mpn?.trim();
    if (!mpn) return null;
    try {
      const row = getAnalysis(mpn);
      if (!row) return null;
      return {
        analyzedAt: row.analyzed_at,
        sourceUrl: row.source_url ?? undefined,
        analysis: JSON.parse(row.analysis) as PartKnowledgeAnalysis,
      };
    } catch {
      return null;
    }
  });