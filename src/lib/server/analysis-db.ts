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

export type AnalysisRepository = {
  saveAnalysisFull(mpn: string, record: AnalysisRecord): Promise<void>;
  getAnalysis(mpn: string): Promise<StoredRow | null>;
  listAnalysisTimes(): Promise<Record<string, string>>;
  moveAnalysisKey(fromMpn: string, toMpn: string): Promise<void>;
  saveReview(input: ReviewRecord): Promise<void>;
  getReview(mpn: string): Promise<ReviewRow | null>;
};

export type ReviewDecision = "accept" | "reject" | "corrected";

export type ReviewRecord = {
  mpn: string;
  decision: ReviewDecision;
  reviewer?: string;
  note?: string;
  correctedJson?: string;
};

export type ReviewRow = {
  mpn_key: string;
  mpn: string;
  decision: ReviewDecision;
  reviewed_at: string;
  reviewer: string;
  note: string;
  corrected_json: string | null;
};

/** Build a repository over either deployed Postgres or local PGLite. */
export function createAnalysisRepository(sql: Sql): AnalysisRepository {
  return {
    async saveAnalysisFull(mpn, record) {
      await sql.query(
        "insert into part_analyses (mpn_key, mpn, analyzed_at, source_url, analysis) values ($1, $2, $3, $4, $5) " +
          "on conflict (mpn_key) do update set mpn = excluded.mpn, analyzed_at = excluded.analyzed_at, " +
          "source_url = excluded.source_url, analysis = excluded.analysis",
        [analysisKey(mpn), mpn.trim(), record.analyzedAt, record.sourceUrl ?? null, record.json],
      );
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
      const fromKey = analysisKey(fromMpn);
      const toKey = analysisKey(toMpn);
      if (fromKey === toKey || !fromKey || !toKey) return;
      // One statement prevents a cold-start/process interruption from deleting
      // the old record after a failed copy. All values stay parameterized.
      await sql.query(
        "with moved as (" +
          "insert into part_analyses (mpn_key, mpn, analyzed_at, source_url, analysis) " +
          "select $1, $2, analyzed_at, source_url, analysis from part_analyses where mpn_key = $3 " +
          "on conflict (mpn_key) do update set mpn = excluded.mpn, analyzed_at = excluded.analyzed_at, " +
          "source_url = excluded.source_url, analysis = excluded.analysis " +
          "returning mpn_key" +
          ") delete from part_analyses where mpn_key = $3 and exists (select 1 from moved)",
        [toKey, toMpn.trim(), fromKey],
      );
    },

    async saveReview(input) {
      const key = analysisKey(input.mpn);
      await sql.query(
        "insert into part_analysis_reviews (mpn_key, mpn, decision, reviewed_at, reviewer, note, corrected_json) " +
          "values ($1, $2, $3, now(), $4, $5, $6) " +
          "on conflict (mpn_key) do update set mpn = excluded.mpn, decision = excluded.decision, " +
          "reviewed_at = excluded.reviewed_at, reviewer = excluded.reviewer, note = excluded.note, " +
          "corrected_json = excluded.corrected_json",
        [
          key,
          String(input.mpn).trim(),
          input.decision,
          input.reviewer ?? null,
          input.note ?? null,
          input.correctedJson ?? null,
        ],
      );
    },

    async getReview(mpn) {
      const rows = await sql.query<ReviewRow>(
        "select mpn_key, mpn, decision, reviewed_at, reviewer, note, corrected_json " +
          "from part_analysis_reviews where mpn_key = $1",
        [analysisKey(mpn)],
      );
      return rows[0] ?? null;
    },
  };
}

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

/** 主档修正后，把旧 mpn_key 的分析记录迁移到新 key（保留时间戳）。 */
export async function moveAnalysisKey(fromMpn: string, toMpn: string): Promise<void> {
  await (await repository()).moveAnalysisKey(fromMpn, toMpn);
}

/** 记录人对该型号分析的人工决定（接受/拒绝/修正）。Radar 拥有最终决定。 */
export async function saveAnalysisReview(input: ReviewRecord): Promise<void> {
  await (await repository()).saveReview(input);
}

export async function getAnalysisReview(mpn: string): Promise<ReviewRow | null> {
  return (await repository()).getReview(mpn);
}
