import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const importSource = await readFile(new URL("../../src/lib/server/import.ts", import.meta.url), "utf8");
const importContractSource = await readFile(
  new URL("../../src/lib/server/import-contract.ts", import.meta.url),
  "utf8",
);

test("decimal price duplicate checks stay numeric during deterministic validation", () => {
  assert.match(importSource, /price_amount,\s*-1::numeric/);
  assert.match(importSource, /priceAmount \?\? null\}\s*::numeric/);
});

test("Radar import has no fixture-specific aliases for unknown supplier headers", () => {
  const forbiddenFixtureHeaders = /\bItem Code\b|\bAvailable\b|\bMaker\b|\bLot\b|货号|可供|原厂|周期/;
  assert.doesNotMatch(importSource, forbiddenFixtureHeaders);
  assert.doesNotMatch(importContractSource, forbiddenFixtureHeaders);
});

test("import remains candidate-first with an explicit human confirm boundary", () => {
  assert.match(importSource, /confirmImport/);
  assert.match(importSource, /preview/);
});
