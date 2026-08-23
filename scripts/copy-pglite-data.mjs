import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(root, "node_modules/@electric-sql/pglite/dist");
const targetDir = resolve(root, ".vercel/output/functions/__server.func/_libs");

const runtimeFiles = readdirSync(sourceDir).filter((name) => /\.(wasm|data)$/.test(name));
if (runtimeFiles.length === 0) {
  throw new Error(`PGlite runtime files are missing: ${sourceDir}`);
}

mkdirSync(targetDir, { recursive: true });
for (const name of runtimeFiles) {
  const source = resolve(sourceDir, name);
  const target = resolve(targetDir, name);
  statSync(source);
  copyFileSync(source, target);
  console.log(`[build] copied PGlite runtime: ${target}`);
}
