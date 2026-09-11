import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "radar-key-config-"));
  try {
    for (const dir of ["Library/LaunchAgents", ".commandcode", ".deepseek", ".dsh"])
      mkdirSync(join(root, dir), { recursive: true });
    const plist = join(root, "Library/LaunchAgents/com.xinghao-radar.vite-dev.plist");
    writeFileSync(plist, "unchanged-dry-run-fixture");
    writeFileSync(
      join(root, ".commandcode/auth.json"),
      JSON.stringify({ apiKey: "fixture-command-secret" }),
    );
    writeFileSync(join(root, ".deepseek/config.toml"), 'api_key = "fixture-deepseek-secret"\n');
    writeFileSync(join(root, ".dsh/.credentials.yaml"), "nested:\n  key: fixture-nested-secret\n");
    const invoke = (...args) =>
      spawnSync("bash", ["scripts/set-import-keys.sh", ...args], {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, RADAR_CONFIG_HOME: root },
        encoding: "utf8",
        timeout: 10000,
      });
    run({ invoke, root, plist });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("key configuration skips missing optional channel and never prints credentials", () =>
  fixture(({ invoke, plist }) => {
    const r = invoke("--chain=command-code,deepseek-api,openrouter");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /command-code,deepseek-api,openrouter/);
    assert.doesNotMatch(r.stdout + r.stderr, /fixture-.*secret/);
    assert.equal(readFileSync(plist, "utf8"), "unchanged-dry-run-fixture");
  }));

test("automatic chain tolerates nested dsh credentials without optional key", () =>
  fixture(({ invoke }) => {
    const r = invoke();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /command-code,deepseek-api,openrouter/);
  }));

test("explicit missing and unknown channels stop before modifying plist", () =>
  fixture(({ invoke, plist }) => {
    for (const chain of ["opencode-go", "typo"]) {
      const r = invoke("--apply", `--chain=${chain}`);
      assert.equal(r.status, 1);
      assert.equal(readFileSync(plist, "utf8"), "unchanged-dry-run-fixture");
    }
  }));

test("automatic chain only includes configured direct channels", () =>
  fixture(({ invoke, root }) => {
    rmSync(join(root, ".commandcode/auth.json"));
    const r = invoke();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /IMPORT_CHAIN\s+= deepseek-api,openrouter/);
  }));

test(
  "apply/reload completes without exposing any environment values",
  { skip: process.platform !== "darwin" },
  () =>
    fixture(({ root, plist }) => {
      const original =
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>OTHER_TOKEN</key><string>unrelated-secret-value</string></dict></dict></plist>';
      writeFileSync(plist, original);
      const bin = join(root, "bin");
      mkdirSync(bin);
      for (const [name, body] of Object.entries({
        launchctl: "exit 0",
        curl: 'printf \'{"ok":true,"release":"test"}\'',
      })) {
        const path = join(bin, name);
        writeFileSync(path, "#!/bin/sh\n" + body + "\n");
        chmodSync(path, 0o700);
      }
      const r = spawnSync(
        "bash",
        [
          "scripts/set-import-keys.sh",
          "--apply",
          "--reload",
          "--chain=command-code,deepseek-api,openrouter",
        ],
        {
          cwd: new URL("..", import.meta.url),
          env: { ...process.env, RADAR_CONFIG_HOME: root, PATH: bin + ":" + process.env.PATH },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /健康检查通过/);
      assert.doesNotMatch(r.stdout + r.stderr, /fixture-.*secret|unrelated-secret-value/);
      const data = JSON.parse(
        spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" })
          .stdout,
      );
      assert.equal(data.EnvironmentVariables.IMPORT_CHAIN, "command-code,deepseek-api,openrouter");
      assert.equal(data.EnvironmentVariables.OTHER_TOKEN, "unrelated-secret-value");
    }),
);

test("failed lint restores the original plist", { skip: process.platform !== "darwin" }, () =>
  fixture(({ root, plist }) => {
    const original =
      '<?xml version="1.0"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict/></dict></plist>';
    writeFileSync(plist, original);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const stub = join(bin, "plutil");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n");
    chmodSync(stub, 0o700);
    const r = spawnSync(
      "bash",
      ["scripts/set-import-keys.sh", "--apply", "--chain=command-code,deepseek-api,openrouter"],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, RADAR_CONFIG_HOME: root, PATH: bin + ":" + process.env.PATH },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(r.status, 1);
    assert.equal(readFileSync(plist, "utf8"), original);
    assert.doesNotMatch(r.stdout + r.stderr, /fixture-.*secret/);
  }),
);
