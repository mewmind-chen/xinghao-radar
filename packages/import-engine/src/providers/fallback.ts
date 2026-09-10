import type { ExtractionProvider, ModelRun, ProviderRequest, ProviderResponse } from "../types.ts";

/**
 * 顺序尝试多个通道，返回第一个成功响应。
 * 逐通道尝试记录写入 this.attempts，由 extract.ts 汇总进 result.runs，
 * 使 runs 能反映"真实命中的通道"与"成功前失败的通道"。
 */
export class FallbackProvider implements ExtractionProvider {
  readonly name = "fallback-chain";
  readonly model: string;
  /** 本次调用的逐通道尝试记录（供 extract.ts 读取） */
  attempts: ModelRun[] = [];
  // ⚠️ 不能写成构造函数参数属性（constructor(private readonly chain: ...)）：
  // 本包运行时是 Node strip-only 模式，参数属性会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  private readonly chain: ExtractionProvider[];
  private lastFailed: string[] = [];

  constructor(chain: ExtractionProvider[]) {
    this.chain = chain;
    this.model = chain[0]?.model ?? "unknown";
  }

  available(): boolean {
    return this.chain.some((provider) => provider.available());
  }

  async extract(request: ProviderRequest): Promise<ProviderResponse | null> {
    this.attempts = [];
    this.lastFailed = [];
    for (const provider of this.chain) {
      if (!provider.available()) {
        this.lastFailed.push(provider.name);
        this.attempts.push({
          provider: provider.name, model: provider.model, upstreamProvider: null, status: "failed", latencyMs: 0,
          promptTokens: null, completionTokens: null, costUsd: null, error: "unavailable",
        });
        continue;
      }
      const started = Date.now();
      let response: ProviderResponse | null = null;
      try {
        response = await provider.extract(request);
      } catch {
        response = null;
      }
      const latencyMs = Date.now() - started;
      if (response) {
        const fallbackFrom = this.lastFailed.length ? [...this.lastFailed] : undefined;
        this.attempts.push({
          provider: provider.name, model: response.model, upstreamProvider: response.upstreamProvider,
          status: "completed", latencyMs,
          promptTokens: response.promptTokens, completionTokens: response.completionTokens, costUsd: response.costUsd,
          channel: provider.name, fallbackFrom,
        });
        // 回填真实通道名，供 extract.ts 记录
        return { ...response, channel: provider.name, fallbackFrom };
      }
      this.lastFailed.push(provider.name);
      this.attempts.push({
        provider: provider.name, model: provider.model, upstreamProvider: null, status: "failed", latencyMs,
        promptTokens: null, completionTokens: null, costUsd: null, error: "empty_or_error",
      });
    }
    return null;
  }
}
