// Analysis persistence repository tests. The production adapter uses the same
// parameterized Sql surface over Postgres or local PGLite; no node:sqlite path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnalysisRepository } from "../src/lib/server/analysis-db.ts";

function fakeSql() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    rows,
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.startsWith("insert into part_analyses")) {
        const [mpn_key, mpn, analyzed_at, source_url, analysis] = params;
        rows.set(mpn_key, { mpn_key, mpn, analyzed_at, source_url, analysis });
        return [];
      }
      if (text.startsWith("select mpn_key, mpn")) {
        const row = rows.get(params[0]);
        return row ? [row] : [];
      }
      if (text.startsWith("select mpn_key, analyzed_at")) {
        return [...rows.values()].map(({ mpn_key, analyzed_at }) => ({ mpn_key, analyzed_at }));
      }
      if (text.startsWith("with moved as")) {
        const [toKey, toMpn, fromKey] = params;
        const row = rows.get(fromKey);
        if (row) {
          rows.set(toKey, { ...row, mpn_key: toKey, mpn: toMpn });
          rows.delete(fromKey);
        }
        return [];
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

test("保存后再读: 异步往返、大小写归一与参数化 SQL", async () => {
  const store = fakeSql();
  const repo = createAnalysisRepository(store);
  const mpn = "  tps7a4700rgwr '; drop table parts; -- ";
  await repo.saveAnalysisFull(mpn, {
    analyzedAt: "2026-08-23T10:00:00.000Z",
    sourceUrl: "https://item.szlcsc.com/116080.html",
    json: JSON.stringify({ ok: true, headline: "1A LDO" }),
  });
  const row = await repo.getAnalysis(mpn.toUpperCase());
  assert.ok(row);
  assert.equal(row.analyzed_at, "2026-08-23T10:00:00.000Z");
  assert.equal(JSON.parse(row.analysis).headline, "1A LDO");
  assert.equal(await repo.getAnalysis("NO-SUCH-PART"), null);
  const write = store.calls.find((call) => call.text.startsWith("insert into part_analyses"));
  assert.ok(write);
  assert.match(write.text, /\$1/);
  assert.doesNotMatch(write.text, /drop table/i);
  assert.match(String(write.params[0]), /DROP TABLE PARTS/);
});

test("同名覆盖、摘要与跨冷启动共享 SQL 表", async () => {
  const store = fakeSql();
  const firstProcess = createAnalysisRepository(store);
  await firstProcess.saveAnalysisFull("TPS7A4700RGWR", {
    analyzedAt: "2026-08-23T10:00:00.000Z", json: JSON.stringify({ v: 1 }),
  });
  const coldStartProcess = createAnalysisRepository(store);
  await coldStartProcess.saveAnalysisFull("tps7a4700rgwr", {
    analyzedAt: "2026-08-23T11:00:00.000Z", json: JSON.stringify({ v: 2 }),
  });
  assert.equal(JSON.parse((await coldStartProcess.getAnalysis("TPS7A4700RGWR")).analysis).v, 2);
  assert.deepEqual(await coldStartProcess.listAnalysisTimes(), {
    TPS7A4700RGWR: "2026-08-23T11:00:00.000Z",
  });
});

test("moveAnalysisKey 原子地移动记录且保留时间", async () => {
  const store = fakeSql();
  const repo = createAnalysisRepository(store);
  await repo.saveAnalysisFull("OLD-MPN", { analyzedAt: "2026-08-23T09:00:00.000Z", json: "{}" });
  await repo.moveAnalysisKey("OLD-MPN", "NEW-MPN");
  assert.equal(await repo.getAnalysis("OLD-MPN"), null);
  assert.equal((await repo.getAnalysis("new-mpn")).analyzed_at, "2026-08-23T09:00:00.000Z");
  const move = store.calls.find((call) => call.text.startsWith("with moved as"));
  assert.ok(move);
  assert.match(move.text, /on conflict \(mpn_key\)/i);
});
