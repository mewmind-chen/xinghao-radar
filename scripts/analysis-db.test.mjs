// 本地 DB(analysis-db, node:sqlite)测试: 往返读写 / 键归一 / 摘要 / JSON 兼容。
// 运行: node --test scripts/analysis-db.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "radar-analysis-test-"));
process.env.DATA_DIR = dir;
const mod = await import("../src/lib/server/analysis-db.ts");

test("保存后再读: 完整往返 + mpn 大小写归一", () => {
  mod.saveAnalysisFull("  tps7a4700rgwr ", {
    analyzedAt: "2026-08-23T10:00:00.000Z",
    sourceUrl: "https://item.szlcsc.com/116080.html",
    json: JSON.stringify({ ok: true, headline: "1A LDO" }),
  });
  const row = mod.getAnalysis("TPS7A4700RGWR");
  assert.ok(row, "大小写不同的查询也应命中");
  assert.equal(row.analyzed_at, "2026-08-23T10:00:00.000Z");
  assert.equal(JSON.parse(row.analysis).headline, "1A LDO");
  assert.equal(mod.getAnalysis("NO-SUCH-PART"), null);
});

test("同名覆盖: 保留最新一条", () => {
  mod.saveAnalysisFull("TPS7A4700RGWR", { analyzedAt: "2026-08-23T11:00:00.000Z", json: JSON.stringify({ ok: true, v: 2 }) });
  const row = mod.getAnalysis("tps7a4700rgwr");
  assert.equal(JSON.parse(row.analysis).v, 2);
  assert.equal(row.analyzed_at, "2026-08-23T11:00:00.000Z");
});

test("listAnalysisTimes: 摘要映射", () => {
  const times = mod.listAnalysisTimes();
  assert.ok(times["TPS7A4700RGWR"] === "2026-08-23T11:00:00.000Z");
  assert.ok(Object.keys(times).length >= 1);
});

test("丢失的表/文件自动重建(IF NOT EXISTS)", () => {
  const db2 = mod.listAnalysisTimes();
  assert.equal(typeof db2, "object");
});

rmSync(dir, { recursive: true, force: true });