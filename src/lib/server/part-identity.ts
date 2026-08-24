/**
 * 型号身份修正的纯函数 —— 无 server 依赖链（供 server fn 与 Node --test 直跑）。
 */

import { brandShort } from "../domain.ts";

/**
 * 品牌名清理：分析带入的品牌原文（如 "ADI(亚德诺)"、"TI(德州仪器)"）
 * 取括号前的主 code 再走 brandShort 映射；无效时返回 null。
 */
export function cleanBrand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const before = s.split(/[（(]/)[0].trim();
  return brandShort(before || s);
}