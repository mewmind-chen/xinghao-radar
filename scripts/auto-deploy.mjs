#!/usr/bin/env node
/**
 * Poll the merged GitHub main branch and deploy it to the Mac production
 * service.
 *
 * This is intentionally a pull-based deployer. The production Mac does not
 * need an inbound webhook or an exposed deploy endpoint: launchd starts this
 * script periodically, it fetches only origin/main, and it deploys only after
 * the build and checks pass.
 *
 * Runtime safety rules:
 * - a dirty production source checkout aborts instead of being overwritten;
 * - a non-fast-forward history aborts instead of guessing which code wins;
 * - migration changes are blocked unless explicitly enabled;
 * - every release is copied to a new directory and old releases are retained;
 * - a failed service restart restores the previous plist, source, and release.
 */
import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8082;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HEALTH_ATTEMPTS = 45;
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

const NON_RUNTIME_PREFIXES = [".github/", "attachments/", "docs/", "ops/", "tests/"];
const NON_RUNTIME_FILES = new Set(["AGENTS.md", "DEPLOY_LOG.md", "README.md"]);

/**
 * Documentation, fixtures and CI-only changes should update the production
 * source mirror, but should not rebuild and restart the live service.
 */
export function isRuntimePath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  const isScriptTest = normalized.startsWith("scripts/") && normalized.endsWith(".test.mjs");
  return (
    !NON_RUNTIME_FILES.has(normalized) &&
    !NON_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) &&
    normalized !== "scripts/auto-deploy.mjs" &&
    !isScriptTest
  );
}

export function hasMigrationChange(paths) {
  return paths.some((path) => {
    const normalized = String(path).replaceAll("\\", "/");
    return normalized === "migrations" || normalized.startsWith("migrations/");
  });
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatReleaseId(date = new Date(), shortSha = "unknown") {
  const stamp =
    [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate())].join("") +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${stamp}-main-${String(shortSha).slice(0, 12)}`;
}

function envString(env, key, fallback) {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function buildConfig(env = process.env) {
  const sourceDir = resolve(envString(env, "AUTO_DEPLOY_SOURCE_DIR", projectRoot));
  const deployDir = resolve(
    envString(env, "AUTO_DEPLOY_DEPLOY_DIR", join(dirname(sourceDir), "xinghao-radar-deploy")),
  );
  const numeric = (key, fallback) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    sourceDir,
    deployDir,
    releasesDir: join(deployDir, "releases"),
    buildRoot: join(deployDir, ".auto-deploy-worktrees"),
    backupDir: join(deployDir, "backups"),
    lockDir: join(deployDir, ".auto-deploy.lock"),
    plistPath: resolve(
      envString(
        env,
        "AUTO_DEPLOY_PLIST",
        join(homedir(), "Library", "LaunchAgents", "com.xinghao-radar.vite-dev.plist"),
      ),
    ),
    remote: envString(env, "AUTO_DEPLOY_REMOTE", "origin"),
    branch: envString(env, "AUTO_DEPLOY_BRANCH", "main"),
    serviceLabel: envString(env, "AUTO_DEPLOY_SERVICE_LABEL", "com.xinghao-radar.vite-dev"),
    port: numeric("AUTO_DEPLOY_PORT", DEFAULT_PORT),
    commandTimeoutMs: numeric("AUTO_DEPLOY_COMMAND_TIMEOUT_MS", DEFAULT_COMMAND_TIMEOUT_MS),
    healthAttempts: numeric("AUTO_DEPLOY_HEALTH_ATTEMPTS", DEFAULT_HEALTH_ATTEMPTS),
    lockStaleMs: numeric("AUTO_DEPLOY_LOCK_STALE_MS", DEFAULT_LOCK_STALE_MS),
    runTests: env.AUTO_DEPLOY_RUN_TESTS !== "false",
    allowMigrations: env.AUTO_DEPLOY_ALLOW_MIGRATIONS === "true",
    dryRun: env.AUTO_DEPLOY_DRY_RUN === "true",
    git: envString(env, "AUTO_DEPLOY_GIT", "/usr/bin/git"),
    npm: envString(env, "AUTO_DEPLOY_NPM", "npm"),
    node: envString(env, "AUTO_DEPLOY_NODE", process.execPath),
    launchctl: envString(env, "AUTO_DEPLOY_LAUNCHCTL", "/bin/launchctl"),
    plutil: envString(env, "AUTO_DEPLOY_PLUTIL", "/usr/bin/plutil"),
  };
}

function log(message) {
  console.log(`[auto-deploy] ${message}`);
}

function warn(message) {
  console.warn(`[auto-deploy] ${message}`);
}

function commandLabel(file, args) {
  return [file, ...args].join(" ");
}

/** Run a child process while preserving useful build output in launchd logs. */
function run(file, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    quiet = false,
    allowFailure = false,
  } = options;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      if (!quiet) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (!quiet) process.stderr.write(text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = { code: code ?? 1, signal, stdout, stderr };
      if (result.code === 0 || allowFailure) {
        resolvePromise(result);
        return;
      }
      const tail = stderr.trim().split("\n").slice(-12).join("\n");
      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : `exit ${String(result.code)}${signal ? ` (${signal})` : ""}`;
      const detail = tail ? `\n${tail}` : "";
      const error = new Error(`${commandLabel(file, args)}: ${reason}${detail}`);
      error.exitCode = result.code;
      error.signal = signal;
      rejectPromise(error);
    });
  });
}

async function git(config, args, options = {}) {
  return run(config.git, ["-C", config.sourceDir, ...args], {
    timeoutMs: config.commandTimeoutMs,
    quiet: true,
    ...options,
  });
}

async function gitText(config, args) {
  return (await git(config, args)).stdout.trim();
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(config) {
  try {
    await mkdir(config.lockDir);
    await writeFile(
      join(config.lockDir, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = "another run";
    let lockAge = 0;
    try {
      const text = await readFile(join(config.lockDir, "owner.json"), "utf8");
      const parsed = JSON.parse(text);
      owner = `pid ${String(parsed.pid || "unknown")}`;
    } catch {
      // A process can be killed between mkdir and owner.json. Keep the lock
      // until it is old enough; never remove a just-created lock speculatively.
    }
    try {
      lockAge = Date.now() - (await stat(config.lockDir)).mtimeMs;
    } catch {
      return false;
    }
    if (lockAge > config.lockStaleMs) {
      warn(`removing stale deploy lock (${owner}, ${Math.round(lockAge / 60000)}m old)`);
      await rm(config.lockDir, { recursive: true, force: true });
      return acquireLock(config);
    }
    log(`skipping: ${owner} already holds the deploy lock`);
    return false;
  }
}

async function releaseLock(config) {
  await rm(config.lockDir, { recursive: true, force: true });
}

async function isAncestor(config, ancestor, descendant) {
  const result = await git(config, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
  });
  return result.code === 0;
}

async function readPlistValue(config, keyPath) {
  const result = await run(
    config.plutil,
    ["-extract", keyPath, "raw", "-o", "-", config.plistPath],
    { timeoutMs: 10_000, quiet: true, allowFailure: true },
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

async function replacePlistValue(config, keyPath, value) {
  await run(config.plutil, ["-replace", keyPath, "-string", value, config.plistPath], {
    timeoutMs: 10_000,
    quiet: true,
  });
  await run(config.plutil, ["-lint", config.plistPath], {
    timeoutMs: 10_000,
    quiet: true,
  });
}

async function isServiceLoaded(config) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const result = await run(config.launchctl, ["print", `gui/${uid}/${config.serviceLabel}`], {
    timeoutMs: 10_000,
    quiet: true,
    allowFailure: true,
  });
  return result.code === 0;
}

async function stopService(config) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  if (!(await isServiceLoaded(config))) return false;
  await run(config.launchctl, ["bootout", `gui/${uid}`, config.serviceLabel], {
    timeoutMs: 20_000,
    quiet: true,
  });
  return true;
}

async function startService(config) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  await run(config.launchctl, ["bootstrap", `gui/${uid}`, config.plistPath], {
    timeoutMs: 20_000,
    quiet: true,
  });
}

async function waitForHealth(config, expectedRelease) {
  const url = `http://127.0.0.1:${config.port}/healthz`;
  for (let attempt = 1; attempt <= config.healthAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true && body.release === expectedRelease) {
          return body;
        }
      }
    } catch {
      // launchd may still be starting the new Node process.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    if (attempt % 5 === 0) log(`waiting for ${url} (${attempt}/${config.healthAttempts})`);
  }
  throw new Error(`health check did not reach release ${expectedRelease}`);
}

function sanitizeBuildEnv() {
  const env = { ...process.env, NODE_ENV: "production", DATABASE_URL: "" };
  // A build must never receive production credentials or runtime pointers.
  for (const key of [
    "OPENROUTER_API_KEY",
    "ELECTRONICS_AGENT_PLATFORM_TOKEN",
    "RADAR_OUTPUT_DIR",
    "RADAR_RELEASE",
  ]) {
    delete env[key];
  }
  return env;
}

async function verifyOutput(outputDir) {
  const requiredFiles = [
    "config.json",
    "functions/__server.func/index.mjs",
    "functions/__server.func/_libs/pglite.data",
    "functions/__server.func/_libs/pglite.wasm",
    "functions/__server.func/_libs/initdb.wasm",
    "functions/__server.func/pglite.data",
    "functions/__server.func/pglite.wasm",
    "functions/__server.func/initdb.wasm",
  ];
  for (const relative of requiredFiles) {
    const path = join(outputDir, relative);
    const details = await stat(path);
    if (!details.isFile() || details.size <= 0) {
      throw new Error(`build output is invalid: ${relative}`);
    }
  }
  const staticDetails = await stat(join(outputDir, "static"));
  if (!staticDetails.isDirectory()) throw new Error("build output has no static directory");
}

async function uniqueRelease(config, base) {
  let candidate = base;
  for (let suffix = 2; await pathExists(join(config.releasesDir, candidate)); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

async function createBuildWorktree(config, target) {
  await mkdir(config.buildRoot, { recursive: true });
  const worktreeDir = await mkdtemp(join(config.buildRoot, "build-"));
  await rm(worktreeDir, { recursive: true, force: true });
  try {
    await git(config, ["worktree", "add", "--detach", worktreeDir, target], {
      quiet: false,
    });
  } catch (error) {
    await rm(worktreeDir, { recursive: true, force: true });
    throw error;
  }
  return worktreeDir;
}

async function removeBuildWorktree(config, worktreeDir) {
  if (!worktreeDir) return;
  try {
    await git(config, ["worktree", "remove", "--force", worktreeDir]);
  } catch (error) {
    warn(`could not unregister temporary worktree: ${error.message}`);
  }
  await rm(worktreeDir, { recursive: true, force: true });
}

async function buildRelease(config, target, releaseId) {
  let worktreeDir;
  const buildEnv = sanitizeBuildEnv();
  try {
    worktreeDir = await createBuildWorktree(config, target);
    log(`building ${target.slice(0, 12)} in isolated worktree`);
    await run(config.npm, ["ci"], {
      cwd: worktreeDir,
      env: buildEnv,
      timeoutMs: config.commandTimeoutMs,
    });
    if (config.runTests) {
      await run(config.npm, ["run", "typecheck"], {
        cwd: worktreeDir,
        env: buildEnv,
        timeoutMs: config.commandTimeoutMs,
      });
      await run(config.npm, ["test"], {
        cwd: worktreeDir,
        env: buildEnv,
        timeoutMs: config.commandTimeoutMs,
      });
    } else {
      warn("AUTO_DEPLOY_RUN_TESTS=false; typecheck and tests are skipped");
    }
    await run(config.npm, ["run", "build"], {
      cwd: worktreeDir,
      env: buildEnv,
      timeoutMs: config.commandTimeoutMs,
    });

    const builtOutput = join(worktreeDir, ".vercel", "output");
    await verifyOutput(builtOutput);
    await mkdir(config.releasesDir, { recursive: true });
    const actualReleaseId = await uniqueRelease(config, releaseId);
    const releaseDir = join(config.releasesDir, actualReleaseId);
    const stagingDir = join(config.releasesDir, `.${actualReleaseId}.staging-${process.pid}`);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    try {
      await cp(builtOutput, join(stagingDir, "output"), { recursive: true });
      await verifyOutput(join(stagingDir, "output"));
      await writeFile(
        join(stagingDir, "release.json"),
        JSON.stringify(
          {
            release: actualReleaseId,
            commit: target,
            branch: config.branch,
            builtAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await rename(stagingDir, releaseDir);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
    log(`built release ${actualReleaseId}`);
    return { releaseId: actualReleaseId, releaseDir };
  } finally {
    await removeBuildWorktree(config, worktreeDir);
  }
}

async function activateRelease(config, details) {
  const { target, releaseId, releaseDir, previousSource, previousRelease } = details;
  await mkdir(config.backupDir, { recursive: true });
  const backupName = `launchd-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.plist`;
  const plistBackup = join(config.backupDir, backupName);
  await copyFile(config.plistPath, plistBackup);
  let serviceWasLoaded = false;

  try {
    serviceWasLoaded = await stopService(config);
    await git(config, ["switch", "--detach", target], { quiet: false });
    await replacePlistValue(
      config,
      "EnvironmentVariables.RADAR_OUTPUT_DIR",
      join(releaseDir, "output"),
    );
    await replacePlistValue(config, "EnvironmentVariables.RADAR_RELEASE", releaseId);
    await startService(config);
    await waitForHealth(config, releaseId);
    log(`activated ${releaseId}; source=${target.slice(0, 12)}`);
  } catch (error) {
    warn(`activation failed: ${error.message}`);
    warn("rolling back the service configuration and source checkout");
    try {
      await stopService(config);
    } catch (rollbackError) {
      warn(`rollback stop failed: ${rollbackError.message}`);
    }
    try {
      await copyFile(plistBackup, config.plistPath);
      await run(config.plutil, ["-lint", config.plistPath], {
        timeoutMs: 10_000,
        quiet: true,
      });
      await git(config, ["switch", "--detach", previousSource], { quiet: false });
      await startService(config);
      await waitForHealth(config, previousRelease);
      warn(`rollback completed; service remains on ${previousRelease}`);
    } catch (rollbackError) {
      throw new Error(
        `activation failed and rollback failed: ${error.message}; ${rollbackError.message}`,
      );
    }
    throw error;
  } finally {
    // Keep plist backups for audit and manual recovery. They contain only the
    // existing launchd configuration, never database files or build output.
    if (!serviceWasLoaded) log("launchd service was not loaded before activation");
  }
}

function extractCommitFromRelease(release) {
  const match = String(release).match(/(?:^|[-_])([0-9a-f]{7,40})$/i);
  return match?.[1] || null;
}

async function deployOnce(config) {
  await mkdir(config.deployDir, { recursive: true });
  const locked = await acquireLock(config);
  if (!locked) return { status: "locked" };

  try {
    const dirty = (await gitText(config, ["status", "--porcelain"])).trim();
    if (dirty) {
      throw new Error(`production source is dirty; refusing to overwrite it:\n${dirty}`);
    }
    await git(config, [
      "fetch",
      "--quiet",
      "--prune",
      config.remote,
      `refs/heads/${config.branch}:refs/remotes/${config.remote}/${config.branch}`,
    ]);

    const sourceCommit = await gitText(config, ["rev-parse", "HEAD^{commit}"]);
    const targetCommit = await gitText(config, [
      "rev-parse",
      `${config.remote}/${config.branch}^{commit}`,
    ]);
    const currentRelease = await readPlistValue(config, "EnvironmentVariables.RADAR_RELEASE");
    const currentOutput = await readPlistValue(config, "EnvironmentVariables.RADAR_OUTPUT_DIR");
    if (!currentRelease || !currentOutput) {
      throw new Error("production plist is missing RADAR_RELEASE or RADAR_OUTPUT_DIR");
    }
    if (!(await pathExists(currentOutput))) {
      throw new Error(`current production output does not exist: ${currentOutput}`);
    }
    const deployedShort = extractCommitFromRelease(currentRelease);
    if (!deployedShort) {
      throw new Error(`cannot infer deployed commit from RADAR_RELEASE=${currentRelease}`);
    }
    const deployedCommit = await gitText(config, ["rev-parse", `${deployedShort}^{commit}`]);

    if (!(await isAncestor(config, sourceCommit, targetCommit))) {
      throw new Error(
        `production source ${sourceCommit.slice(0, 12)} is not an ancestor of ` +
          `origin/${config.branch} ${targetCommit.slice(0, 12)}; manual review required`,
      );
    }
    if (!(await isAncestor(config, deployedCommit, targetCommit))) {
      throw new Error(
        `deployed commit ${deployedCommit.slice(0, 12)} is not an ancestor of ` +
          `origin/${config.branch} ${targetCommit.slice(0, 12)}; manual review required`,
      );
    }

    const changedPaths = (
      await gitText(config, [
        "diff",
        "--name-only",
        `${deployedCommit}^{commit}`,
        `${targetCommit}^{commit}`,
      ])
    )
      .split("\n")
      .map((path) => path.trim())
      .filter(Boolean);
    const runtimePaths = changedPaths.filter(isRuntimePath);
    const migrationChanged = hasMigrationChange(changedPaths);

    log(
      `remote=${targetCommit.slice(0, 12)} source=${sourceCommit.slice(0, 12)} ` +
        `deployed=${deployedCommit.slice(0, 12)} changed=${changedPaths.length}`,
    );

    if (runtimePaths.length === 0) {
      if (sourceCommit !== targetCommit) {
        await git(config, ["switch", "--detach", targetCommit], { quiet: false });
        log(`source mirror synchronized to ${targetCommit.slice(0, 12)}; no runtime deploy needed`);
      } else {
        log("already synchronized; no runtime deploy needed");
      }
      return { status: "synchronized", targetCommit };
    }

    if (migrationChanged && !config.allowMigrations) {
      throw new Error(
        "migration files changed; automatic deployment is blocked. " +
          "Review/backup the PGlite database, then set AUTO_DEPLOY_ALLOW_MIGRATIONS=true " +
          "for an explicitly approved run",
      );
    }
    if (config.dryRun) {
      log(`dry run: would build and activate ${targetCommit.slice(0, 12)}`);
      return { status: "dry-run", targetCommit };
    }

    const releaseId = formatReleaseId(new Date(), targetCommit.slice(0, 12));
    const release = await buildRelease(config, targetCommit, releaseId);
    await activateRelease(config, {
      target: targetCommit,
      releaseId: release.releaseId,
      releaseDir: release.releaseDir,
      previousSource: sourceCommit,
      previousRelease: currentRelease,
    });
    return { status: "deployed", targetCommit, releaseId: release.releaseId };
  } finally {
    await releaseLock(config);
  }
}

export async function runAutoDeploy(env = process.env) {
  const config = buildConfig(env);
  log(`checking ${config.remote}/${config.branch}`);
  return deployOnce(config);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runAutoDeploy().catch((error) => {
    console.error(`[auto-deploy] FAILED: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
