import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  extractImport,
  headerKey,
  parseCsv,
} from "../packages/import-engine/src/index.ts";

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
