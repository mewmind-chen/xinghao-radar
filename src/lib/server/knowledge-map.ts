/**
 * hqb lookup.full 响应 → 本服务压缩结构。
 * 零外部依赖（不含 @/ 别名导入），供 server fn 与 Node --test 直跑共用。
 */

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