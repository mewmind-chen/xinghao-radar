import type { ImportKind, ImportRow } from "@/lib/types";

export type SelectionState = {
  selectedCount: number;
  eligibleCount: number;
  selectedEligibleCount: number;
  allEligibleSelected: boolean;
  someEligibleSelected: boolean;
};

/** Derive bulk-selection state from the actual row id set and current eligibility. */
export function selectionState(
  rows: ReadonlyArray<ImportRow>,
  eligibleIds: ReadonlySet<string>,
  selectedIds: ReadonlySet<string>,
): SelectionState {
  const selectedCount = [...selectedIds].filter((id) => rows.some((row) => row.id === id)).length;
  const eligibleCount = [...eligibleIds].filter((id) => rows.some((row) => row.id === id)).length;
  const selectedEligibleCount = [...eligibleIds].filter((id) => selectedIds.has(id)).length;
  const allEligibleSelected = eligibleCount > 0 && selectedEligibleCount === eligibleCount;
  return {
    selectedCount,
    eligibleCount,
    selectedEligibleCount,
    allEligibleSelected,
    someEligibleSelected: selectedEligibleCount > 0 && !allEligibleSelected,
  };
}

export function selectedRows(rows: ReadonlyArray<ImportRow>, selectedIds: ReadonlySet<string>) {
  return rows.filter((row) => selectedIds.has(row.id));
}

export function withSelectedIds(rows: ReadonlyArray<ImportRow>, selectedIds: ReadonlySet<string>) {
  return rows.map((row) => ({ ...row, selected: selectedIds.has(row.id) }));
}

export function inquiryTpPersistenceIssue(row: ImportRow, selectedKind: ImportKind): string | null {
  const targetKind = selectedKind === "mixed" ? row.kind : selectedKind;
  if (targetKind !== "inquiry") return null;
  if (row.priceAmount == null && row.priceCurrency == null && !row.isTp) return null;
  return "客户询价的 TP 尚无独立数据库字段，本次写入已阻止；请先完成询价 TP 数据模型改造";
}
