import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { previewFieldsForKind, sanitizeImportRowForKind } from "../src/lib/import-target.ts";

const routeSource = await readFile(new URL("../src/routes/import.tsx", import.meta.url), "utf8");

test("智能导入页面不再使用中性识别或识别后选类型", () => {
  assert.doesNotMatch(routeSource, /startNeutralParse/);
  assert.doesNotMatch(routeSource, /kind:\s*["']neutral["']/);
  assert.doesNotMatch(routeSource, /第\s*2\s*步：选择导入类型/);
  assert.doesNotMatch(routeSource, /先中性识别|中性预览完成|正在中性识别/);
});

test("普通页面不提供逐行混合类型入口", () => {
  const optionsStart = routeSource.indexOf("const targetKindOptions");
  const returnStart = routeSource.indexOf("return (", optionsStart);
  const optionsSource = routeSource.slice(optionsStart, returnStart);
  assert.doesNotMatch(optionsSource, /value:\s*["']mixed["']/);
  assert.doesNotMatch(optionsSource, /逐行选择类型/);
});

test("没有目标类型时不能启动识别", () => {
  assert.match(routeSource, /if\s*\(\s*!kind\s*\)[\s\S]{0,180}(请先选择|选择导入类型)/);
});

test("预览行不重复展示已经锁定的业务类型", () => {
  assert.doesNotMatch(routeSource, />业务类型</);
});

test("服务端目标净化阻止询价携带库存字段", () => {
  const row = sanitizeImportRowForKind(
    {
      id: "row-1",
      kind: "stock",
      mpn: "TPS7A4700RGWR",
      brand: "TI",
      qty: 20000,
      qtyRaw: "20K",
      dateCode: "2615",
      priceAmount: 1.08,
      priceCurrency: "USD",
      priceTax: null,
      isTp: true,
      leadTimeText: null,
      etaText: null,
      warehouse: "HK",
      channel: "供应商A",
      customer: "客户A",
      package: null,
      standardPack: null,
      packState: null,
      costAmount: 0.8,
      costCurrency: "USD",
      costTax: "none",
      note: null,
      duplicate: false,
      duplicateReason: null,
      selected: false,
      warning: null,
    },
    "inquiry",
  );
  assert.equal(row.kind, "inquiry");
  assert.equal(row.customer, "客户A");
  assert.equal(row.priceAmount, 1.08);
  assert.equal(row.dateCode, null);
  assert.equal(row.warehouse, null);
  assert.equal(row.channel, null);
  assert.equal(row.costAmount, null);
});

test("各业务预览字段不混用", () => {
  assert.deepEqual(previewFieldsForKind("inquiry"), [
    "mpn",
    "brand",
    "customer",
    "qty",
    "tp",
    "currency",
    "status",
  ]);
  assert.equal(previewFieldsForKind("offer").includes("warehouse"), false);
  assert.equal(previewFieldsForKind("stock").includes("customer"), false);
  assert.equal(previewFieldsForKind("transit").includes("price"), false);
  assert.deepEqual(previewFieldsForKind("potential"), ["mpn", "brand", "status"]);
});
