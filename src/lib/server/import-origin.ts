/**
 * 「这批行到底是从哪来的」的派生逻辑。
 *
 * 单独抽成纯函数（不依赖 vite 的 `@/` 别名、不碰网络），是为了能直接单测：
 * 这段判定出过一次真实 bug —— 见 deriveExtractOrigin 的注释。
 */
import type { ExtractOrigin } from "./import-contract";

/** 判定时只关心 run 的这几个字段，便于测试构造。 */
export type ImportRunLike = {
  status: string;
  provider?: string | null;
  channel?: string | null;
};

/**
 * ⚠️ 不要用 `runs.length > 0` 判定「是否用了 AI」。
 *
 * 降级链会给「不可用/失败」的通道也记 run，那种写法会让 runs.length 恒大于 0，
 * 于是纯本地确定性识别（一个 AI 通道都没调）也会被显示成 AI 识别，并且和
 * usedAi 互相矛盾。引擎的 route 才是权威来源：默认 deterministic，
 * 只有 AI 真的成功返回并产出候选行之后，引擎才会把它改成 model_rows / model_mapping。
 */
export function deriveExtractOrigin(route: string): ExtractOrigin {
  return route === "deterministic" ? "engine_deterministic" : "engine_ai";
}

/** 降级链里最终成功的那条通道；一次都没成功则返回 null。 */
export function deriveExtractChannel(runs: readonly ImportRunLike[]): string | null {
  const completed = runs.find((run) => run.status === "completed");
  if (!completed) return null;
  return completed.channel ?? completed.provider ?? null;
}

/** 是否真的调用过上游模型（成功过一次才算）。 */
export function deriveUsedAi(runs: readonly ImportRunLike[]): boolean {
  return runs.some((run) => run.status === "completed");
}
