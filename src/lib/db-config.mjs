/**
 * Resolve the database mode once, before either application database or auth
 * database is created. Production must opt into one backend explicitly so a
 * missing variable cannot silently switch the live app to another database.
 *
 * @typedef {"pglite" | "postgres"} DatabaseMode
 * @typedef {{ mode: DatabaseMode, databaseUrl: string | undefined, runtime: string, production: boolean }} DatabaseConfig
 */

const VALID_MODES = new Set(["pglite", "postgres"]);

/** @param {Record<string, string | undefined>} [env] @returns {DatabaseConfig} */
export function readDatabaseConfig(
  env = typeof process !== "undefined" ? process.env : {},
) {
  const runtime = String(env.RADAR_RUNTIME || "development").trim().toLowerCase();
  const production = runtime === "production";
  const databaseUrl = String(env.DATABASE_URL || "").trim() || undefined;
  const rawMode = String(env.RADAR_DB_MODE || "").trim().toLowerCase();

  if (rawMode && !VALID_MODES.has(rawMode)) {
    throw new Error(
      `RADAR_DB_MODE 必须是 pglite 或 postgres，当前值为 ${rawMode}`,
    );
  }

  if (production && !rawMode) {
    throw new Error(
      "生产环境必须明确配置 RADAR_DB_MODE=pglite 或 RADAR_DB_MODE=postgres",
    );
  }

  /** @type {DatabaseMode} */
  const mode = /** @type {DatabaseMode} */ (
    rawMode || (databaseUrl ? "postgres" : "pglite")
  );

  if (mode === "postgres" && !databaseUrl) {
    throw new Error("RADAR_DB_MODE=postgres 时必须配置 DATABASE_URL");
  }
  if (mode === "pglite" && databaseUrl) {
    throw new Error(
      "RADAR_DB_MODE=pglite 时不得同时配置 DATABASE_URL；请明确选择一个数据库",
    );
  }

  return { mode, databaseUrl, runtime, production };
}

/** @returns {readonly DatabaseMode[]} */
export function databaseModes() {
  return ["pglite", "postgres"];
}
