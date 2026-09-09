import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  buildConfig,
  buildTestEnv,
  formatReleaseId,
  hasMigrationChange,
  isRuntimePath,
  sanitizeBuildEnv,
} from "./auto-deploy.mjs";

test("classifies documentation and fixture changes as non-runtime", () => {
  assert.equal(isRuntimePath("docs/PRODUCTION_OPERATIONS.md"), false);
  assert.equal(isRuntimePath("tests/fixtures/unknown.xlsx"), false);
  assert.equal(isRuntimePath(".github/workflows/quality.yml"), false);
  assert.equal(isRuntimePath("ops/com.xinghao-radar.auto-deploy.plist.example"), false);
  assert.equal(isRuntimePath("scripts/auto-deploy.mjs"), false);
  assert.equal(isRuntimePath("scripts/auto-deploy.test.mjs"), false);
  assert.equal(isRuntimePath("DEPLOY_LOG.md"), false);
  assert.equal(isRuntimePath("src/routes/import.tsx"), true);
  assert.equal(isRuntimePath("scripts/serve-production.mjs"), true);
  assert.equal(isRuntimePath("package-lock.json"), true);
});

test("detects application and auth migrations", () => {
  assert.equal(hasMigrationChange(["src/lib/db.ts"]), false);
  assert.equal(hasMigrationChange(["migrations/0009_integrity_audit.sql"]), true);
  assert.equal(hasMigrationChange(["migrations/auth/0001_auth.sql"]), true);
});

test("release ids contain a sortable timestamp and commit", () => {
  const release = formatReleaseId(new Date("2026-09-09T10:30:05.000Z"), "d5ee2d0b06bdb23");
  assert.equal(release, "20260909-103005-main-d5ee2d0b06bd");
});

test("production config defaults to the sibling operations directory", () => {
  const config = buildConfig({ AUTO_DEPLOY_SOURCE_DIR: "/srv/radar/source" });
  assert.equal(config.deployDir, resolve("/srv/radar/xinghao-radar-deploy"));
  assert.equal(config.remote, "origin");
  assert.equal(config.branch, "main");
  assert.equal(config.allowMigrations, false);
});

test("test commands use test mode while the build keeps production mode", () => {
  const buildEnv = sanitizeBuildEnv({
    NODE_ENV: "development",
    DATABASE_URL: "unexpected",
    OPENROUTER_API_KEY: "placeholder",
    RADAR_OUTPUT_DIR: "/production/output",
    RADAR_RELEASE: "production-release",
  });
  const testEnv = buildTestEnv(buildEnv);
  assert.equal(buildEnv.NODE_ENV, "production");
  assert.equal(testEnv.NODE_ENV, "test");
  assert.equal(buildEnv.DATABASE_URL, "");
  assert.equal(testEnv.DATABASE_URL, "");
  assert.equal("OPENROUTER_API_KEY" in buildEnv, false);
  assert.equal("RADAR_OUTPUT_DIR" in buildEnv, false);
  assert.equal("RADAR_RELEASE" in buildEnv, false);
});
