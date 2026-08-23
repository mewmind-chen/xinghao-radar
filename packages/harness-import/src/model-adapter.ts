/**
 * model-adapter —— AI provider 插件层（方案第 15 节：把 "AI provider" 插件化）。
 *
 * - 统一 OpenAI-compatible chat/completions 协议；任何失败（无 key/网络/超时/非 JSON）
 *   一律返回 null，由上层走确定性回退 —— 这是"Harness 停机系统照常"的落点。
 * - 视觉能力单独声明：deepseek-chat 不收图片，vision 路由只挑 supportsVision 的 provider。
 */

import type { Currency, CostTax } from "./schema.ts";

export type ExtractRequest = {
  systemPrompt: string;
  userText: string;
  imageDataUrl?: string;
  timeoutMs?: number;
};

export type ProviderExtract = {
  /** provider 名，用于预览页展示与审计 */
  provider: string;
  model: string;
  raw: string;
};

export interface ImportModelProvider {
  readonly name: string;
  readonly supportsVision: boolean;
  available(): boolean;
  extract(req: ExtractRequest): Promise<ProviderExtract | null>;
}

export type ProviderConfig = {
  name: string;
  baseURL: string;
  apiKeyEnv: string;
  modelEnv: string;
  defaultModel: string;
  supportsVision: boolean;
};

export class OpenAICompatibleProvider implements ImportModelProvider {
  readonly name: string;
  readonly supportsVision: boolean;
  private readonly cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.supportsVision = cfg.supportsVision;
  }

  available(): boolean {
    return Boolean(process.env[this.cfg.apiKeyEnv]);
  }

  async extract(req: ExtractRequest): Promise<ProviderExtract | null> {
    const apiKey = process.env[this.cfg.apiKeyEnv];
    if (!apiKey) return null;
    const model = process.env[this.cfg.modelEnv] || this.cfg.defaultModel;
    const content: unknown[] = [{ type: "text", text: req.userText }];
    if (req.imageDataUrl) content.push({ type: "image_url", image_url: { url: req.imageDataUrl } });

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(req.timeoutMs ?? 12000),
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 3500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content },
          ],
        }),
      });
    } catch {
      return null; // 网络/超时 → 上层回退
    }
    if (!res.ok) return null;
    try {
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = body.choices?.[0]?.message?.content ?? "";
      if (!raw.trim()) return null;
      return { provider: this.name, model, raw };
    } catch {
      return null;
    }
  }
}

/**
 * 默认 provider 链（按优先级）：
 * 1. DeepSeek（DEEPSEEK_API_KEY，文本抽取；模型可用 DEEPSEEK_MODEL 覆盖）
 * 2. xAI grok（XAI_API_KEY，向后兼容原 aiExtract，带视觉）
 * 环境里一个 key 都没有 → availableProviders 为空 → agent 全链路降级到规则解析。
 */
export function defaultProviders(): ImportModelProvider[] {
  return [
    new OpenAICompatibleProvider({
      name: "deepseek",
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      modelEnv: "DEEPSEEK_MODEL",
      defaultModel: "deepseek-chat",
      supportsVision: false,
    }),
    new OpenAICompatibleProvider({
      name: "xai",
      baseURL: process.env.XAI_BASE_URL || "https://api.x.ai/v1",
      apiKeyEnv: "XAI_API_KEY",
      modelEnv: "XAI_MODEL",
      defaultModel: "grok-4.5",
      supportsVision: true,
    }),
  ];
}

/** 按需求挑一个可用 provider：vision 请求只给支持视觉的。 */
export function pickProvider(
  providers: ImportModelProvider[],
  needVision: boolean,
): ImportModelProvider | null {
  for (const p of providers) {
    if (needVision && !p.supportsVision) continue;
    if (p.available()) return p;
  }
  return null;
}

/** 解析模型返回的 JSON（容忍 ```json 围栏）。失败返回 null。 */
export function parseModelJson(raw: string): { rows?: RawRowList } | null {
  const s = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as { rows?: RawRowList };
    }
    return null;
  } catch {
    return null;
  }
}

type RawRow = Record<string, unknown>;
type RawRowList = RawRow[];

export type { RawRow, RawRowList };

/** 币种/税别枚举收敛：非法值一律回落 null（不猜）。 */
export function asCurrency(v: unknown): Currency {
  return v === "USD" || v === "CNY" ? v : null;
}
export function asCostTax(v: unknown): CostTax {
  return v === "none" || v === "exclusive" || v === "inclusive" ? v : null;
}
export function asPackState(v: unknown): "full" | "loose" | "mixed" | null {
  return v === "full" || v === "loose" || v === "mixed" ? v : null;
}
