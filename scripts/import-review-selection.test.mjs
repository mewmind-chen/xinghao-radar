import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inquiryReviewBlockingReason,
  inquiryReviewStatus,
  fillMissingCustomer,
  selectionState,
  withSelectedIds,
} from "../src/lib/import-review.ts";

function row(id, selected = false, extra = {}) {
  return {
    id,
    kind: "inquiry",
    mpn: `MPN-${id}`,
    brand: null,
    qty: 1,
    qtyRaw: "1",
    dateCode: null,
    priceAmount: null,
    priceCurrency: null,
    priceTax: null,
    isTp: false,
    leadTimeText: null,
    etaText: null,
    warehouse: null,
    channel: null,
    customer: "客户A",
    package: null,
    standardPack: null,
    packState: null,
    costAmount: null,
    costCurrency: null,
    costTax: null,
    note: null,
    duplicate: false,
    duplicateReason: null,
    selected,
    warning: null,
    ...extra,
  };
}

test("询价预览：7行选5行时表头为半选，确认数量为5", () => {
  const rows = Array.from({ length: 7 }, (_, index) => row(String(index + 1), index < 5));
  const selectedIds = new Set(rows.filter((item) => item.selected).map((item) => item.id));
  const state = selectionState(rows, new Set(rows.map((item) => item.id)), selectedIds);
  assert.equal(state.selectedCount, 5);
  assert.equal(state.allEligibleSelected, false);
  assert.equal(state.someEligibleSelected, true);
});

test("批量选择和取消一行后正确回到半选，清空后为0", () => {
  const rows = Array.from({ length: 7 }, (_, index) => row(String(index + 1)));
  const allIds = new Set(rows.map((item) => item.id));
  let selectedIds = new Set(allIds);
  assert.equal(selectionState(rows, allIds, selectedIds).allEligibleSelected, true);
  selectedIds.delete("7");
  assert.equal(selectionState(rows, allIds, selectedIds).someEligibleSelected, true);
  selectedIds = new Set();
  assert.equal(selectionState(rows, allIds, selectedIds).selectedCount, 0);
  assert.equal(
    withSelectedIds(rows, selectedIds).some((item) => item.selected),
    false,
  );
});

test("正式询价七行案例：4个单型号可直接确认，3个多候选型号阻断", () => {
  const rows = [
    row("single-1", false, {
      mpn: "BTS6143D",
      priceAmount: 1.08,
      priceCurrency: "USD",
      warning: "图片识别来源",
    }),
    row("single-2", false, {
      mpn: "BSC023N08NS5SC",
      priceAmount: 1.05,
      priceCurrency: "USD",
      warning: "图片识别来源",
    }),
    row("single-3", false, {
      mpn: "SAK-XC167CI-16F40F BB",
      priceAmount: 1.06,
      priceCurrency: "USD",
      warning: "图片识别来源",
    }),
    row("single-4", false, {
      mpn: "IPD90N04S4-04",
      priceAmount: 0.6,
      priceCurrency: "USD",
      warning: "图片识别来源",
    }),
    row("candidate-1", false, {
      mpn: "TDA21472 / TDA21472AUMA1",
      priceAmount: 0.79,
      priceCurrency: "USD",
    }),
    row("candidate-2", false, {
      mpn: "TDA21490 / TDA21490AUMA1",
      priceAmount: 15,
      priceCurrency: "USD",
    }),
    row("candidate-3", false, {
      mpn: "TDA21590 / TDA21490AUMA1",
      priceAmount: 0.2,
      priceCurrency: "USD",
    }),
  ];
  const eligibleIds = new Set(
    rows.filter((item) => !inquiryReviewBlockingReason(item, "客户A")).map((item) => item.id),
  );
  assert.equal(eligibleIds.size, 4);
  assert.deepEqual(
    rows.map((item) => inquiryReviewStatus(item, inquiryReviewBlockingReason(item, "客户A")).label),
    ["待确认", "待确认", "待确认", "待确认", "需修改", "需修改", "需修改"],
  );
  const selectedIds = new Set(eligibleIds);
  const state = selectionState(rows, eligibleIds, selectedIds);
  assert.equal(state.selectedCount, 4);
  assert.equal(state.allEligibleSelected, true);
  assert.equal(state.someEligibleSelected, false);
});

test("阻断行不计入可选数量，也不会被批量选中", () => {
  const rows = [row("ok"), row("blocked", false, { mpn: "A / B" })];
  const eligibleIds = new Set(["ok"]);
  const state = selectionState(rows, eligibleIds, new Set(["ok"]));
  assert.equal(state.eligibleCount, 1);
  assert.equal(state.selectedEligibleCount, 1);
  assert.equal(state.allEligibleSelected, true);
  assert.equal(state.selectedCount, 1);
});

test("客户询价TP是独立字段，合法TP不再被预览阻断", () => {
  assert.equal(
    inquiryReviewBlockingReason(
      row("tp", false, { priceAmount: 1.08, priceCurrency: "USD" }),
      "客户A",
    ),
    null,
  );
  assert.equal(inquiryReviewBlockingReason(row("empty"), "客户A"), null);
});

test("统一设置客户只填充空白行，并清除受影响行的确认状态", () => {
  const rows = [
    row("CUSTOMER-EMPTY-A", true, { customer: null }),
    row("CUSTOMER-EXISTING", true, { customer: "已有客户" }),
    row("CUSTOMER-BLANK", true, { customer: "  " }),
  ];
  const result = fillMissingCustomer(rows, "统一客户");
  assert.equal(result.affectedCount, 2);
  assert.deepEqual(
    result.rows.map((item) => [item.customer, item.selected]),
    [["统一客户", false], ["已有客户", true], ["统一客户", false]],
  );
});
