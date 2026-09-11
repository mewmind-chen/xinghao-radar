import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ChatCompletionsProvider,
  FallbackProvider,
  IMPORT_SYSTEM_PROMPT,
  defaultImportProvider,
  extractImport,
  headerKey,
  parseCsv,
} from "../packages/import-engine/src/index.ts";
import { DEFAULT_IMPORT_CHAIN, IMPORT_CHANNEL_SPECS } from "./import-channel-status.mjs";

function fakeProvider(responses) {
  return {
    name: "fake",
    model: "fake-model",
    available: () => true,
    extract: async (request) => {
      const raw = responses[request.responseKind];
      if (!raw) return null;
      return {
        raw: JSON.stringify(raw),
        model: "fake-model",
        upstreamProvider: "fake-upstream",
        promptTokens: 10,
        completionTokens: 10,
        costUsd: 0,
      };
    },
  };
}

test("import-engine: CSV preserves quoted commas and newlines", () => {
  const table = parseCsv('型号,备注\nABC-123,"一行,带逗号"\nDEF-456,"第二行\n继续"\n');
  assert.equal(table.sheets[0].rows.length, 3);
  assert.deepEqual(table.sheets[0].rows[1], ["ABC-123", "一行,带逗号"]);
  assert.deepEqual(table.sheets[0].rows[2], ["DEF-456", "第二行\n继续"]);
});

test("import-engine: known table maps deterministically and keeps cell evidence", async () => {
  const result = await extractImport({
    source: { type: "csv", filename: "known.csv", content: "MPN,Brand,Quantity,Date Code,Price\nSTM32F103C8T6,ST,10K,2418,$1.15\n" },
    kindHint: "offer",
  }, fakeProvider({}));
  assert.equal(result.status, "completed");
  assert.equal(result.route, "deterministic");
  assert.equal(result.rows[0].mpn, "STM32F103C8T6");
  assert.equal(result.rows[0].qty, 10000);
  assert.equal(result.rows[0].priceAmount, 1.15);
  assert.equal(result.rows[0].verification, "exact");
  assert.equal(result.rows[0].evidence.mpn[0].type, "cell");
});

test("import-engine: text labels and compact quantities are not mistaken for MPNs", async () => {
  let calls = 0;
  const provider = fakeProvider({ rows: {
    rows: [{ kind: "offer", mpn: "STM32F103C8T6", qtyRaw: "10K", priceRaw: "$1.15", evidence: [{ field: "mpn", type: "text", quote: "STM32F103C8T6" }] }],
  } });
  const original = provider.extract;
  provider.extract = async (request) => { calls++; return original(request); };
  const result = await extractImport({
    source: { type: "text", content: "Supplier: Best Components\nItem code: STM32F103C8T6\nAvailable 10K, net $1.15" },
    kindHint: "offer",
  }, provider);
  assert.equal(calls, 1);
  assert.equal(result.route, "model_rows");
  assert.equal(result.rows[0].mpn, "STM32F103C8T6");
  assert.equal(result.rows[0].qty, 10000);
  assert.equal(result.rows.some((row) => ["Supplier", "Item", "Available"].includes(row.mpn)), false);
});

test("import-engine: ordinary model-like text still uses deterministic extraction", async () => {
  const unavailable = fakeProvider({});
  unavailable.available = () => false;
  const result = await extractImport({
    source: { type: "text", content: "STM32F103C8T6 10K DC2418 $1.15 USD 现货 HK" },
    kindHint: "offer",
  }, unavailable);
  assert.equal(result.status, "completed");
  assert.equal(result.route, "deterministic");
  assert.equal(result.rows[0].mpn, "STM32F103C8T6");
  assert.equal(result.rows[0].qty, 10000);
  assert.equal(result.rows[0].priceAmount, 1.15);
});

test("import-engine: neutral extraction keeps business kind unset", async () => {
  let requestedHint;
  const provider = fakeProvider({ rows: {
    rows: [{ kind: "offer", mpn: "STM32F103C8T6", qtyRaw: "10K", evidence: [{ field: "mpn", type: "text", quote: "STM32F103C8T6" }] }],
  } });
  const original = provider.extract;
  provider.extract = async (request) => {
    requestedHint = request.kindHint;
    return original(request);
  };
  const result = await extractImport({
    source: { type: "text", content: "STM32F103C8T6 10K" },
    kindHint: "neutral",
  }, provider);
  assert.equal(requestedHint, undefined, "确定性文本不应无意义调用模型");
  assert.equal(result.rows[0].kind, null);
  assert.equal(result.issues.some((item) => item.code === "missing_kind"), false);

  const modelResult = await extractImport({
    source: { type: "text", content: "客户：待确认\nItem code: STM32F103C8T6\nAvailable 10K, supplier quote" },
    kindHint: "neutral",
  }, provider);
  assert.equal(requestedHint, "neutral");
  assert.equal(modelResult.rows[0].kind, null);
  assert.equal(modelResult.issues.some((item) => item.code === "missing_kind"), false);
});

test("import-engine: unknown table asks for mapping when provider is unavailable", async () => {
  const unavailable = fakeProvider({});
  unavailable.available = () => false;
  const result = await extractImport({
    source: { type: "csv", filename: "unknown.csv", content: "Item Code,Available Stock,Maker\nTPS54560DDAR,2K,TI\n" },
    kindHint: "stock",
  }, unavailable);
  assert.equal(result.status, "provider_unavailable");
  assert.equal(result.rows.length, 0);
  assert.match(result.issues[0].message, /列映射/);
});

test("import-engine: supplier-specific fixture headers stay on the model mapping path", () => {
  for (const header of ["Item Code", "Available", "Maker", "Lot", "货号", "可供", "原厂", "周期"]) {
    assert.equal(headerKey(header), null, header);
  }
});

test("import-engine: model mapping applies to all rows after one bounded mapping call", async () => {
  let calls = 0;
  const provider = fakeProvider({ mapping: { mappings: [{ sheet: "CSV", headerRow: 0, dataStartRow: 1, columns: { mpn: 0, qty: 1, brand: 2 }, needsReview: false, reason: null }] } });
  const original = provider.extract;
  provider.extract = async (request) => { calls++; return original(request); };
  const result = await extractImport({
    source: { type: "csv", filename: "unknown.csv", content: "Item Code,Available Stock,Maker\nTPS54560DDAR,2K,TI\nSTM32F103C8T6,500,ST\n" },
    kindHint: "stock",
  }, provider);
  assert.equal(calls, 1);
  assert.equal(result.route, "model_mapping");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.rows.map((row) => [row.mpn, row.qty]), [["TPS54560DDAR", 2000], ["STM32F103C8T6", 500]]);
});

test("import-engine: real unknown CSV and Excel fixtures use one semantic mapping pass", async () => {
  const root = new URL("../tests/radar-agent-import-recovery/", import.meta.url);
  for (const [filename, sheet] of [["unknown-en.csv", "CSV"], ["unknown-en.xlsx", "Offers"]]) {
    const content = new Uint8Array(await readFile(new URL(filename, root)));
    const provider = fakeProvider({ mapping: {
      mappings: [{ sheet, headerRow: 0, dataStartRow: 1, columns: { mpn: 0, qty: 1, brand: 2, dateCode: 3, note: 4 }, needsReview: false, reason: null }],
    } });
    const result = await extractImport({
      source: { type: filename.endsWith(".csv") ? "csv" : "excel", filename, content },
      kindHint: "offer",
    }, provider);
    assert.equal(result.route, "model_mapping");
    assert.equal(result.status, "completed");
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].evidence.mpn[0].type, "cell");
  }
});

test("import-engine: visual candidates always require human review", async () => {
  const result = await extractImport({
    source: { type: "image", filename: "label.png", mime: "image/png", content: new Uint8Array([1, 2, 3]) },
    kindHint: "offer",
  }, fakeProvider({ rows: { rows: [{ kind: "offer", mpn: "ABC-123", evidence: [{ field: "mpn", type: "image", region: [0, 0, 1, 1], quote: "ABC-123" }] }] } }));
  assert.equal(result.status, "needs_review");
  assert.equal(result.rows[0].verification, "visual_only");
  assert.ok(result.issues.some((item) => item.code === "missing_evidence"));
});

test("import-engine: missing mixed kind and missing provenance remain review issues", async () => {
  const source = "渠道消息格式无法由规则确定";
  const result = await extractImport({
    source: { type: "text", content: source },
    kindHint: "mixed",
  }, fakeProvider({ rows: { rows: [{ kind: null, mpn: "ABC-124", qtyRaw: "10K", evidence: {} }] } }));
  assert.equal(result.status, "needs_review");
  assert.equal(result.rows[0].kind, null);
  assert.ok(result.rows[0].issues.length >= 2);
  assert.equal(result.rows[0].mpn, "ABC-124");
});

test("import-engine: unknown legacy .doc is explicitly unsupported", async () => {
  const result = await extractImport({
    source: { type: "docx", filename: "old.doc", content: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) },
    kindHint: "offer",
  }, fakeProvider({}));
  assert.equal(result.status, "unsupported");
  assert.match(result.issues[0].message, /docx|PDF/);
});

// ---------------------------------------------------------------------------
// 降级链：FallbackProvider
// ---------------------------------------------------------------------------

/** 造一个可控通道：available 由 env 决定，extract 由 impl 决定。 */
function chainProvider(name, impl, available = true) {
  return {
    name,
    model: `${name}-model`,
    available: () => available,
    extract: impl,
  };
}

function okResponse(model, extra = {}) {
  return {
    raw: JSON.stringify({ rows: [] }),
    model,
    upstreamProvider: null,
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    ...extra,
  };
}

test("fallback: 全部通道不可用时不调用任何上游，逐条记为 unavailable", async () => {
  let calls = 0;
  const chain = new FallbackProvider([
    chainProvider("a", async () => { calls++; return okResponse("m"); }, false),
    chainProvider("b", async () => { calls++; return okResponse("m"); }, false),
  ]);
  assert.equal(chain.available(), false);
  const response = await chain.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
  assert.equal(response, null);
  assert.equal(calls, 0);
  assert.deepEqual(chain.attempts.map((run) => [run.provider, run.status, run.error]), [
    ["a", "failed", "unavailable"],
    ["b", "failed", "unavailable"],
  ]);
});

test("fallback: 首个通道失败后降级成功，记录命中通道与 fallbackFrom 顺序", async () => {
  const chain = new FallbackProvider([
    chainProvider("a", async () => null),
    chainProvider("b", async () => null),
    chainProvider("c", async () => okResponse("c-model")),
  ]);
  const response = await chain.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
  assert.equal(response.channel, "c");
  assert.deepEqual(response.fallbackFrom, ["a", "b"]);
  assert.deepEqual(chain.attempts.map((run) => [run.provider, run.status]), [
    ["a", "failed"],
    ["b", "failed"],
    ["c", "completed"],
  ]);
  assert.equal(chain.attempts[2].channel, "c");
});

test("fallback: 通道抛异常被吞掉并记为失败，不会冒泡到调用方", async () => {
  const chain = new FallbackProvider([
    chainProvider("a", async () => { throw new Error("boom"); }),
    chainProvider("b", async () => okResponse("b-model")),
  ]);
  const response = await chain.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
  assert.equal(response.channel, "b");
  assert.deepEqual(response.fallbackFrom, ["a"]);
});

test("fallback: 全链失败返回 null，attempts 覆盖每个通道", async () => {
  const chain = new FallbackProvider([
    chainProvider("a", async () => null),
    chainProvider("b", async () => null),
  ]);
  const response = await chain.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
  assert.equal(response, null);
  assert.equal(chain.attempts.length, 2);
  assert.ok(chain.attempts.every((run) => run.status === "failed"));
});

test("fallback: 整链总预算生效——慢通道超时后不再尝试后续通道", async () => {
  const chain = new FallbackProvider([
    chainProvider("slow", () => new Promise((resolve) => setTimeout(() => resolve(okResponse("slow-model")), 200))),
    chainProvider("fast", async () => okResponse("fast-model")),
  ], { budgetMs: 40 });
  const started = Date.now();
  const response = await chain.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
  const elapsed = Date.now() - started;
  assert.equal(response, null, "预算耗尽应返回 null 而不是拿到慢通道的迟到结果");
  assert.ok(elapsed < 150, `应在预算附近返回，实际 ${elapsed}ms`);
  assert.deepEqual(chain.attempts.map((run) => [run.provider, run.error]), [
    ["slow", "timeout_budget"],
    ["fast", "budget_exhausted"],
  ]);
});

test("fallback: 单通道链在默认预算下不额外引入超时（回归保护）", async () => {
  const chain = new FallbackProvider([chainProvider("a", async () => okResponse("a-model"))]);
  const response = await chain.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
  assert.equal(response.channel, "a");
  assert.equal(response.fallbackFrom, undefined);
});

// ---------------------------------------------------------------------------
// 直连通道：ChatCompletionsProvider（全部走 stub fetch，不触网）
// ---------------------------------------------------------------------------

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length, url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function completion(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: "stub-model", choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 2 }, ...extra }),
  };
}

test("chat-completions: key 缺失时 available=false 且不发请求", async () => {
  const provider = new ChatCompletionsProvider({
    name: "probe", baseUrl: "https://example.invalid/v1", apiKeyEnv: "IMPORT_TEST_MISSING_KEY", model: "m",
  });
  const stub = stubFetch(() => completion('{"rows":[]}'));
  try {
    assert.equal(provider.available(), false);
    const response = await provider.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
    assert.equal(response, null);
    assert.equal(stub.calls.length, 0);
  } finally { stub.restore(); }
});

test("chat-completions: 默认用 json_object 且不外发 OpenRouter 专有 provider 字段", async () => {
  process.env.IMPORT_TEST_KEY_A = "test-key";
  const provider = new ChatCompletionsProvider({
    name: "probe", baseUrl: "https://example.invalid/v1", apiKeyEnv: "IMPORT_TEST_KEY_A", model: "m",
  });
  const stub = stubFetch(() => completion('{"rows":[]}'));
  try {
    const response = await provider.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
    assert.equal(response.raw, '{"rows":[]}');
    const { body, init, url } = stub.calls[0];
    assert.equal(url, "https://example.invalid/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal("provider" in body, false, "非 OpenRouter 上游不能带 provider 字段");
    assert.equal("max_tokens" in body, false, "直连不设输出上限：推理模型的思考 token 也计入额度，收紧会把答案截断成空");
    assert.equal(body.temperature, 0);
  } finally { stub.restore(); delete process.env.IMPORT_TEST_KEY_A; }
});

test("chat-completions: mapping 模式同样不设 max_tokens（回归保护）", async () => {
  process.env.IMPORT_TEST_KEY_A = "test-key";
  const provider = new ChatCompletionsProvider({
    name: "probe", baseUrl: "https://example.invalid/v1", apiKeyEnv: "IMPORT_TEST_KEY_A", model: "m",
  });
  const stub = stubFetch(() => completion('{"mappings":[]}'));
  try {
    await provider.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "mapping" });
    assert.equal(
      "max_tokens" in stub.calls[0].body,
      false,
      "曾按 responseKind 收紧到 2500，导致推理模型把额度耗在思考上、content 为空；不得再引入该限制",
    );
  } finally { stub.restore(); delete process.env.IMPORT_TEST_KEY_A; }
});

test("chat-completions: 401 属致命错误，不重试直接判通道失败", async () => {
  process.env.IMPORT_TEST_KEY_A = "test-key";
  const provider = new ChatCompletionsProvider({
    name: "probe", baseUrl: "https://example.invalid/v1", apiKeyEnv: "IMPORT_TEST_KEY_A", model: "m",
  });
  const stub = stubFetch(() => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) }));
  try {
    const response = await provider.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
    assert.equal(response, null);
    assert.equal(stub.calls.length, 1, "401 不该重试");
  } finally { stub.restore(); delete process.env.IMPORT_TEST_KEY_A; }
});

test("chat-completions: 429 可重试，第二次成功即返回", async () => {
  process.env.IMPORT_TEST_KEY_A = "test-key";
  const provider = new ChatCompletionsProvider({
    name: "probe", baseUrl: "https://example.invalid/v1", apiKeyEnv: "IMPORT_TEST_KEY_A", model: "m",
  });
  const stub = stubFetch((n) => (n === 1 ? { ok: false, status: 429, json: async () => ({}) } : completion('{"rows":[]}')));
  try {
    const response = await provider.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
    assert.equal(response.raw, '{"rows":[]}');
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); delete process.env.IMPORT_TEST_KEY_A; }
});

test("chat-completions: 空 content 视为失败（不静默产出 0 行）", async () => {
  process.env.IMPORT_TEST_KEY_A = "test-key";
  const provider = new ChatCompletionsProvider({
    name: "probe", baseUrl: "https://example.invalid/v1", apiKeyEnv: "IMPORT_TEST_KEY_A", model: "m",
  });
  const stub = stubFetch(() => completion(""));
  try {
    const response = await provider.extract({ kindHint: "offer", userText: "x", sourceType: "text", responseKind: "rows" });
    assert.equal(response, null);
  } finally { stub.restore(); delete process.env.IMPORT_TEST_KEY_A; }
});

// ---------------------------------------------------------------------------
// 链路装配与 prompt 同源
// ---------------------------------------------------------------------------

test("provider: IMPORT_CHAIN 拼错通道名时告警而不是静默丢弃", () => {
  const originalChain = process.env.IMPORT_CHAIN;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    process.env.IMPORT_CHAIN = "commandcode,openrouter";
    const provider = defaultImportProvider();
    assert.equal(provider.name, "openrouter", "未知名字被丢弃后只剩 openrouter 单通道");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /commandcode/);
  } finally {
    console.warn = originalWarn;
    if (originalChain === undefined) delete process.env.IMPORT_CHAIN; else process.env.IMPORT_CHAIN = originalChain;
  }
});

test("provider: 未配置 IMPORT_CHAIN 时默认链与文档一致", () => {
  const originalChain = process.env.IMPORT_CHAIN;
  try {
    delete process.env.IMPORT_CHAIN;
    const provider = defaultImportProvider();
    assert.equal(provider.name, "fallback-chain");
  } finally {
    if (originalChain !== undefined) process.env.IMPORT_CHAIN = originalChain;
  }
});

test("provider: IMPORT_CHAIN=openrouter 完全回到改动前形态（回滚路径）", () => {
  const originalChain = process.env.IMPORT_CHAIN;
  try {
    process.env.IMPORT_CHAIN = "openrouter";
    const provider = defaultImportProvider();
    assert.equal(provider.name, "openrouter");
    assert.equal(provider.attempts, undefined, "单通道不应有降级链的 attempts");
  } finally {
    if (originalChain === undefined) delete process.env.IMPORT_CHAIN; else process.env.IMPORT_CHAIN = originalChain;
  }
});

test("provider: IMPORT_SYSTEM_PROMPT 与 import-lab 模板保持逐字一致", async () => {
  const template = await readFile(new URL("../tools/import-lab/prompt-v2.template.txt", import.meta.url), "utf8");
  assert.equal(IMPORT_SYSTEM_PROMPT.trim(), template.trim(), "改 prompt 时两处必须同步，否则双跑脚本测的就不是生产 prompt");
});

// ---------------------------------------------------------------------------
// 与 scripts/import-channel-status.mjs 的防漂移断言
// （/healthz 与 auto-deploy 的就绪报告都依赖这份通道表）
// ---------------------------------------------------------------------------

function snapshotChannelEnv() {
  return {
    chain: process.env.IMPORT_CHAIN,
    keys: Object.fromEntries(
      IMPORT_CHANNEL_SPECS.map((spec) => [spec.apiKeyEnv, process.env[spec.apiKeyEnv]]),
    ),
  };
}

function restoreChannelEnv(snapshot) {
  if (snapshot.chain === undefined) delete process.env.IMPORT_CHAIN;
  else process.env.IMPORT_CHAIN = snapshot.chain;
  for (const [name, value] of Object.entries(snapshot.keys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("provider: 引擎默认链的顺序与 import-channel-status 的通道表逐一对齐", async () => {
  const snapshot = snapshotChannelEnv();
  try {
    delete process.env.IMPORT_CHAIN;
    for (const spec of IMPORT_CHANNEL_SPECS) delete process.env[spec.apiKeyEnv];
    const provider = defaultImportProvider();
    // 所有通道都判不可用 → 不触网，但会逐条记 attempts，正好用来读出链的顺序。
    const response = await provider.extract({
      kindHint: "offer",
      userText: "x",
      sourceType: "text",
      responseKind: "rows",
    });
    assert.equal(response, null);
    assert.deepEqual(
      provider.attempts.map((run) => run.provider),
      IMPORT_CHANNEL_SPECS.map((spec) => spec.id),
      "引擎默认链顺序必须与 import-channel-status 的通道表一致",
    );
    assert.deepEqual(
      IMPORT_CHANNEL_SPECS.map((spec) => spec.id),
      DEFAULT_IMPORT_CHAIN.split(","),
      "通道表顺序必须与 DEFAULT_IMPORT_CHAIN 一致",
    );
  } finally {
    restoreChannelEnv(snapshot);
  }
});

test("provider: 每个通道读的 apiKeyEnv 与 import-channel-status 的声明一致", () => {
  const snapshot = snapshotChannelEnv();
  try {
    for (const spec of IMPORT_CHANNEL_SPECS) {
      for (const other of IMPORT_CHANNEL_SPECS) delete process.env[other.apiKeyEnv];
      process.env.IMPORT_CHAIN = spec.id;
      assert.equal(defaultImportProvider().name, spec.id, `${spec.id} 无法按单通道装配`);
      assert.equal(
        defaultImportProvider().available(),
        false,
        `${spec.id} 在缺 ${spec.apiKeyEnv} 时不应判可用`,
      );
      process.env[spec.apiKeyEnv] = "probe-key";
      assert.equal(
        defaultImportProvider().available(),
        true,
        `${spec.id} 未读取 ${spec.apiKeyEnv}`,
      );
    }
  } finally {
    restoreChannelEnv(snapshot);
  }
});
