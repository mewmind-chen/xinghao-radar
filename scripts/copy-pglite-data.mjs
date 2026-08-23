import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceData = resolve(root, "node_modules/@electric-sql/pglite/dist/pglite.data");
const sourceWasm = resolve(root, "node_modules/@electric-sql/pglite/dist/pglite.wasm");
const targetDir = resolve(root, ".vercel/output/functions/__server.func/_libs");
const targetData = resolve(targetDir, "pglite.data");
const targetWasm = resolve(targetDir, "pglite.wasm");

for (const source of [sourceData, sourceWasm]) {
  try {
    statSync(source);
  } catch {
    throw new Error(`PGlite runtime file is missing: ${source}`);
  }
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(sourceData, targetData);
copyFileSync(sourceWasm, targetWasm);
console.log(`[build] copied PGlite runtime: ${targetData}, ${targetWasm}`);
