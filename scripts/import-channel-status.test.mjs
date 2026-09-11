import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IMPORT_CHAIN,
  IMPORT_CHANNEL_SPECS,
  describeImportChannels,
  formatImportChannels,
  parseImportChain,
} from "./import-channel-status.mjs";

const KEYS = Object.fromEntries(IMPORT_CHANNEL_SPECS.map((spec) => [spec.id, spec.apiKeyEnv]));

/** 造一份「只含指定通道凭据」的环境快照，避免测试受宿主 env 影响。 */
function envWith(chain, configured = []) {
  const env = {};
  if (chain !== undefined) env.IMPORT_CHAIN = chain;
  for (const id of configured) env[KEYS[id]] = `test-${id}-key`;
  return env;
}

test("status: 未配置 IMPORT_CHAIN 时使用引擎默认链", () => {
  const { source, chain, unknown } = parseImportChain(undefined);
  assert.equal(source, DEFAULT_IMPORT_CHAIN);
  assert.deepEqual(chain, IMPORT_CHANNEL_SPECS.map((spec) => spec.id));
  assert.deepEqual(unknown, []);
});

test("status: 空白 IMPORT_CHAIN 回落默认链，空白项与空格被剔除", () => {
  assert.equal(parseImportChain("   ").source, DEFAULT_IMPORT_CHAIN);
  assert.deepEqual(parseImportChain(" command-code , ,deepseek-api ").chain, [
    "command-code",
    "deepseek-api",
  ]);
});

test("status: 生产实况——command-code,deepseek-api,openrouter 且 openrouter 缺 key", () => {
  const status = describeImportChannels(envWith("command-code,deepseek-api,openrouter", ["command-code", "deepseek-api"]));
  assert.deepEqual(status.chain, ["command-code", "deepseek-api", "openrouter"]);
  assert.equal(status.ready, 2);
  assert.deepEqual(status.channels["command-code"], { available: true, inChain: true, missing: [] });
  assert.deepEqual(status.channels.openrouter, {
    available: false,
    inChain: true,
    missing: ["OPENROUTER_API_KEY"],
  });
  // opencode-go 不在链内：不计入就绪数（该场景未配 key）。
  assert.deepEqual(status.channels["opencode-go"], { available: false, inChain: false, missing: ["OPENCODE_GO_API_KEY"] });
  const summary = formatImportChannels(status);
  assert.match(summary, /^2\/3 链路通道可用/);
  assert.match(summary, /openrouter ✗ 缺 OPENROUTER_API_KEY/);
  assert.match(summary, /opencode-go（未在链内）/);
});

test("status: 凭据就位但未在链内的通道会显式标注（生产 opencode-go 情形）", () => {
  const status = describeImportChannels(envWith("command-code,deepseek-api,openrouter", ["command-code", "deepseek-api", "opencode-go"]));
  assert.equal(status.ready, 2, "未在链内的通道不计入就绪数");
  assert.deepEqual(status.channels["opencode-go"], { available: true, inChain: false, missing: [] });
  assert.match(formatImportChannels(status), /opencode-go ✓（未在链内）/);
});

test("status: 未知通道名单独收集并给出告警，其余通道照常统计", () => {
  const status = describeImportChannels(envWith("command-code,typo,oops", ["command-code"]));
  assert.deepEqual(status.chain, ["command-code"]);
  assert.deepEqual(status.unknown, ["typo", "oops"]);
  assert.equal(status.ready, 1);
  assert.equal(status.warnings.length, 1);
  assert.match(status.warnings[0], /typo、oops/);
});

test("status: 全部凭据缺失时 ready=0 并给出退化告警（曾被误判为正常）", () => {
  const status = describeImportChannels(envWith("command-code,deepseek-api,openrouter"));
  assert.equal(status.ready, 0);
  assert.deepEqual(status.readyIds, []);
  assert.ok(status.warnings.some((warning) => /没有可用通道/.test(warning)));
  assert.equal(formatImportChannels(status).startsWith("0/3 链路通道可用"), true);
});

test("status: 全链凭据就位时 ready 等于链内通道数且无告警", () => {
  const status = describeImportChannels(
    envWith(DEFAULT_IMPORT_CHAIN, IMPORT_CHANNEL_SPECS.map((spec) => spec.id)),
  );
  assert.equal(status.ready, 4);
  assert.deepEqual(status.warnings, []);
  assert.match(formatImportChannels(status), /^4\/4 链路通道可用/);
});

test("status: 空白值不算凭据就位", () => {
  const status = describeImportChannels({ IMPORT_CHAIN: "command-code", COMMAND_CODE_API_KEY: "   " });
  assert.equal(status.ready, 0);
  assert.deepEqual(status.channels["command-code"].missing, ["COMMAND_CODE_API_KEY"]);
});
