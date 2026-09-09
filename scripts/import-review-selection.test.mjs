import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inquiryTpPersistenceIssue,
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
  assert.equal(withSelectedIds(rows, selectedIds).some((item) => item.selected), false);
});

test("阻断行不计入可选数量，也不会被批量选中", () => {
  const rows = [row("ok"), row("blocked", false, { warning: "待确认" })];
  const eligibleIds = new Set(["ok"]);
  const state = selectionState(rows, eligibleIds, new Set(["ok"]));
  assert.equal(state.eligibleCount, 1);
  assert.equal(state.selectedEligibleCount, 1);
  assert.equal(state.allEligibleSelected, true);
  assert.equal(state.selectedCount, 1);
});

test("客户询价TP未有独立字段时必须阻止写入，非询价不阻止", () => {
  assert.match(
    inquiryTpPersistenceIssue(row("tp", false, { priceAmount: 1.08 }), "inquiry"),
    /TP.*写入已阻止/,
  );
  assert.equal(inquiryTpPersistenceIssue(row("offer", false, { priceAmount: 1.08 }), "offer"), null);
  assert.equal(inquiryTpPersistenceIssue(row("empty"), "inquiry"), null);
});
