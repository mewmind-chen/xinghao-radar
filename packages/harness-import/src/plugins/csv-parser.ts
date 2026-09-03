/**
 * csv-parser —— CSV / Tab 表格 → 字符串矩阵（必须插件）。
 * 逻辑原样迁移自 src/lib/server/import.ts 的 parseCsv（行为零变化）。
 */

export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => line.split(",").flatMap((segment) => segment.split("\t")).map((c) => c.trim().replace(/^"|"$/g, "")));
}
