// 型号主档修正相关纯函数测试: cleanBrand / knowledge-map resolved* 字段。
// 运行: node --test scripts/part-fix.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanBrand } from "../src/lib/server/part-identity.ts";

test("cleanBrand: 括号原文归一为品牌 code", () => {
  assert.equal(cleanBrand("ADI(亚德诺)"), "ADI");
  assert.equal(cleanBrand("TI(德州仪器)"), "TI");
  assert.equal(cleanBrand("Analog Devices"), "ADI");
  assert.equal(cleanBrand("ST"), "ST");
  assert.equal(cleanBrand(null), null);
  assert.equal(cleanBrand(""), null);
});

// 用真实抓取响应验证 resolved* 字段(供修正表单自动带入)
import { readFileSync } from "node:fs";
const real = JSON.parse(readFileSync("/tmp/lookup4.json", "utf8"));
test("mapHqbResponse: resolvedMpn/resolvedBrand 从立创身份带入", async () => {
  const { mapHqbResponse } = await import("../src/lib/server/knowledge-map.ts");
  const a = mapHqbResponse(real);
  assert.equal(a.ok, true);
  assert.ok(a.resolvedMpn, "resolvedMpn 非空");
  assert.ok(a.resolvedBrand, "resolvedBrand 非空");
  assert.ok((a.resolvedBrand ?? "").includes("TI"), "立创品牌原文带厂商名");
  assert.ok(a.resolvedPackage, "封装带入");
});