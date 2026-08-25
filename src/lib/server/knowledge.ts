/**
 * 型号知识服务 —— 优先走 electronics-agent-platform，失败再回退 Workbench。
 *
 * - 通道: AGENT_API_URL `/v1/parts/research`；回退 `HQB_BASE_URL/api/agent/lookup.full`。
 * - 可配置: `AGENT_API_URL`（默认 http://127.0.0.1:8787）、`HQB_BASE_URL`。
 * - 降级不变量: 服务不可达 / 超时 / 空结果一律返回 `{ ok:false, error }`，
 *   绝不 throw —— 型号详情页无论何时照常渲染。
 * - 语义: 只消费 hqb 的确定性抓取与聚合结果，不在本服务内让任何模型猜参数。
 * - 持久化: 成功结果写入本地 DB `part_analyses`（按 mpn_key 覆盖），
 *   详情页进入即读保存记录、列表页显示「已分析」，无需重复抓外部平台。
 */

import { createServerFn } from "@tanstack/react-start";
import { mapHqbResponse } from "./knowledge-map";
import { getAnalysis, saveAnalysisFull, saveAnalysisReview, getAnalysisReview } from "./analysis-db";
import type { PartKnowledgeAnalysis } from "./knowledge-map";
import type { PlatformPartResearchOutcome } from "./agent-platform";
import type { RadarPartContext } from "./radar-context-provider";
import { runPartAnalysisFlow } from "./part-analysis-flow";
import type { DegradedPartAnalysisEvent } from "./part-analysis-flow";

const HQB_BASE_URL = (process.env.HQB_BASE_URL || "http://127.0.0.1:8081").replace(/\/+$/, "");

export type {
  KnowledgeSpec,
  KnowledgeReplacement,
  PartKnowledgeAnalysis,
} from "./knowledge-map";

export type HqbLookupFull = {
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

export type PartAnalysisDependencies = {
  getRadarPartContext: (mpn: string) => Promise<RadarPartContext | null>;
  researchPartViaPlatform: (mpn: string, context: RadarPartContext | null) => Promise<PlatformPartResearchOutcome>;
  lookupHqb: (mpn: string) => Promise<HqbLookupFull>;
  saveAnalysis: (mpn: string, result: PartKnowledgeAnalysis) => Promise<void>;
  /** Receives a safe event name only: never tokens, URLs, response bodies, or DB errors. */
  logDegraded: (event: DegradedPartAnalysisEvent, reason?: string) => void;
};

async function persistAnalysis(mpn: string, result: PartKnowledgeAnalysis, save: PartAnalysisDependencies["saveAnalysis"]) {
  try {
    await save(mpn, result);
  } catch {
    /* persist is best-effort */
  }
}

async function createDefaultDependencies(): Promise<PartAnalysisDependencies> {
  const [{ researchPartViaPlatformWithOutcome }, { getRadarPartContext }] = await Promise.all([
    import("./agent-platform"),
    import("./radar-context-provider"),
  ]);
  return {
    getRadarPartContext,
    researchPartViaPlatform: researchPartViaPlatformWithOutcome,
    lookupHqb: async (mpn) => {
      const res = await fetch(`${HQB_BASE_URL}/api/agent/lookup.full`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: mpn, steps: ["lcsc", "hqew"] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) return { ok: false };
      return (await res.json()) as HqbLookupFull;
    },
    saveAnalysis: (mpn, result) => {
      return saveAnalysisFull(mpn, {
        analyzedAt: result.analyzedAt ?? new Date().toISOString(),
        sourceUrl: result.sourceUrl,
        json: JSON.stringify(result),
      });
    },
    logDegraded: (event, reason) => {
      // Keep degradation observable without emitting credentials, endpoints,
      // model output, or raw database/network errors.
      console.warn("[radar.part-analysis] degraded", { event, ...(reason ? { reason } : {}) });
    },
  };
}

/**
 * Orchestrates optional platform intelligence around Radar's deterministic
 * business path. Provider and Platform failures are deliberately non-fatal:
 * HQB remains the fact-retrieval fallback and Radar retains final ownership.
 */
export async function analyzePartMpnWithDependencies(
  rawMpn: string,
  deps: PartAnalysisDependencies,
): Promise<PartKnowledgeAnalysis> {
  const mpn = rawMpn.trim();
  if (!mpn) return { ok: false, error: "型号为空" };

  try {
    const flow = await runPartAnalysisFlow(mpn, {
      getContext: deps.getRadarPartContext,
      researchPlatform: deps.researchPartViaPlatform,
      hasUsablePlatformResult: (platform) => Boolean(platform.identity || (platform.offers && platform.offers.length)),
      lookupFallback: deps.lookupHqb,
      logDegraded: deps.logDegraded,
    });
    if (flow.source === "platform") {
      const { platformPartToHqb } = await import("./knowledge-map");
      const mapped = mapHqbResponse(platformPartToHqb(flow.platform));
      if (mapped.ok) {
        const result = { ...mapped, analysisSource: "platform" as const };
        await persistAnalysis(mpn, result, deps.saveAnalysis);
        return result;
      }
      return mapped;
    }
    const result = { ...mapHqbResponse(flow.fallback), analysisSource: "local_fallback" as const };
    if (result.ok) await persistAnalysis(mpn, result, deps.saveAnalysis);
    return result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error && /timeout|abort/i.test(err.message)
        ? "分析超时（外部抓取较慢，稍后重试）"
        : "型号分析暂不可用",
    };
  }
}

export const analyzePartMpn = createServerFn({ method: "POST" })
  .validator((input: { mpn: string }) => input)
  .handler(async ({ data }): Promise<PartKnowledgeAnalysis> => {
    try {
      return await analyzePartMpnWithDependencies(data.mpn, await createDefaultDependencies());
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
      const row = await getAnalysis(mpn);
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

export type PartReviewInput = {
  mpn: string;
  decision: "accept" | "reject" | "corrected";
  note?: string;
  correctedJson?: string;
};

export type PartReviewOutcome = {
  ok: boolean;
  error?: string;
  review?: {
    decision: string;
    reviewedAt: string;
  };
};

/** 保存人对该型号分析的人工决定。Radar 持久化最终动作；平台不写业务决定。 */
export const submitPartReview = createServerFn({ method: "POST" })
  .validator((input: PartReviewInput) => input)
  .handler(async ({ data }): Promise<PartReviewOutcome> => {
    const mpn = data.mpn?.trim();
    if (!mpn) return { ok: false, error: "型号为空" };
    if (!["accept", "reject", "corrected"].includes(data.decision)) {
      return { ok: false, error: "决定不合法" };
    }
    if (data.decision === "corrected" && !data.correctedJson) {
      return { ok: false, error: "修正需要 correctedJson" };
    }
    try {
      await saveAnalysisReview({
        mpn,
        decision: data.decision,
        note: data.note,
        correctedJson: data.correctedJson,
      });
      return { ok: true, review: { decision: data.decision, reviewedAt: new Date().toISOString() } };
    } catch {
      return { ok: false, error: "保存决定失败" };
    }
  });

export type PartReviewLoaded = {
  decision: "accept" | "reject" | "corrected" | null;
  reviewedAt?: string;
  reviewer?: string;
  note?: string;
  correctedJson?: string;
};

export const getPartReview = createServerFn({ method: "GET" })
  .validator((input: { mpn: string }) => input)
  .handler(async ({ data }): Promise<PartReviewLoaded> => {
    const mpn = data.mpn?.trim();
    if (!mpn) return { decision: null };
    try {
      const row = await getAnalysisReview(mpn);
      if (!row) return { decision: null };
      return {
        decision: row.decision,
        reviewedAt: row.reviewed_at,
        reviewer: row.reviewer || undefined,
        note: row.note || undefined,
        correctedJson: row.corrected_json ?? undefined,
      };
    } catch {
      return { decision: null };
    }
  });
