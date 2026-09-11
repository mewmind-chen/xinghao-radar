import type { ExtractionProvider, ModelRun, ProviderRequest, ProviderResponse } from "../types.ts";

/**
 * 整链总预算（毫秒）。默认 180_000，与「单通道 2 次尝试 × 90s」的历史最坏值持平，
 * 因此单通道场景不会因为引入降级链而变慢；多通道场景把最坏值从 N×180s 收敛回 180s。
 * 可用 IMPORT_CHAIN_BUDGET_MS 覆盖。
 */
const DEFAULT_BUDGET_MS = 180_000;

function budgetFromEnv(fallback: number): number {
  const raw = Number(process.env.IMPORT_CHAIN_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

type DeadlineOutcome = { timedOut: boolean; value: ProviderResponse | null };

/**
 * 给单次通道调用套一个硬超时。
 * 注意：这里只是「不再等它」，底层 fetch 仍会跑到自己的 AbortSignal 超时；
 * 被丢弃的 promise 必须挂上 catch，否则它之后 reject 会变成 unhandled rejection。
 */
function withDeadline(promise: Promise<ProviderResponse | null>, ms: number): Promise<DeadlineOutcome> {
  promise.catch(() => null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, value: null }), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ timedOut: false, value }); },
      () => { clearTimeout(timer); resolve({ timedOut: false, value: null }); },
    );
  });
}

/**
 * 顺序尝试多个通道，返回第一个成功响应。
 * 逐通道尝试记录写入 this.attempts，由 extract.ts 汇总进 result.runs，
 * 使 runs 能反映"真实命中的通道"与"成功前失败的通道"。
 *
 * 时间边界：整链共享一个 deadline。预算耗尽后不再尝试后续通道，
 * 并把它们记为 error="budget_exhausted"，避免「N 个通道 × 各自重试」把单次导入拖到十几分钟。
 */
export class FallbackProvider implements ExtractionProvider {
  readonly name = "fallback-chain";
  readonly model: string;
  /** 本次调用的逐通道尝试记录（供 extract.ts 读取） */
  attempts: ModelRun[] = [];
  // ⚠️ 不能写成构造函数参数属性（constructor(private readonly chain: ...)）：
  // 本包运行时是 Node strip-only 模式，参数属性会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  private readonly chain: ExtractionProvider[];
  private readonly budgetMs: number;
  private lastFailed: string[] = [];

  constructor(chain: ExtractionProvider[], options: { budgetMs?: number } = {}) {
    this.chain = chain;
    this.model = chain[0]?.model ?? "unknown";
    this.budgetMs = options.budgetMs ?? budgetFromEnv(DEFAULT_BUDGET_MS);
  }

  available(): boolean {
    return this.chain.some((provider) => provider.available());
  }

  private recordSkipped(provider: ExtractionProvider, error: string): void {
    this.attempts.push({
      provider: provider.name, model: provider.model, upstreamProvider: null, status: "failed", latencyMs: 0,
      promptTokens: null, completionTokens: null, costUsd: null, error,
    });
  }

  async extract(request: ProviderRequest): Promise<ProviderResponse | null> {
    this.attempts = [];
    this.lastFailed = [];
    const deadline = Date.now() + this.budgetMs;
    for (const provider of this.chain) {
      if (!provider.available()) {
        this.lastFailed.push(provider.name);
        this.recordSkipped(provider, "unavailable");
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.recordSkipped(provider, "budget_exhausted");
        break;
      }
      const started = Date.now();
      const outcome = await withDeadline(provider.extract(request), remaining);
      const response = outcome.value;
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
        promptTokens: null, completionTokens: null, costUsd: null,
        error: outcome.timedOut ? "timeout_budget" : "empty_or_error",
      });
    }
    return null;
  }
}
