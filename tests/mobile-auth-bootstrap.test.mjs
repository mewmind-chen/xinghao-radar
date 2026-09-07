import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function runWatchdog(scriptSource) {
  const listeners = new Map();
  const panels = [];
  const timers = [];
  let reloaded = false;
  const button = {
    addEventListener(type, callback) {
      this[type] = callback;
    },
  };
  const document = {
    body: { appendChild: (node) => panels.push(node) },
    createElement: () => ({
      setAttribute() {},
      style: {},
      querySelector: () => button,
    }),
    getElementById: () => panels.find((panel) => panel.id === "radar-startup-failure"),
  };
  const window = {
    console: { error() {} },
    clearTimeout() {},
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    location: { reload: () => (reloaded = true) },
  };

  vm.runInNewContext(scriptSource, { window, document });
  return { button, listeners, panels, timers, wasReloaded: () => reloaded };
}

test("mobile auth bootstrap is bounded and targets older WebViews", async () => {
  const [authClient, clientEntry, watchdog, root, shell, vite] = await Promise.all([
    readFile("src/lib/auth/client.ts", "utf8"),
    readFile("src/client.tsx", "utf8"),
    readFile("src/lib/startup-watchdog.ts", "utf8"),
    readFile("src/routes/__root.tsx", "utf8"),
    readFile("src/components/app-shell.tsx", "utf8"),
    readFile("vite.config.ts", "utf8"),
  ]);

  assert.match(authClient, /fetchOptions:\s*\{[\s\S]*?timeout:\s*10_000/);
  assert.match(vite, /build:\s*\{\s*target:\s*\["es2018",\s*"safari13"\]/);
  assert.match(shell, /typeof media\.addEventListener === "function"/);
  assert.match(shell, /media\.addListener\(update\)/);

  // `src/client.tsx` is TanStack Start's conventional custom client entry;
  // this import appears before the hydration imports, so legacy WebViews gain
  // replaceAll before router restoration runs.
  assert.match(clientEntry, /import "core-js\/actual\/string\/replace-all";/);
  assert.ok(
    clientEntry.indexOf('import "core-js/actual/string/replace-all"') <
      clientEntry.indexOf('import { hydrateRoot }'),
  );
  assert.match(clientEntry, /window\.__radarStartup\?\.markReady\(\)/);
  assert.match(root, /startupWatchdogScript/);
  assert.match(root, /dangerouslySetInnerHTML/);
  assert.match(watchdog, /页面加载失败/);
  assert.match(watchdog, /重新加载/);
  assert.match(watchdog, /script_load_failed/);
  assert.match(watchdog, /hydration_timeout/);
  assert.doesNotMatch(watchdog, /error\.message|event\.message|location\.href/);

  const template = watchdog.match(/export const startupWatchdogScript = `([\s\S]*?)`;/)?.[1];
  assert.ok(template, "watchdog script is available to the SSR document");
  const script = template.replace("${STARTUP_WATCHDOG_TIMEOUT_MS}", "10000");

  const scriptFailure = runWatchdog(script);
  scriptFailure.listeners.get("error")({ target: { tagName: "SCRIPT", type: "module" } });
  assert.equal(scriptFailure.panels.length, 1);
  assert.match(scriptFailure.panels[0].innerHTML, /页面加载失败/);
  assert.match(scriptFailure.panels[0].innerHTML, /重新加载/);
  scriptFailure.button.click();
  assert.equal(scriptFailure.wasReloaded(), true);

  const optionalAssetFailure = runWatchdog(script);
  optionalAssetFailure.listeners.get("error")({ target: { tagName: "LINK" } });
  assert.equal(optionalAssetFailure.panels.length, 0);

  const timeoutFailure = runWatchdog(script);
  timeoutFailure.timers[0]();
  assert.equal(timeoutFailure.panels.length, 1);
});
