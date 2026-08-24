#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const UPSERT = `
  insert into part_analyses (mpn_key, mpn, analyzed_at, source_url, analysis)
  values ($1, $2, $3, $4, $5)
  on conflict (mpn_key) do update set
    mpn = excluded.mpn,
    analyzed_at = excluded.analyzed_at,
    source_url = excluded.source_url,
    analysis = excluded.analysis
  where part_analyses.analyzed_at <= excluded.analyzed_at
`;

export function readLegacyRows(sourceFile) {
  if (!existsSync(sourceFile)) return [];
  const db = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    return db.prepare(
      "select mpn_key, mpn, analyzed_at, source_url, analysis from part_analyses order by analyzed_at",
    ).all();
  } finally {
    db.close();
  }
}

export async function importLegacyRows(rows, target) {
  let imported = 0;
  for (const row of rows) {
    await target.query(UPSERT, [row.mpn_key, row.mpn, row.analyzed_at, row.source_url ?? null, row.analysis]);
    imported += 1;
  }
  return imported;
}

async function openTarget(dataDir) {
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (databaseUrl) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: databaseUrl });
    return {
      kind: "postgres",
      exec: (sql) => pool.query(sql),
      query: (sql, params) => pool.query(sql, params),
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite({ dataDir: join(dataDir, "pglite") });
  await db.waitReady;
  return {
    kind: "pglite",
    exec: (sql) => db.exec(sql),
    query: (sql, params) => db.query(sql, params),
    close: () => db.close(),
  };
}

async function main() {
  const dataDir = resolve(process.env.DATA_DIR || join(process.cwd(), "data"));
  const sourceFile = resolve(process.argv.find((arg) => arg.startsWith("--source="))?.slice(9) || join(dataDir, "analyses.db"));
  const rows = readLegacyRows(sourceFile);
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ dryRun: true, sourceFile, rows: rows.length, next: "rerun with --apply" }));
    return;
  }
  const target = await openTarget(dataDir);
  try {
    const migration = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../migrations/0003_part_analyses.sql", import.meta.url), "utf8"),
    );
    await target.exec(migration);
    const imported = await importLegacyRows(rows, target);
    console.log(JSON.stringify({ dryRun: false, sourceFile, target: target.kind, imported, legacyFilePreserved: true }));
  } finally {
    await target.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
