#!/usr/bin/env node
/**
 * Deploy-time database migrator (node-postgres, `pg`).
 *
 * Runs during `npm run build` for the Postgres mode, applying pending files in
 * ../migrations to DATABASE_URL. Each file is applied in one transaction and
 * recorded in a `_migrations` table, so it runs once and is safe to re-run.
 *
 * The app's local email/password auth is enabled, so the Better Auth schema
 * under migrations/auth/ is included explicitly alongside the app migrations.
 *
 * PGlite mode exits without opening Postgres; the application applies the same
 * files at startup against its configured persistent directory instead.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { pendingMigrations } from "./migration-plan.mjs";
import { readDatabaseConfig } from "../src/lib/db-config.mjs";

const databaseConfig = readDatabaseConfig(process.env);
if (databaseConfig.mode === "pglite") {
  console.log(
    "[migrate] database mode=pglite — migrations run at application startup against the configured persistent directory.",
  );
  process.exit(0);
}
const databaseUrl = databaseConfig.databaseUrl;
if (!databaseUrl) throw new Error("RADAR_DB_MODE=postgres 时缺少 DATABASE_URL");

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main() {
  let entries;
  try {
    entries = await readdir(migrationsDir);
  } catch {
    console.log("[migrate] no migrations/ directory — nothing to do.");
    return;
  }
  const migrationPaths = entries
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => join(migrationsDir, entry));
  let authEntries = [];
  try {
    authEntries = await readdir(join(migrationsDir, "auth"));
  } catch {
    // The auth schema is optional for older workspaces.
  }
  migrationPaths.push(
    ...authEntries
      .filter((entry) => entry.endsWith(".sql"))
      .map((entry) => join(migrationsDir, "auth", entry)),
  );
  if (pendingMigrations(migrationPaths, []).length === 0) {
    console.log("[migrate] no migrations — nothing to do.");
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const applied = (await client.query("SELECT name FROM _migrations")).rows.map(
      (r) => r.name,
    );

    let count = 0;
    for (const { name, path } of pendingMigrations(migrationPaths, applied)) {
      const text = await readFile(path, "utf8");
      try {
        await client.query("BEGIN");
        // pg's simple-query protocol runs a whole multi-statement file at once.
        await client.query(text);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (err) {
        console.error(`[migrate] error applying ${name}`);
        try {
          await client.query("ROLLBACK");
        } catch {
          // ROLLBACK fails when the connection died — keep the original error.
        }
        throw err;
      }
      console.log(`[migrate] applied ${name}`);
      count += 1;
    }
    console.log(count ? `[migrate] done — ${count} migration(s) applied.` : "[migrate] up to date.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err?.message || err);
  // pg errors carry the context needed to debug a bad SQL file.
  for (const key of ["code", "detail", "hint", "position", "where"]) {
    if (err?.[key] != null) console.error(`[migrate]   ${key}: ${err[key]}`);
  }
  process.exit(1);
});
