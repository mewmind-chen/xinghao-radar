/**
 * radar-domain-adapter —— 对宿主确定性规则层的唯一桥接（方案第 7/16 节）。
 *
 * Harness 只做输入理解；数量、成本、货期、仓库别名等一律回落到
 * `src/lib/domain.ts` 的确定性 parser。本模块集中声明这份依赖，
 * 其余 harness 模块只从这里取用，保证单一事实源。
 */

import {
  brandShort,
  correctTradeText,
  displayMpn,
  normalizeMpn,
  parseCost,
  parseLeadTime,
  parseQty,
  resolveWarehouseCode,
} from "../../../src/lib/domain.ts";

export {
  brandShort,
  correctTradeText,
  displayMpn,
  normalizeMpn,
  parseCost,
  parseLeadTime,
  parseQty,
  resolveWarehouseCode,
};

/** 预览行 id：与宿主 helpers.nid 同源（crypto.randomUUID）。 */
export function nid(): string {
  return crypto.randomUUID();
}
