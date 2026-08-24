// domain.ts 业务不变量锁定测试（方案第 19 节步骤 1 / 第 20 节验收 1-4、8 的确定性面）。
// 运行: node --test scripts/domain-invariants.test.mjs
// domain.ts 仅含 import type（strip 后零运行时依赖），可直接被 Node 加载。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  brandShort,
  correctTradeText,
  displayMpn,
  finalizeMatchFlags,
  formatMd,
  formatStockLine,
  hitText,
  isCrossHit,
  isMatchableInquiry,
  isMatchableOffer,
  normalizeMpn,
  parseCost,
  parseLeadTime,
  parseQty,
  resolveWarehouseCode,
} from "../src/lib/domain.ts";

// ---------- F. 型号字符只做 trim/NFKC/大写 key，禁止改字 ----------

test("normalizeMpn: 只做 NFKC + trim + 大写，用于唯一 key", () => {
  assert.equal(normalizeMpn("  tps7a4700rgwr "), "TPS7A4700RGWR");
  // 全角字母/数字 NFKC 折叠为半角 —— 这是规范化不是改字
  assert.equal(normalizeMpn("ＳＴＭ３２"), "STM32");
});

test("displayMpn: 保留原始大小写与字符，只 trim + NFKC", () => {
  assert.equal(displayMpn("  Lm317T "), "Lm317T");
  assert.equal(displayMpn("esp32-wroom-32e"), "esp32-wroom-32e");
});

test("correctTradeText: 行业词纠错绝不触碰型号字符", () => {
  const before = "TPS7A4700RGWR 板田 10K AOT 4周";
  const after = correctTradeText(before);
  assert.ok(after.includes("TPS7A4700RGWR"), "型号必须原样保留");
  assert.ok(after.includes("坂田"), "板田→坂田");
  assert.ok(!after.includes("AOT"), "AOT→LT");
});

test("同型号不同写法归一为同一 mpn_key（验收1: 主档唯一的键基础）", () => {
  assert.equal(normalizeMpn("stm32f103c8t6"), normalizeMpn("STM32F103C8T6"));
});

// ---------- 数量 / 成本 / 货期确定性解析 ----------

test("parseQty: K/万/W 缩写换算", () => {
  assert.equal(parseQty("10K"), 10000);
  assert.equal(parseQty("1万"), 10000);
  assert.equal(parseQty("2W"), 20000);
  assert.equal(parseQty("500"), 500);
  assert.equal(parseQty(""), null);
  assert.equal(parseQty(null), null);
});

test("parseCost: TP/目标价只标记不发明金额", () => {
  assert.deepEqual(parseCost("TP"), { amount: null, currency: null, tax: null, isTp: true });
  assert.deepEqual(parseCost("目标价"), { amount: null, currency: null, tax: null, isTp: true });
  assert.deepEqual(parseCost("请报价"), { amount: null, currency: null, tax: null, isTp: true });
});

test("parseCost: 币种与税别推断", () => {
  const usd = parseCost("$1.15");
  assert.equal(usd.amount, 1.15);
  assert.equal(usd.currency, "USD");
  assert.equal(usd.tax, "none");

  // 契约（现状锁定）: 无币种符号时不推断币种，只解析税别标记
  const noCur = parseCost("8.5含税");
  assert.equal(noCur.currency, null);
  assert.equal(noCur.tax, "inclusive");
  assert.equal(noCur.amount, 8.5);

  // 显式人民币符号 → CNY，且默认未税
  const cny = parseCost("¥8.5");
  assert.equal(cny.currency, "CNY");
  assert.equal(cny.tax, "exclusive");
});

test("parseLeadTime: 现货/周数/日期/月底各精度", () => {
  const now = new Date("2026-08-23T10:00:00");
  assert.equal(parseLeadTime("现货", now).precision, "stock");
  const w = parseLeadTime("LT 4周", now);
  assert.equal(w.precision, "week");
  assert.match(w.etaDate ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(parseLeadTime("8月底", now).precision, "month");
  const d = parseLeadTime("9/1", now);
  assert.equal(d.precision, "date");
  assert.equal(parseLeadTime("", now).etaDate, null);
});

test("resolveWarehouseCode: 别名收敛（板田→坂田、香港→HK）", () => {
  assert.equal(resolveWarehouseCode("香港"), "HK");
  assert.equal(resolveWarehouseCode("HK仓"), "HK");
  assert.equal(resolveWarehouseCode("板田"), "坂田");
  assert.equal(resolveWarehouseCode(""), null);
  assert.equal(resolveWarehouseCode(null), null);
});

test("brandShort: 全名缩写映射", () => {
  assert.equal(brandShort("Texas Instruments"), "TI");
  assert.equal(brandShort("德州仪器"), "TI");
  assert.equal(brandShort("STMicroelectronics"), "ST");
});

// ---------- E. 失效退出匹配但历史保留；停用门闩 ----------

const OFFER = (over = {}) => ({
  isValid: true,
  deleted: false,
  channelActive: true,
  offeredAt: new Date(Date.now() - 86400000).toISOString(),
  windowDays: 30,
  ...over,
});

test("isMatchableOffer: 有效+活跃+窗口内才参与当前匹配", () => {
  assert.equal(isMatchableOffer(OFFER()), true);
  assert.equal(isMatchableOffer(OFFER({ isValid: false })), false, "失效记录退出当前匹配");
  assert.equal(isMatchableOffer(OFFER({ deleted: true })), false, "删除记录退出当前匹配");
  assert.equal(isMatchableOffer(OFFER({ channelActive: false })), false, "停用渠道门闩");
});

test("isMatchableOffer: 超出时间窗自然老化退出", () => {
  assert.equal(isMatchableOffer(OFFER({ offeredAt: new Date(Date.now() - 40 * 86400000).toISOString() })), false);
});

test("isMatchableInquiry: 同样的门闩语义", () => {
  const base = {
    isValid: true,
    deleted: false,
    customerActive: true,
    inquiredAt: new Date(Date.now() - 86400000).toISOString(),
    windowDays: 90,
  };
  assert.equal(isMatchableInquiry(base), true);
  assert.equal(isMatchableInquiry({ ...base, isValid: false }), false);
  assert.equal(isMatchableInquiry({ ...base, customerActive: false }), false);
  assert.equal(isMatchableInquiry({ ...base, deleted: true }), false);
});

// ---------- D. 匹配=交叉命中，禁止本条事件命中自己 ----------

const FLAGS = (over = {}) => ({
  stock: false,
  transit: false,
  inquiryCount: 0,
  offerCount: 0,
  watch: false,
  ...over,
});

test("isCrossHit: 新推货不能靠渠道推货自己命中（禁自命中）", () => {
  // 只有 offerCount>0（即本条推货自身来源）时不算命中
  assert.equal(isCrossHit(FLAGS({ offerCount: 1 }), "offer"), false);
  assert.equal(isCrossHit(FLAGS({ stock: true }), "offer"), true, "推货命中库存");
  assert.equal(isCrossHit(FLAGS({ inquiryCount: 2 }), "offer"), true, "推货命中客户询价");
});

test("isCrossHit: 新询价不能靠询价自己命中", () => {
  assert.equal(isCrossHit(FLAGS({ inquiryCount: 1 }), "inquiry"), false);
  assert.equal(isCrossHit(FLAGS({ transit: true }), "inquiry"), true, "询价命中在途");
  assert.equal(isCrossHit(FLAGS({ offerCount: 1 }), "inquiry"), true, "询价命中渠道");
});

test("isCrossHit: 库存变化只对客/渠/潜敏感", () => {
  assert.equal(isCrossHit(FLAGS({ stock: true }), "stock"), false, "库存不因库存自己命中");
  assert.equal(isCrossHit(FLAGS({ inquiryCount: 1 }), "stock"), true);
});

test("isCrossHit: any 触发下双命中优先", () => {
  assert.equal(isCrossHit(FLAGS({ stock: true, inquiryCount: 1 }), "any"), true);
  assert.equal(isCrossHit(FLAGS({ stock: true }), "any"), false, "单边库存不算交叉命中");
  assert.equal(isCrossHit(FLAGS({ watch: true }), "any"), false, "仅关注不命中");
  assert.equal(isCrossHit(FLAGS({ watch: true, stock: true }), "any"), true);
});

test("finalizeMatchFlags/hitText: 库·途·客N·潜 标记串", () => {
  const f = finalizeMatchFlags({
    partId: "p1",
    onHand: 8000,
    byWarehouse: [{ id: "w1", code: "HK", qty: 8000 }],
    inTransit: 3000,
    transitEtaLabel: "8/28",
    inquiryCount: 3,
    offerCount: 0,
    watch: true,
    stock: false,
    transit: false,
    isHit: false,
    isDual: false,
  });
  assert.equal(f.stock, true);
  assert.equal(f.transit, true);
  assert.equal(f.isDual, true, "库+客=双命中");
  assert.equal(f.isHit, true);
  assert.equal(hitText(f), "库 · 途 · 客3 · 潜");
});

test("formatMd: ISO→26-8-24; 英文Date串兼容; 非法/空输入绝不输出NaN", () => {
  assert.equal(formatMd("2026-08-24T03:01:00.000Z"), "26-8-24");
  assert.equal(formatMd("2026-08-24"), "26-8-24");
  // PGLite timestamptz 曾被 String() 序列化为英文本地串(旧数据/旧产物)
  assert.equal(formatMd("Mon Aug 24 2026 03:01:00 GMT+0800 (China Standard Time)"), "26-8-24");
  assert.equal(formatMd(""), "");
  assert.equal(formatMd(null), "");
  assert.equal(formatMd(undefined), "");
  assert.equal(formatMd("garbage"), "");
  assert.match(formatMd("Mon Aug 24 2026 03:01:00 GMT+0800"), /^\d{2}-\d{1,2}-\d{1,2}$/);
  // 单数字月日不补零
  assert.equal(formatMd("2026-09-05T00:00:00Z"), "26-9-5");
});

test("formatStockLine: 多仓多批聚合展示（验收4 的展示面）", () => {
  const line = formatStockLine(
    [
      { code: "HK", qty: 8000 },
      { code: "坂田", qty: 1000 },
      { code: "交通", qty: 0 },
    ],
    10000,
    "8/28",
  );
  assert.equal(line, "HK 8K · 坂田 1K · 途 10K · 8/28");
});
