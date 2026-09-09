import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  countRows,
  openLegacyDatabase,
  seedContinuityData,
} from "./rehearsal-fixtures.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDir = resolve(root, ".vercel/output");
const runner = resolve(root, "scripts/serve-production.mjs");
const rehearsalRoot = mkdtempSync(join(tmpdir(), "xinghao-radar-production-pglite-"));
const dataRoot = join(rehearsalRoot, "data");
const dataDir = join(dataRoot, "pglite");
mkdirSync(dataDir, { recursive: true });

const baseEnv = {
  ...process.env,
  RADAR_RUNTIME: "production",
  RADAR_DB_MODE: "pglite",
  DATA_DIR: dataRoot,
  RADAR_HOST: "127.0.0.1",
  RADAR_PORT: "18442",
  RADAR_OUTPUT_DIR: outputDir,
  RADAR_RELEASE: "pr14-pglite-rehearsal",
  BETTER_AUTH_URL: "http://127.0.0.1:18442",
  DATABASE_URL: "",
};

function startServer(env) {
  const child = spawn(process.execPath, [runner], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return { child, getOutput: () => `${stdout}\n${stderr}` };
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("production rehearsal process did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await waitForExit(server.child);
}

async function waitForHealth(server) {
  const url = `${baseEnv.BETTER_AUTH_URL}/healthz`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (server.child.exitCode !== null) {
      throw new Error(`production server exited early: ${server.getOutput()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The server is still bootstrapping its bundled database.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`production server health check timed out: ${server.getOutput()}`);
}

async function seedOldData() {
  const db = await openLegacyDatabase(dataDir, { trackMigrations: true });
  await seedContinuityData(db);
  await db.close();
}

async function assertPersistedData() {
  const db = await openLegacyDatabase(dataDir);
  assert.equal(await countRows(db, "parts", "continuity-part"), 1);
  assert.equal(await countRows(db, "stock_lots", "continuity-lot"), 1);
  assert.equal(await countRows(db, "channel_offers", "continuity-offer"), 1);
  assert.equal(await countRows(db, "customer_inquiries", "continuity-inquiry"), 1);
  assert.equal(await countRows(db, "import_batches", "continuity-batch"), 1);
  const migrations = await db.query(
    "select count(*)::int as count from _migrations where name = '0009_integrity_audit.sql'",
  );
  assert.equal(migrations.rows[0].count, 1);
  await db.close();
}

try {
  await seedOldData();

  const first = startServer(baseEnv);
  const health = await waitForHealth(first);
  assert.deepEqual(await health.json(), { ok: true, release: "pr14-pglite-rehearsal" });
  const session = await fetch(`${baseEnv.BETTER_AUTH_URL}/api/auth/get-session`, {
    headers: { accept: "application/json" },
  });
  assert.equal(session.status, 200);
  await stopServer(first);
  await assertPersistedData();

  const second = startServer(baseEnv);
  await waitForHealth(second);
  await stopServer(second);
  await assertPersistedData();

  const invalid = startServer({
    ...baseEnv,
    RADAR_PORT: "18443",
    BETTER_AUTH_URL: "http://127.0.0.1:18443",
    DATA_DIR: join(rehearsalRoot, "does-not-exist"),
  });
  const invalidExit = await waitForExit(invalid.child);
  assert.notEqual(invalidExit.code, 0);
  assert.match(invalid.getOutput(), /不会创建空库|DATA_DIR/);

  console.log("production PGlite rehearsal passed: health, auth bootstrap, persistence, restart, migration idempotency, and invalid DATA_DIR fail-closed");
} finally {
  rmSync(rehearsalRoot, { recursive: true, force: true });
}
