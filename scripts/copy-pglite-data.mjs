import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(root, "node_modules/@electric-sql/pglite/dist");
const targetDir = resolve(root, ".vercel/output/functions/__server.func/_libs");

// P0 教训（RADAR PRODUCTION CRASH RECOVERY）：
// 曾出现只跑 vite build、缺 pglite.data/.wasm → 生产 DB 全挂、页面崩溃。
// 复制后必须校验目标文件存在且非空，缺失即构建失败，残缺产物不允许上线。
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
  if (!existsSync(target) || statSync(target).size <= 0) {
    throw new Error(`[build] FAILED: PGlite runtime not verifiable at ${target}`);
  }
  console.log(`[build] copied PGlite runtime: ${target}`);
}

// 三大必需文件逐个复核（防止部分复制/被误删）
for (const required of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
  const target = resolve(targetDir, required);
  if (!existsSync(target) || statSync(target).size <= 0) {
    throw new Error(`[build] FAILED: required PGlite runtime missing: ${required}`);
  }
}
console.log("[build] PGlite runtime verified (data/wasm/initdb).");