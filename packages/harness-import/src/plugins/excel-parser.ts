/**
 * excel-parser —— 读取 xlsx/xls 首个工作表为字符串矩阵（必须插件）。
 * 逻辑原样迁移自 src/lib/server/import.ts 的 parseExcel（行为零变化）。
 */

export async function parseExcel(base64: string): Promise<string[][]> {
  const XLSX = await import("xlsx");
  const buf = Buffer.from(base64, "base64");
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: false });
  return json.map((row) => (row ?? []).map((c) => String(c ?? "").trim()));
}
