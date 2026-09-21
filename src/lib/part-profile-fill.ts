/**
 * 「带入分析资料」纯函数 —— 从该型号**已保存**的分析记录里推导可回填的主档字段。
 *
 * 只读：不抓外网、不写任何分析记录、不落主档。是否写主档由人手动点「保存」决定。
 * 无 server 依赖链（供对话框与 Node --test 直跑）。
 */

import { cleanBrand } from "./server/part-identity.ts";

/** 分析结果里可回填的四个字段（结构子集，来源 PartKnowledgeAnalysis）。 */
export type ProfileSource = {
  resolvedMpn?: string | null;
  resolvedBrand?: string | null;
  resolvedCategory?: string | null;
  resolvedPackage?: string | null;
};

/** 回填值：型号名会被分析出的完整型号覆盖。 */
export type PartProfileFill = {
  mpn: string;
  brand: string;
  category: string;
  package: string;
};

export type PartProfileFillOutcome =
  | { ok: true; fill: PartProfileFill }
  | { ok: false; reason: "no-record" | "empty"; message: string };

/** 置灰理由文案（按钮旁小字）。 */
export const PART_PROFILE_FILL_REASON: Record<"no-record" | "empty", string> = {
  "no-record": "该型号还没有分析记录，先做一次型号分析才能带入资料",
  empty: "该型号的分析记录里没有完整型号、品牌、类目、封装，无可带入资料",
};

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 分析记录 → 回填值。
 *
 * - `null` / `undefined` 表示查不到记录（`no-record`）；
 * - 四个字段全空表示记录没有可用资料（`empty`）；
 * - 部分有值时只填有值的字段，其余留空由人手工补。
 */
export function buildProfileFill(source: ProfileSource | null | undefined): PartProfileFillOutcome {
  if (!source) {
    return { ok: false, reason: "no-record", message: PART_PROFILE_FILL_REASON["no-record"] };
  }
  const fill: PartProfileFill = {
    mpn: text(source.resolvedMpn),
    // 品牌原文可能带厂商中文名（如 "ADI(亚德诺)"），统一走 cleanBrand 归一。
    brand: cleanBrand(text(source.resolvedBrand)) ?? "",
    category: text(source.resolvedCategory),
    package: text(source.resolvedPackage),
  };
  if (!fill.mpn && !fill.brand && !fill.category && !fill.package) {
    return { ok: false, reason: "empty", message: PART_PROFILE_FILL_REASON.empty };
  }
  return { ok: true, fill };
}
