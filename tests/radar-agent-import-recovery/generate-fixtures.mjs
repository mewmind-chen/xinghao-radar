import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const root = dirname(fileURLToPath(import.meta.url));
await mkdir(root, { recursive: true });

const rows = [
  ["Item Code", "Available", "Maker", "Lot", "Remark"],
  ["TPS54560DDAR", "1200", "TI", "24+", "ready stock"],
  ["STM32F103C8T6", "500", "ST", "23+", "customer asking"],
];
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Offers");
XLSX.writeFile(workbook, join(root, "unknown-en.xlsx"));

const largeRows = [rows[0]];
for (let i = 0; i < 180; i += 1) {
  const mpn = i % 2 === 0 ? "TPS54560DDAR" : "STM32F103C8T6";
  largeRows.push([mpn, String(100 + i), i % 2 === 0 ? "TI" : "ST", i % 3 === 0 ? "24+" : "23+", "ready stock"]);
}
const largeWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(largeWorkbook, XLSX.utils.aoa_to_sheet(largeRows), "Offers");
XLSX.writeFile(largeWorkbook, join(root, "unknown-large.xlsx"));

await writeFile(
  join(root, "unknown-cn.csv"),
  "货号,可供,原厂,周期,说明\nTPS54560DDAR,1200,TI,24+,ready stock\nSTM32F103C8T6,500,ST,现货,customer asking\n",
  "utf8",
);
await writeFile(
  join(root, "unknown-en.csv"),
  "Item Code,Available,Maker,Lot,Remark\nTPS54560DDAR,1200,TI,24+,ready stock\nSTM32F103C8T6,500,ST,23+,customer asking\n",
  "utf8",
);

const cnWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  cnWorkbook,
  XLSX.utils.aoa_to_sheet([
    ["货号", "可供", "原厂", "周期", "说明"],
    ["TPS54560DDAR", "1200", "TI", "24+", "ready stock"],
    ["STM32F103C8T6", "500", "ST", "现货", "customer asking"],
  ]),
  "Offers",
);
XLSX.writeFile(cnWorkbook, join(root, "unknown-cn.xlsx"));
