/**
 * 本地持久化 DB —— node:sqlite（Node 内置，零依赖）。
 *
 * 职责：型号分析记录（产品知识面板结果）。业务库 PGLite 为内存实例（重启由
 * seed 重建），分析结果需要跨重启保存的资产，单独落到
 * `<项目根>/data/analyses.db`（DATA_DIR 环境变量可覆盖目录）。
 *
 * - 同步 API：server fn 内调用开销可忽略；文件级持久化天然原子。
 * - busy_timeout 兜底多进程场景（preview/dev 不应并存，此处防御）。
 * - 本模块仅服务端使用（node:sqlite 只在 server 运行时导入）。
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR =
  process.env.DATA_DIR ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../data");
const DB_FILE = join(DATA_DIR, "analyses.db");

declare global {
  // eslint-disable-next-line no-var
  var __analysisDb__: DatabaseSync | undefined;
}

function open(): DatabaseSync {
  // nitro worker / dev HMR 可能多次 import，但 DatabaseSync 每进程只应有一份
  if (typeof globalThis !== "undefined" && globalThis.__analysisDb__) {
    return globalThis.__analysisDb__;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec("pragma busy_timeout = 5000");
  db.exec(
    "create table if not exists part_analyses (" +
      " mpn_key text primary key," +
      " mpn text not null," +
      " analyzed_at text not null," +
      " source_url text," +
      " analysis text not null" +
      ")",
  );
  globalThis.__analysisDb__ = db;
  return db;
}

export function analysisKey(mpn: string): string {
  return mpn.normalize("NFKC").trim().toUpperCase();
}

/** 完整写入（含分析 JSON；按 mpn_key 覆盖）。 */
export function saveAnalysisFull(
  mpn: string,
  record: { analyzedAt: string; sourceUrl?: string; json: string },
): void {
  const db = open();
  db.prepare(
    "insert into part_analyses (mpn_key, mpn, analyzed_at, source_url, analysis) values (?,?,?,?,?)" +
      " on conflict (mpn_key) do update set analyzed_at = excluded.analyzed_at," +
      " source_url = excluded.source_url, analysis = excluded.analysis",
  ).run(analysisKey(mpn), mpn.trim(), record.analyzedAt, record.sourceUrl ?? null, record.json);
}

export type StoredRow = {
  mpn_key: string;
  mpn: string;
  analyzed_at: string;
  source_url: string | null;
  analysis: string;
};

export function getAnalysis(mpn: string): StoredRow | null {
  const db = open();
  const row = db
    .prepare("select mpn_key, mpn, analyzed_at, source_url, analysis from part_analyses where mpn_key = ?")
    .get(analysisKey(mpn)) as StoredRow | undefined;
  return row ?? null;
}

/** 列表摘要：mpn_key → analyzed_at。 */
export function listAnalysisTimes(): Record<string, string> {
  const db = open();
  const rows = db.prepare("select mpn_key, analyzed_at from part_analyses").all() as {
    mpn_key: string;
    analyzed_at: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.mpn_key] = r.analyzed_at;
  return out;
}