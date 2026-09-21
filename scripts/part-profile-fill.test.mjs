// 「带入分析资料」回填逻辑测试: buildProfileFill（只读已保存的分析记录，不抓外网、不写记录）。
// 运行: node --test scripts/part-profile-fill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProfileFill, PART_PROFILE_FILL_REASON } from "../src/lib/part-profile-fill.ts";

test("四个字段齐全时全部回填，品牌去掉括号后缀", () => {
  const outcome = buildProfileFill({
    resolvedMpn: "AD9631ARZ-REEL7",
    resolvedBrand: "ADI(亚德诺)",
    resolvedCategory: "运算放大器",
    resolvedPackage: "SOIC-8",
  });

  assert.deepEqual(outcome, {
    ok: true,
    fill: {
      mpn: "AD9631ARZ-REEL7",
      brand: "ADI",
      category: "运算放大器",
      package: "SOIC-8",
    },
  });
});

test("分析出的完整型号覆盖录入时的不完整型号", () => {
  const outcome = buildProfileFill({ resolvedMpn: "TPS54560DDAR", resolvedBrand: "TI(德州仪器)" });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.fill.mpn, "TPS54560DDAR");
  assert.notEqual(outcome.fill.mpn, "TPS54560");
  assert.equal(outcome.fill.brand, "TI");
  assert.equal(outcome.fill.category, "");
  assert.equal(outcome.fill.package, "");
});

test("没有分析记录时给出 no-record 且不可带入", () => {
  for (const empty of [null, undefined]) {
    const outcome = buildProfileFill(empty);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "no-record");
    assert.equal(outcome.message, PART_PROFILE_FILL_REASON["no-record"]);
    assert.ok(outcome.message.length > 0, "置灰理由不能为空");
  }
});

test("有记录但四个字段全空时给出 empty 且不可带入", () => {
  const outcome = buildProfileFill({
    resolvedMpn: "   ",
    resolvedBrand: "",
    resolvedCategory: null,
    resolvedPackage: undefined,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "empty");
  assert.equal(outcome.message, PART_PROFILE_FILL_REASON.empty);
});

test("只有一个字段有值也算可带入，其余留空由人补", () => {
  const outcome = buildProfileFill({ resolvedPackage: " SOIC-8 " });

  assert.deepEqual(outcome, {
    ok: true,
    fill: { mpn: "", brand: "", category: "", package: "SOIC-8" },
  });
});

test("品牌归一不被厂商中文名或未知品牌破坏", () => {
  assert.equal(buildProfileFill({ resolvedBrand: "TI(德州仪器)" }).fill.brand, "TI");
  assert.equal(buildProfileFill({ resolvedBrand: "Analog Devices" }).fill.brand, "ADI");
  assert.equal(buildProfileFill({ resolvedBrand: " Murata " }).fill.brand, "Murata");
  // 有效的只有空品牌时，整体仍是 empty（品牌不构成可带入资料的错误信号）
  assert.equal(buildProfileFill({ resolvedBrand: "   " }).reason, "empty");
});
