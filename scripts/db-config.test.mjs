import assert from "node:assert/strict";
import { test } from "node:test";
import { readDatabaseConfig } from "../src/lib/db-config.mjs";

const base = { RADAR_RUNTIME: "development", DATA_DIR: "/tmp/radar-data" };

test("development without a database URL defaults to PGlite", () => {
  assert.deepEqual(readDatabaseConfig(base), {
    mode: "pglite",
    databaseUrl: undefined,
    runtime: "development",
    production: false,
  });
});

test("development can explicitly select Postgres", () => {
  assert.equal(
    readDatabaseConfig({ ...base, RADAR_DB_MODE: "postgres", DATABASE_URL: "postgres://test" }).mode,
    "postgres",
  );
});

test("production requires an explicit database mode", () => {
  assert.throws(
    () => readDatabaseConfig({ RADAR_RUNTIME: "production", DATA_DIR: "/srv/data" }),
    /必须明确配置 RADAR_DB_MODE/,
  );
});

test("production PGlite does not need DATABASE_URL", () => {
  assert.equal(
    readDatabaseConfig({ RADAR_RUNTIME: "production", RADAR_DB_MODE: "pglite", DATA_DIR: "/srv/data" }).mode,
    "pglite",
  );
});

test("production Postgres requires DATABASE_URL", () => {
  assert.throws(
    () => readDatabaseConfig({ RADAR_RUNTIME: "production", RADAR_DB_MODE: "postgres" }),
    /必须配置 DATABASE_URL/,
  );
});

test("explicit PGlite rejects an ambiguous DATABASE_URL", () => {
  assert.throws(
    () => readDatabaseConfig({ ...base, RADAR_DB_MODE: "pglite", DATABASE_URL: "postgres://wrong" }),
    /不得同时配置 DATABASE_URL/,
  );
});

test("unknown database modes fail closed", () => {
  assert.throws(
    () => readDatabaseConfig({ ...base, RADAR_DB_MODE: "sqlite" }),
    /必须是 pglite 或 postgres/,
  );
});
