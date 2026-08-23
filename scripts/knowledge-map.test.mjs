// knowledge.ts 数据映射测试：用真实 hqb lookup.full 响应断言字段级正确。
// 运行: node --test scripts/knowledge-map.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mapHqbResponse } from "../src/lib/server/knowledge.ts";

const real = JSON.parse(
  readFileSync(join(process.env.HQB_SAMPLE || "/tmp/lookup4.json"), "utf8"),
);

test("真实响应映射: 封装图 URL 为立创真实抓取域(非空白非猜测)", () => {
  const a = mapHqbResponse(real);
  assert.equal(a.ok, true);
  assert.match(a.lcsc?.imageUrl ?? "", /^https?:\/\/alimg\.szlcsc\.com\/upload\/public\/product\/source\//);
});

test("真实响应映射: 定位/一句话/规格参数齐全", () => {
  const a = mapHqbResponse(real);
  assert.match(a.positioning ?? "", /线性稳压器|VQFN/);
  assert.ok((a.headline ?? "").length > 0, "headline 非空");
  assert.ok((a.specs ?? []).length >= 5, "规格表 ≥5 行");
  assert.ok((a.lcsc?.priceBreaks ?? []).length >= 2, "量价档 ≥2");
});

test("真实响应映射: 立创价格/库存与来源 URL", () => {
  const a = mapHqbResponse(real);
  assert.equal(typeof a.lcsc?.price, "number");
  assert.match(a.lcsc?.url ?? "", /^https:\/\/item\.szlcsc\.com\//);
});

test("降级: 服务端 ok=false → ok:false 且带错误文案", () => {
  const a = mapHqbResponse({ ok: false });
  assert.equal(a.ok, false);
  assert.ok((a.error ?? "").length > 0);
});

test("降级: 无 record 空对象 → ok:true 但空数据面", () => {
  const a = mapHqbResponse({ ok: true, record: {}, dossier: {} });
  assert.equal(a.ok, true);
  assert.equal(a.hqew?.count ?? 0, 0);
  assert.equal(a.lcsc?.imageUrl ?? "", "");
});