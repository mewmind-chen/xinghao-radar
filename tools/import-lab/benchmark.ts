import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractImport, OpenRouterProvider, type SourceType } from "../../packages/import-engine/src/index.ts";

const fixtureDir = resolve(process.argv[2] || "tests/radar-agent-import-recovery");

function sourceType(filename: string): SourceType | null {
  const name = filename.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) return "excel";
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "csv";
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx") || name.endsWith(".doc")) return "docx";
  if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp") || name.endsWith(".svg")) return "image";
  return null;
}

const files = (await readdir(fixtureDir)).filter((name) => sourceType(name) && !name.startsWith("production-"));
const provider = new OpenRouterProvider();
const output: unknown[] = [];
for (const filename of files) {
  const type = sourceType(filename)!;
  const bytes = new Uint8Array(await readFile(join(fixtureDir, filename)));
  const mime = type === "image" ? (filename.endsWith(".svg") ? "image/svg+xml" : `image/${filename.split(".").pop()}`) : undefined;
  const result = await extractImport({
    source: { type, filename, mime, content: bytes },
    kindHint: "mixed",
  }, provider);
  output.push({
    filename,
    sourceType: type,
    status: result.status,
    route: result.route,
    rowCount: result.rows.length,
    mpns: result.rows.map((row) => row.mpn).slice(0, 20),
    issueCodes: result.issues.map((item) => item.code),
    runs: result.runs,
  });
}
console.log(JSON.stringify({ fixtureDir, model: provider.model, providerAvailable: provider.available(), cases: output }, null, 2));
