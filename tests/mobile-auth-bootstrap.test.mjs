import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile auth bootstrap is bounded and targets older WebViews", async () => {
  const [client, shell, vite] = await Promise.all([
    readFile("src/lib/auth/client.ts", "utf8"),
    readFile("src/components/app-shell.tsx", "utf8"),
    readFile("vite.config.ts", "utf8"),
  ]);

  assert.match(client, /fetchOptions:\s*\{[\s\S]*?timeout:\s*10_000/);
  assert.match(vite, /build:\s*\{\s*target:\s*\["es2018",\s*"safari13"\]/);
  assert.match(shell, /typeof media\.addEventListener === "function"/);
  assert.match(shell, /media\.addListener\(update\)/);
});
