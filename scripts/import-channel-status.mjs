/**
 * AI 导入通道的就绪状态（纯函数：不触网、无副作用，env 由调用方显式传入）。
 *
 * 为什么需要它：生产链路按 IMPORT_CHAIN 逐通道尝试，凭据缺失的通道会被
 * available() 静默跳过 —— 曾出现「降级链代码已上线、新通道 key 没配、实际
 * 仍走 OpenRouter」而在 /healthz、auto-deploy 日志、生产日志里全都看不出来
 * 的情况。这里把「链路顺序 + 每个通道是否在链内 / 凭据是否就位 / 缺哪个 env」
 * 抽成一份共享事实，供三处消费：
 *   - scripts/serve-production.mjs 的 /healthz 与启动日志；
 *   - scripts/auto-deploy.mjs 每次巡检时就绪情况、零可用时告警；
 *   - scripts/import-channel-status.test.mjs 与 import-engine.test.mjs（防漂移）。
 *
 * ⚠️ 通道 id 与 apiKeyEnv 必须与 packages/import-engine 保持一致：
 *   provider.ts 的 defaultImportProvider() 工厂表 +
 *   providers/chat-completions.ts 的三个直连工厂。
 *   scripts/import-engine.test.mjs 有防漂移断言 —— 改一处必须同时改另一处。
 */

export const DEFAULT_IMPORT_CHAIN = "command-code,opencode-go,deepseek-api,openrouter";

export const IMPORT_CHANNEL_SPECS = [
  { id: "command-code", apiKeyEnv: "COMMAND_CODE_API_KEY" },
  { id: "opencode-go", apiKeyEnv: "OPENCODE_GO_API_KEY" },
  { id: "deepseek-api", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
];

/**
 * 按引擎同款规则解析 IMPORT_CHAIN：
 * 空串 / 全空白回落默认链；剔除空白项；未知名单独收集（引擎会跳过并告警）。
 */
export function parseImportChain(raw) {
  const source = typeof raw === "string" && raw.trim() !== "" ? raw : DEFAULT_IMPORT_CHAIN;
  const chain = [];
  const unknown = [];
  for (const item of source.split(",")) {
    const name = item.trim();
    if (!name) continue;
    if (IMPORT_CHANNEL_SPECS.some((spec) => spec.id === name)) chain.push(name);
    else unknown.push(name);
  }
  return { source, chain, unknown };
}

/** 汇总每个通道的就绪状态；ready 只统计「在链内且凭据就位」的通道数。 */
export function describeImportChannels(env = process.env) {
  const { source, chain, unknown } = parseImportChain(env?.IMPORT_CHAIN);
  const channels = {};
  for (const spec of IMPORT_CHANNEL_SPECS) {
    const value = typeof env?.[spec.apiKeyEnv] === "string" ? env[spec.apiKeyEnv].trim() : "";
    const available = value !== "";
    channels[spec.id] = {
      available,
      inChain: chain.includes(spec.id),
      missing: available ? [] : [spec.apiKeyEnv],
    };
  }
  const readyIds = chain.filter((id) => channels[id].available);
  const warnings = [];
  if (unknown.length > 0) {
    warnings.push(`IMPORT_CHAIN 含未知通道名：${unknown.join("、")}（引擎会跳过并告警）`);
  }
  if (readyIds.length === 0) {
    warnings.push("链路内没有可用通道：导入无法交给模型，将退化为纯本地识别");
  }
  return { source, chain, unknown, channels, ready: readyIds.length, readyIds, warnings };
}

/** 一行式摘要，供启动日志、/healthz 与 auto-deploy 直接打印。 */
export function formatImportChannels(status) {
  const parts = IMPORT_CHANNEL_SPECS.map((spec) => {
    const info = status.channels[spec.id];
    if (!info.inChain) return info.available ? `${spec.id} ✓（未在链内）` : `${spec.id}（未在链内）`;
    return info.available ? `${spec.id} ✓` : `${spec.id} ✗ 缺 ${info.missing.join("、")}`;
  });
  return `${status.ready}/${status.chain.length} 链路通道可用 · ${parts.join(" · ")}`;
}
