/**
 * 型号知识服务 —— 调用 huaqiangbei-workbench 的型号分析（方案：产品知识区）。
 *
 * - 通道: hqb 本机 Agent API `/api/agent/lookup.full`（回环，零凭据透传；
 *   抓取凭据只存在于 hqb 服务端环境，本服务不接触）。
 * - 可配置: `HQB_BASE_URL`（默认 http://127.0.0.1:8081）。
 * - 降级不变量: 服务不可达 / 超时 / 空结果一律返回 `{ ok:false, error }`，
 *   绝不 throw —— 型号详情页无论何时照常渲染。
 * - 语义: 只消费 hqb 的确定性抓取与聚合结果，不在本服务内让任何模型猜参数。
 */

import { createServerFn } from "@tanstack/react-start";

const HQB_BASE_URL = (process.env.HQB_BASE_URL || "http://127.0.0.1:8081").replace(/\/+$/, "");

export type KnowledgeSpec = { label: string; value: string };
export type KnowledgeReplacement = {
  mpn: string;
  brand: string;
  package: string;
  similarity: string;
  stock: number | null;
  price: number | null;
};

export type PartKnowledgeAnalysis = {
  ok: boolean;
  error?: string;
  analyzedAt?: string;
  sourceUrl?: string;
  truncated?: boolean;
  positioning?: string;
  headline?: string;
  specs?: KnowledgeSpec[];
  applications?: string[];
  replacements?: KnowledgeReplacement[];
  /** 立创现货与量价 */
  lcsc?: {
    price: number | null;
    stock: number | null;
    url: string;
    imageUrl: string;
    priceBreaks: { qty: number; price: number }[];
  };
  /** 华强挂货聚合 */
  hqew?: {
    count: number;
    totalStock: number;
    minPrice: number | null;
  };
};

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
    specs?: KnowledgeSpec[];
    apps?: string[];
    replacements?: KnowledgeReplacement[];
  };
};

function minPrice(prices: (number | null | undefined)[]): number | null {
  const list = prices.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return list.length ? Math.min(...list) : null;
}

/** 纯映射：hqb lookup.full 响应 → 本服务压缩结构（供 handler 与单测共用）。 */
export function mapHqbResponse(body: HqbLookupFull): PartKnowledgeAnalysis {
  if (!body.ok) return { ok: false, error: "分析未返回结果" };
  const identity = body.record?.identity;
  const offers = body.record?.offers ?? [];
  const hqewRows = offers.filter((o) => o.sourceKey === "hqew");
  const lcscRow = offers.find((o) => o.sourceKey === "lcsc") ?? null;
  const d = body.dossier;
  return {
    ok: true,
    analyzedAt: new Date().toISOString(),
    sourceUrl: identity?.lcscUrl,
    truncated: Boolean(body.truncated),
    positioning: d?.positioning,
    headline: d?.headline,
    specs: d?.specs?.length ? d.specs : undefined,
    applications: d?.apps?.length ? d.apps : identity?.applications?.length ? identity.applications : [],
    replacements: d?.replacements?.length ? d.replacements : [],
    lcsc: {
      price: lcscRow?.price ?? null,
      stock: lcscRow?.stock ?? identity?.lcscStock ?? null,
      url: identity?.lcscUrl ?? "",
      imageUrl: identity?.imageUrl ?? "",
      priceBreaks: identity?.priceBreaks?.slice(0, 5) ?? [],
    },
    hqew: {
      count: hqewRows.length,
      totalStock: hqewRows.reduce((s, o) => s + (o.stock ?? 0), 0),
      minPrice: minPrice(hqewRows.map((o) => o.price)),
    },
  };
}

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
      return mapHqbResponse(body);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error && /timeout|abort/i.test(err.message)
          ? "分析超时（外部抓取较慢，稍后重试）"
          : "型号分析暂不可用",
      };
    }
  });