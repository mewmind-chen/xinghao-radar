import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveExtractChannel,
  deriveExtractOrigin,
  deriveUsedAi,
} from "../src/lib/server/import-origin.ts";
import { EXTRACT_ORIGIN_LABEL } from "../src/lib/server/import-contract.ts";

/** 造一条 run：降级链会给不可用/失败的通道也记 run。 */
function run(status, extra = {}) {
  return { status, provider: "fallback-chain", ...extra };
}

// ---------------------------------------------------------------------------
// extractOrigin：不要用 runs.length > 0 判定（曾经的线上 bug）
// ---------------------------------------------------------------------------

test("origin: 引擎 route 为 deterministic 时判为本地确定性识别", () => {
  assert.equal(deriveExtractOrigin("deterministic"), "engine_deterministic");
});

test("origin: AI 成功产出后 route 变 model_rows / model_mapping，判为 AI 识别", () => {
  assert.equal(deriveExtractOrigin("model_rows"), "engine_ai");
  assert.equal(deriveExtractOrigin("model_mapping"), "engine_ai");
});

test("origin: 回归保护——全部通道失败时不得被误判为 AI 识别", () => {
  const runs = [
    run("failed", { error: "unavailable", channel: "command-code" }),
    run("failed", { error: "unavailable", channel: "opencode-go" }),
    run("failed", { error: "unavailable", channel: "deepseek-api" }),
  ];
  assert.ok(runs.length > 0, "降级链确实会记 run，这正是旧写法出错的前提");
  assert.equal(deriveUsedAi(runs), false);
  assert.equal(deriveExtractChannel(runs), null);
  assert.equal(deriveExtractOrigin("deterministic"), "engine_deterministic");
});

test("origin: 一个 AI 通道都没调时 runs 为空，同样判为本地识别", () => {
  assert.equal(deriveUsedAi([]), false);
  assert.equal(deriveExtractOrigin("deterministic"), "engine_deterministic");
});

test("origin: 展示文案不再把 engine_ai 写死成某个具体通道", () => {
  assert.equal(EXTRACT_ORIGIN_LABEL.engine_ai, "AI 识别");
  assert.doesNotMatch(EXTRACT_ORIGIN_LABEL.engine_ai, /openrouter/i);
});

// ---------------------------------------------------------------------------
// extractChannel：降级链最终命中的那条通道
// ---------------------------------------------------------------------------

test("channel: 无成功 run 时返回 null", () => {
  assert.equal(deriveExtractChannel([]), null);
  assert.equal(deriveExtractChannel([run("failed", { channel: "command-code" })]), null);
});

test("channel: 优先取 run 上真实命中的 channel", () => {
  assert.equal(deriveExtractChannel([run("completed", { channel: "command-code" })]), "command-code");
});

test("channel: 没有 channel 字段时回落 provider（直连单通道场景）", () => {
  assert.equal(deriveExtractChannel([run("completed", { provider: "openrouter" })]), "openrouter");
});

test("channel: 降级发生时返回最终成功的那条，而不是链首", () => {
  const runs = [
    run("failed", { error: "unavailable", channel: "command-code" }),
    run("failed", { error: "timeout_budget", channel: "opencode-go" }),
    run("completed", { channel: "deepseek-api" }),
  ];
  assert.equal(deriveExtractChannel(runs), "deepseek-api");
  assert.equal(deriveUsedAi(runs), true);
});

test("channel: 未登记的通道名原样透出，不吞掉", () => {
  assert.equal(deriveExtractChannel([run("completed", { channel: "brand-new-upstream" })]), "brand-new-upstream");
});
