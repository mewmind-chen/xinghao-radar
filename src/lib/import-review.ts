import type { ImportRow } from "@/lib/types";

export type InquiryReviewStatus = {
  label: "待确认" | "已确认" | "需修改" | "重复";
  detail: string | null;
};

/** A slash/pipe/“或” separated value is a candidate list, not an MPN. */
export function isCompositeMpn(mpn: string): boolean {
  return /\s*(?:\/|\||／|｜)\s*/.test(mpn.trim()) || /\s+或\s+/.test(mpn.trim());
}

/**
 * Inquiry rows with an advisory extraction warning remain selectable. Only
 * data errors that would make a write unsafe are hard blockers.
 */
export function inquiryReviewBlockingReason(
  row: ImportRow,
  defaultCustomer?: string | null,
): string | null {
  if (!row.mpn.trim()) return "型号为空";
  if (isCompositeMpn(row.mpn) || row.warning?.includes("多个型号候选")) {
    return "请选择一个准确型号";
  }
  if (row.brandConflict) return row.brandConflict;
  if (!(row.customer?.trim() || defaultCustomer?.trim())) return "缺少客户";
  if (row.qty != null && (!Number.isInteger(row.qty) || row.qty <= 0)) return "数量必须为正整数";
  if (row.priceAmount != null && (!Number.isFinite(row.priceAmount) || row.priceAmount < 0)) {
    return "TP必须为空或不小于0";
  }
  return null;
}

export function inquiryReviewStatus(row: ImportRow, blocking: string | null): InquiryReviewStatus {
  if (row.duplicate) return { label: "重复", detail: row.duplicateReason };
  if (blocking) return { label: "需修改", detail: blocking };
  if (row.selected) return { label: "已确认", detail: null };
  return { label: "待确认", detail: null };
}

export function fillMissingCustomer(
  rows: ReadonlyArray<ImportRow>,
  customer: string,
): { rows: ImportRow[]; affectedCount: number } {
  const name = customer.trim();
  if (!name) return { rows: rows.map((row) => ({ ...row })), affectedCount: 0 };
  let affectedCount = 0;
  const nextRows = rows.map((row) => {
    if (row.customer?.trim()) return { ...row };
    affectedCount += 1;
    return { ...row, customer: name, selected: false };
  });
  return { rows: nextRows, affectedCount };
}

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
