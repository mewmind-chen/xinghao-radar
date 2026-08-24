// harness-import 插件包测试：路由矩阵 / 确定性解析 / MPN 对抗校验 / provider 降级链。
// 运行: node --test scripts/harness-import.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  routeInput,
  heuristicParse,
  tableToRows,
  headerKey,
  parseCsv,
  rawRowsToImportRows,
  verifyMpnProvenance,
  validateImportRows,
  isImportKind,
  pickProvider,
  parseModelJson,
  runImportAgent,
} from "../packages/harness-import/src/index.ts";
import { extractDocumentText } from "../packages/harness-import/src/plugins/document-parser.ts";
import { toImageDataUrl } from "../packages/harness-import/src/plugins/vision-extractor.ts";
import { OpenAICompatibleProvider } from "../packages/harness-import/src/model-adapter.ts";

// ---------- input-router：输入类型路由（方案第 7 节） ----------

test("routeInput: sourceType/mime/filename 三方证据路由", () => {
  assert.equal(routeInput({ sourceType: "excel", filename: "a.xlsx" }).plugin, "excel");
  assert.equal(routeInput({ sourceType: "csv" }).plugin, "csv");
  assert.equal(routeInput({ sourceType: "image", mime: "image/jpeg" }).plugin, "image");
  assert.equal(routeInput({ sourceType: "pdf" }).plugin, "document");
  assert.equal(routeInput({ sourceType: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }).docType, "word");
  assert.equal(routeInput({ sourceType: "text" }).plugin, "text");
  // 扩展名兜底：sourceType 不准时可被 filename 纠正
  assert.equal(routeInput({ sourceType: "text", filename: "b.pdf" }).plugin, "document");
  assert.equal(routeInput({ sourceType: "text", filename: "c.xls" }).plugin, "excel");
});

// ---------- 确定性表格解析（验收：数量/成本/LT 由现有代码负责） ----------

test("tableToRows: 中文表头映射与确定性字段解析", () => {
  const rows = tableToRows(
    [
      ["型号", "品牌", "数量", "批次", "价格", "货期", "仓库"],
      ["STM32F103C8T6", "ST", "10K", "2418", "$1.15", "现货", "香港"],
      ["", "", "", "", "", "", ""],
    ],
    "offer",
  );
  assert.equal(rows.length, 1, "空 MPN 行过滤");
  const r = rows[0];
  assert.equal(r.mpn, "STM32F103C8T6");
  assert.equal(r.brand, "ST");
  assert.equal(r.qty, 10000);
  assert.equal(r.dateCode, "2418");
  assert.equal(r.priceAmount, 1.15);
  assert.equal(r.priceCurrency, "USD");
  assert.equal(r.warehouse, "HK");
  assert.equal(r.kind, "offer");
});

test("headerKey/parseCsv: tab 分隔与表头识别", () => {
  assert.equal(headerKey("Part Number"), "mpn");
  assert.equal(headerKey("供应商"), "channel");
  const t = parseCsv("mpn,qty\nABC,1K");
  assert.deepEqual(t[1], ["ABC", "1K"]);
});

// ---------- 规则解析 fallback ----------

test("heuristicParse: 示例行情文本逐行抽取", () => {
  const rows = heuristicParse(
    "TPS7A4700RGWR  20K  24+  TP  LT 4周\nSTM32F103C8T6  10K  2418  $1.15  现货",
    "mixed",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mpn, "TPS7A4700RGWR");
  assert.equal(rows[0].qty, 20000);
  assert.equal(rows[0].isTp, true);
  assert.equal(rows[0].dateCode, "24+");
  // 修复（价格吸附）：数量/批次/货期先摘除，价格只取残余 → $1.15
  assert.equal(rows[1].priceAmount, 1.15);
  assert.equal(rows[1].priceCurrency, "USD");
  assert.equal(rows[1].leadTimeText, "现货");
  assert.equal(rows[1].dateCode, "2418");
});

test("heuristicParse: mixed 类型按关键词判类", () => {
  const rows = heuristicParse("ESP32-WROOM-32E 8K 客户 瀚博微", "mixed");
  assert.equal(rows[0].kind, "inquiry");
  assert.equal(rows[0].customer, "瀚博微");
});

test("heuristicParse: 数量/价格/货期互不污染", () => {
  // 在途行: 数量 5K、货期 8月底、无价格(不吸附出 58)
  const a = heuristicParse("NRF52840-QIAA 5K 8月底到", "mixed");
  assert.equal(a[0].qty, 5000);
  assert.equal(a[0].leadTimeText, "8月底");
  assert.equal(a[0].priceAmount, null);
  assert.equal(a[0].kind, "transit", "8月底到 → 在途语义");
  // 询价行: 数量 8K、客户瀚博微、无价格(不吸附出 8)
  const b = heuristicParse("ESP32-WROOM-32E 8K 客 瀚博微", "mixed");
  assert.equal(b[0].qty, 8000);
  assert.equal(b[0].customer, "瀚博微");
  assert.equal(b[0].priceAmount, null);
});

test("heuristicParse: 数量优先带单位数字, 不把价格当数量", () => {
  const a = heuristicParse("TPS7A4700RGWR 10K 2418 $1.15 现货", "offer");
  assert.equal(a[0].qty, 10000);
  // 纯价格行 → 数量为空（币符前导的裸数字视为价格）
  const b = heuristicParse("LM317T $1.15", "offer");
  assert.equal(b[0].qty, null);
  const c = heuristicParse("LM317T 1.15元", "offer");
  assert.equal(c[0].qty, null);
  // 无单位裸整数仍是数量
  const d = heuristicParse("LM317T 5000", "offer");
  assert.equal(d[0].qty, 5000);
});

// ---------- MPN 对抗校验（验收 8 核心：只 warning 不改值） ----------

test("verifyMpnProvenance: AI 抽出原文没有的 MPN → warning，值不动", () => {
  const w = verifyMpnProvenance("TPS7A9999RGWR", "渠道推货 TPS7A4700RGWR 20K TP");
  assert.equal(w, "疑似识别异常，请人工确认");
});

test("verifyMpnProvenance: 大小写/NFKC 差异不算异常", () => {
  assert.equal(verifyMpnProvenance("stm32f103c8t6", "see STM32F103C8T6 stock"), null);
});

test("verifyMpnProvenance: 图片无原文可比 → 不误报", () => {
  assert.equal(verifyMpnProvenance("ABC123", undefined), null);
});

test("rawRowsToImportRows: AI 改字企图被拦截为 warning 且保留 AI 原值供人工裁决", () => {
  const rows = rawRowsToImportRows(
    [{ kind: "offer", mpn: "TPS7A9999RGWR", qty: 20000, note: "原始行" }],
    { defaultKind: "mixed", sourceText: "推货 TPS7A4700RGWR 20K TP LT4周" },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mpn, "TPS7A9999RGWR", "绝不静默改写成'正确'型号");
  assert.match(rows[0].warning ?? "", /疑似识别异常/);
});

test("rawRowsToImportRows: 数量文本回落本地 parser、币种税别枚举收敛", () => {
  const rows = rawRowsToImportRows(
    [{ kind: "stock", mpn: "NRF52840-QIAA", qty: "5K", priceCurrency: "EUR", packState: "整装" }],
    { defaultKind: "stock", provenanceCheck: false },
  );
  assert.equal(rows[0].qty, 5000);
  assert.equal(rows[0].priceCurrency, null, "非法币种回落 null 不猜");
  assert.equal(rows[0].packState, null, "非法包装状态回落 null 不猜");
});

test("rawRowsToImportRows: mixed 默认收敛为 offer；kind 非法同样兜底", () => {
  const rows = rawRowsToImportRows([{ mpn: "ABC1234", kind: "hot-deal" }], { defaultKind: "mixed", provenanceCheck: false });
  assert.equal(rows[0].kind, "offer");
});

test("validateImportRows: 空 MPN / 非法 kind 过滤,NaN 金额归 null", () => {
  const rows = validateImportRows([
    { id: "1", kind: "offer", mpn: "", priceAmount: NaN },
    { id: "2", kind: "alien", mpn: "X", priceAmount: 1 },
    { id: "3", kind: "transit", mpn: "OK-PART", priceAmount: Number.NaN, qty: 5 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "3");
  assert.equal(rows[0].priceAmount, null);
});

assert.equal(isImportKind("offer"), true);
assert.equal(isImportKind("mixed"), false);

// ---------- model-adapter: provider 选择与 JSON 容错 ----------

const fakeProvider = (over = {}) => ({
  name: "fake",
  supportsVision: true,
  available: () => true,
  extract: async () => null,
  ...over,
});

test("pickProvider: vision 请求跳过纯文本 provider", () => {
  const textOnly = fakeProvider({ supportsVision: false });
  const vision = fakeProvider();
  assert.equal(pickProvider([textOnly], true), null);
  assert.equal(pickProvider([textOnly, vision], true), vision);
  assert.equal(pickProvider([], false), null);
  assert.equal(pickProvider([textOnly], false), textOnly);
});

test("parseModelJson: 容忍 ```json 围栏与垃圾输出", () => {
  assert.deepEqual(parseModelJson('```json\n{"rows":[{"mpn":"A"}]}\n```'), { rows: [{ mpn: "A" }] });
  assert.equal(parseModelJson("not json at all"), null);
  assert.equal(parseModelJson("[1,2,3]"), null, "顶层数组不是合法响应");
});

test("OpenAICompatibleProvider: 无 key 时 available=false 且不发起请求", async () => {
  const p = new OpenAICompatibleProvider({
    name: "deepseek-test",
    baseURL: "https://example.invalid/v1",
    apiKeyEnv: "TEST_KEY_DEFINITELY_NOT_SET_9x7",
    modelEnv: "TEST_MODEL_X",
    defaultModel: "m",
    supportsVision: false,
  });
  assert.equal(p.available(), false);
  const r = await p.extract({ systemPrompt: "s", userText: "u" });
  assert.equal(r, null);
});

test("OpenAICompatibleProvider: HTTP 失败/超时返回 null（停机降级语义）", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    const p = new OpenAICompatibleProvider({
      name: "t", baseURL: "https://example.invalid/v1", apiKeyEnv: "TEST_KEY_OK_SET",
      modelEnv: "TEST_MODEL_X", defaultModel: "m", supportsVision: true,
    });
    process.env.TEST_KEY_OK_SET = "k";
    assert.equal(await p.extract({ systemPrompt: "s", userText: "u" }), null);
    globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    assert.equal(await p.extract({ systemPrompt: "s", userText: "u" }), null);
    delete process.env.TEST_KEY_OK_SET;
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------- Import Agent 编排与降级链（验收 6/9） ----------

test("agent: 规整文本零成本走规则解析，不用 AI", async () => {
  let aiCalled = 0;
  const outcome = await runImportAgentWithFake(
    { sourceType: "text", kind: "mixed", text: "TPS7A4700RGWR 20K 24+ TP LT 4周" },
    fakeProvider({ extract: async () => { aiCalled++; return null; } }),
  );
  assert.equal(aiCalled, 0, "规则能解就不烧钱调模型");
  assert.equal(outcome.usedAi, false);
  assert.equal(outcome.rows.length, 1);
});
async function runImportAgentWithFake(input, provider) {
  return runImportAgent(input, [provider]);
}

test("agent: 规则解不出且无可用模型 → null（宿主回退）", async () => {
  const outcome = await runImportAgent(
    { sourceType: "text", kind: "mixed", text: "今天天气不错" },
    [], // 空链 = Harness 停机
  );
  assert.equal(outcome, null);
});

test("agent: 图片输入无视觉模型 → null", async () => {
  const outcome = await runImportAgent(
    { sourceType: "image", kind: "offer", fileBase64: "aGVsbG8=", mime: "image/png" },
    [fakeProvider({ supportsVision: false })],
  );
  assert.equal(outcome, null);
});

test("agent: 模型故障(extract抛错/null) → null 而不是崩溃", async () => {
  const a = await runImportAgentWithFake(
    { sourceType: "text", kind: "mixed", text: "天气不错没有型号" },
    fakeProvider({ extract: async () => { throw new Error("provider down"); } }),
  );
  const b = await runImportAgentWithFake(
    { sourceType: "text", kind: "mixed", text: "天气不错没有型号" },
    fakeProvider({ extract: async () => null }),
  );
  assert.equal(a, null);
  assert.equal(b, null);
});

test("agent: AI 成功路径 —— 杂乱文本抽出型号必须带溯源 warning（方案第10节保守语义）", async () => {
  const outcome = await runImportAgentWithFake(
    // 无任何字母数字 token 的杂乱描述 → 规则解析为空 → 走 AI
    { sourceType: "text", kind: "mixed", text: "客户微信说：要那个意法的主控，一万片，急" },
    fakeProvider({
      extract: async () => ({
        provider: "fake",
        model: "fake-1",
        raw: JSON.stringify({
          rows: [
            { kind: "inquiry", mpn: "STM32F103C8T6", qty: 10000, customer: "瀚博微" },
            { kind: "inquiry", mpn: "", qty: 1 }, // 空 MPN → 过滤
          ],
        }),
      }),
    }),
  );
  assert.ok(outcome);
  assert.equal(outcome.usedAi, true);
  assert.equal(outcome.provider, "fake");
  assert.equal(outcome.rows.length, 1, "空 MPN 被 schema 过滤");
  const row = outcome.rows[0];
  assert.equal(row.mpn, "STM32F103C8T6", "AI 原值保留，不改字");
  assert.equal(row.qty, 10000);
  assert.equal(row.kind, "inquiry");
  // 原文中不存在该 MPN 字面量 → 必须提示人工确认，这正是"判断留给人"
  assert.match(row.warning ?? "", /疑似识别异常/);
});

test("agent: 图片走视觉 provider，无溯源比对不误报", async () => {
  const outcome = await runImportAgent(
    { sourceType: "image", kind: "offer", fileBase64: "aGVsbG8=", mime: "image/png" },
    [
      fakeProvider({
        name: "vision-fake",
        supportsVision: false,
        extract: async () => {
          throw new Error("should not be called");
        },
      }),
      fakeProvider({
        name: "grok-fake",
        extract: async (req) => ({
          provider: "grok-fake",
          model: "v",
          raw: JSON.stringify({ rows: [{ kind: "offer", mpn: "TPS7A4700RGWR", qty: 20000 }] }),
        }),
      }),
    ],
  );
  assert.ok(outcome);
  assert.equal(outcome.usedAi, true);
  assert.equal(outcome.provider, "grok-fake");
  assert.equal(outcome.rows[0].warning, null, "图片输入跳过溯源比对");
});

test("agent: CSV 输入走确定性表解析（AI 不参与表格）", async () => {
  let aiCalled = 0;
  const outcome = await runImportAgentWithFake(
    { sourceType: "csv", kind: "offer", text: "mpn,qty,价格\nLM317T,3K,$0.2" },
    fakeProvider({ extract: async () => { aiCalled++; return null; } }),
  );
  assert.equal(aiCalled, 0);
  assert.equal(outcome.rows.length, 1);
  assert.equal(outcome.rows[0].qty, 3000);
});

test("agent: 微信叙事文本不走 heuristic 主路径，交给 AI", async () => {
  let aiCalled = 0;
  const text = `老陈那边 TI 54560 还有一批
10K
24+
香港现货
一块一美金左右`;
  assert.ok(heuristicParse(text, "offer").length > 0, "heuristic 仍能抽出 token，但不能当主路径");
  const outcome = await runImportAgentWithFake(
    { sourceType: "text", kind: "offer", text },
    fakeProvider({
      extract: async () => {
        aiCalled++;
        return {
          provider: "fake",
          model: "fake-1",
          raw: JSON.stringify({ rows: [{ kind: "offer", mpn: "54560", qty: 10000 }] }),
        };
      },
    }),
  );
  assert.ok(aiCalled > 0);
  assert.equal(outcome.usedAi, true);
  assert.equal(outcome.rows[0].mpn, "54560");
});

test("agent: 陌生供应商 Excel 不走 headerKey 成功路径", async () => {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Part Number", "Maker", "Available"],
    ["TPS54560DDAR", "TI", "10000"],
  ]), "S1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const b64 = Buffer.from(buf).toString("base64");
  const guessed = tableToRows(
    [
      ["Part Number", "Maker", "Available"],
      ["TPS54560DDAR", "TI", "10000"],
    ],
    "offer",
  );
  assert.ok(guessed.length > 0, "headerKey helper 仍能猜中，但不能当 agent 成功");
  const outcome = await runImportAgent(
    { sourceType: "excel", kind: "offer", fileBase64: b64, filename: "vendor.xlsx" },
    [],
  );
  assert.equal(outcome, null);
});

test("agent: Excel 输入走确定性表解析", async () => {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["型号", "数量"], ["ADS1115IDGSR", "2K"],
  ]), "S1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const b64 = Buffer.from(buf).toString("base64");
  const outcome = await runImportAgent(
    { sourceType: "excel", kind: "stock", fileBase64: b64, filename: "库存.xlsx" },
    [],
  );
  assert.ok(outcome);
  assert.equal(outcome.usedAi, false);
  assert.equal(outcome.rows[0].mpn, "ADS1115IDGSR");
  assert.equal(outcome.rows[0].qty, 2000);
});

// ---------- document-parser 边界 ----------

test("document-parser: 老 .doc(OLE2)/随机字节 → null 明确降级", async () => {
  const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]);
  assert.equal(await extractDocumentText(ole2, { filename: "old.doc" }), null);
  assert.equal(await extractDocumentText(Buffer.from("hello world"), {}), null);
});

test("document-parser: 真实 PDF 文本抽取", async () => {
  // 手工构造最小单页 PDF（pdfjs 具备 xref 容错重建能力）
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const stream = "BT /F1 18 Tf 72 720 Td (TPS7A4700RGWR 20K TP LT4week) Tj ET";
  objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  const text = await extractDocumentText(Buffer.from(pdf, "latin1"), { filename: "quote.pdf" });
  assert.ok(text, "应抽出文本");
  assert.ok(text.includes("TPS7A4700RGWR"));
});

// ---------- vision-extractor ----------

test("toImageDataUrl: mime 缺省回落 jpeg", () => {
  assert.equal(toImageDataUrl("QQ==").startsWith("data:image/jpeg;base64,"), true);
  assert.equal(toImageDataUrl("QQ==", "image/png"), "data:image/png;base64,QQ==");
});
