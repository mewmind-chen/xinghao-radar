import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@electric-sql/pglite/dist/pglite.data");
const target = resolve(root, ".vercel/output/functions/__server.func/_libs/pglite.data");

try {
  statSync(source);
} catch {
  throw new Error(`PGlite data file is missing: ${source}`);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[build] copied PGlite data: ${target}`);
