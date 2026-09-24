/**
 * Analysis-result persistence.
 *
 * Production writes to the application's configured Postgres through the
 * shared SQL layer; local/offline development uses that same layer's durable
 * PGLite store. This keeps analysis records out of serverless-local SQLite and
 * makes them readable after a cold start.
 */
import type { Sql } from "../db";

export function analysisKey(mpn: string): string {
  return mpn.normalize("NFKC").trim().toUpperCase();
}

export type StoredRow = {
  mpn_key: string;
  mpn: string;
  analyzed_at: string;
  source_url: string | null;
  analysis: string;
};

export type AnalysisRecord = {
  analyzedAt: string;
  sourceUrl?: string;
  json: string;
};

export type AnalysisMoveResult =
  | "unchanged"
  | "moved"
  | "target-preserved"
  | "source-missing";

export type AnalysisRepository = {
  saveAnalysisFull(mpn: string, record: AnalysisRecord): Promise<void>;
  getAnalysis(mpn: string): Promise<StoredRow | null>;
  listAnalysisTimes(): Promise<Record<string, string>>;
  moveAnalysisKey(fromMpn: string, toMpn: string): Promise<AnalysisMoveResult>;
};

/**
 * Serialize writes for analysis keys, including keys that do not have rows yet.
 * Call this inside a transaction; sorted acquisition prevents A→B / B→A deadlocks.
 */
export async function lockAnalysisKeysWithSql(sql: Sql, mpns: string[]): Promise<void> {
  const keys = [...new Set(mpns.map(analysisKey).filter(Boolean))].sort();
  for (const key of keys) {
    await sql.query(
      "select pg_advisory_xact_lock(hashtextextended('radar:part-analysis:' || $1, 0))",
      [key],
    );
  }
}

async function inTransactionIfAvailable<T>(
  sql: Sql,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.transaction ? sql.transaction(fn) : fn(sql);
}

/** Build a repository over either deployed Postgres or local PGLite. */
export function createAnalysisRepository(sql: Sql): AnalysisRepository {
  return {
    async saveAnalysisFull(mpn, record) {
      await inTransactionIfAvailable(sql, async (tx) => {
        await lockAnalysisKeysWithSql(tx, [mpn]);
        await tx.query(
          "insert into part_analyses (mpn_key, mpn, analyzed_at, source_url, analysis) values ($1, $2, $3, $4, $5) " +
            "on conflict (mpn_key) do update set mpn = excluded.mpn, analyzed_at = excluded.analyzed_at, " +
            "source_url = excluded.source_url, analysis = excluded.analysis",
          [analysisKey(mpn), mpn.trim(), record.analyzedAt, record.sourceUrl ?? null, record.json],
        );
      });
    },

    async getAnalysis(mpn) {
      const rows = await sql.query<StoredRow>(
        "select mpn_key, mpn, analyzed_at, source_url, analysis from part_analyses where mpn_key = $1",
        [analysisKey(mpn)],
      );
      return rows[0] ?? null;
    },

    async listAnalysisTimes() {
      const rows = await sql.query<{ mpn_key: string; analyzed_at: string }>(
        "select mpn_key, analyzed_at from part_analyses",
      );
      return Object.fromEntries(rows.map((row) => [row.mpn_key, row.analyzed_at]));
    },

    async moveAnalysisKey(fromMpn, toMpn) {
      if (analysisKey(fromMpn) === analysisKey(toMpn)) return "unchanged";
      return inTransactionIfAvailable(sql, (tx) =>
        moveAnalysisKeyPreservingTargetWithSql(tx, fromMpn, toMpn),
      );
    },
  };
}

/**
 * Move an analysis key using the caller's transaction connection without ever
 * replacing an analysis already stored under the target key.
 */
export async function moveAnalysisKeyPreservingTargetWithSql(
  sql: Sql,
  fromMpn: string,
  toMpn: string,
): Promise<AnalysisMoveResult> {
  const fromKey = analysisKey(fromMpn);
  const toKey = analysisKey(toMpn);
  if (fromKey === toKey || !fromKey || !toKey) return "unchanged";

  await lockAnalysisKeysWithSql(sql, [fromKey, toKey]);

  const rows = await sql.query<{
    source_exists: boolean;
    target_exists: boolean;
    moved: boolean;
  }>(
    "with locked as materialized (" +
      "select mpn_key, analyzed_at, source_url, analysis from part_analyses " +
      "where mpn_key in ($1, $3) order by mpn_key for update" +
      "), source as materialized (" +
      "select mpn_key, analyzed_at, source_url, analysis from locked where mpn_key = $3" +
      "), target_before as materialized (" +
      "select mpn_key from locked where mpn_key = $1" +
      "), moved as (" +
      "insert into part_analyses (mpn_key, mpn, analyzed_at, source_url, analysis) " +
      "select $1, $2, analyzed_at, source_url, analysis from source " +
      "where not exists (select 1 from target_before) " +
      "on conflict (mpn_key) do nothing returning mpn_key" +
      "), deleted as (" +
      "delete from part_analyses where mpn_key = $3 and exists (select 1 from moved) returning mpn_key" +
      ") select exists(select 1 from source) as source_exists, " +
      "exists(select 1 from target_before) as target_exists, " +
      "exists(select 1 from moved) as moved",
    [toKey, toMpn.trim(), fromKey],
  );

  const state = rows[0];
  if (state?.moved) return "moved";
  if (!state?.source_exists) return "source-missing";
  return "target-preserved";
}

/** @deprecated Use moveAnalysisKeyPreservingTargetWithSql for explicit semantics. */
export const moveAnalysisKeyWithSql = moveAnalysisKeyPreservingTargetWithSql;

async function repository(): Promise<AnalysisRepository> {
  const { getSql } = await import("../db");
  return createAnalysisRepository(await getSql());
}

/** 完整写入（含分析 JSON；按 mpn_key 覆盖）。 */
export async function saveAnalysisFull(mpn: string, record: AnalysisRecord): Promise<void> {
  await (await repository()).saveAnalysisFull(mpn, record);
}

export async function getAnalysis(mpn: string): Promise<StoredRow | null> {
  return (await repository()).getAnalysis(mpn);
}

/** 列表摘要：mpn_key → analyzed_at。 */
export async function listAnalysisTimes(): Promise<Record<string, string>> {
  return (await repository()).listAnalysisTimes();
}

/** 主档修正后安全处理分析键；目标分析存在时保留双方记录。 */
export async function moveAnalysisKey(
  fromMpn: string,
  toMpn: string,
): Promise<AnalysisMoveResult> {
  return moveAnalysisKeyPreservingTargetWithSql(
    await (await import("../db")).getSql(),
    fromMpn,
    toMpn,
  );
}
