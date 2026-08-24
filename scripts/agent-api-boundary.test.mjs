import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("Radar import prefers Agent API then local fallback; confirmImport stays local", () => {
  const src = readFileSync(join(root, "src/lib/server/import.ts"), "utf8");
  assert.match(src, /extractViaPlatform/);
  assert.match(src, /heuristicParse/);
  assert.match(src, /export const confirmImport/);
});

test("Radar part analysis prefers platform then Workbench lookup.full", () => {
  const src = readFileSync(join(root, "src/lib/server/knowledge.ts"), "utf8");
  assert.match(src, /researchPartViaPlatform/);
  assert.match(src, /\/api\/agent\/lookup\.full/);
});

test("Radar agent client has no Harness types", () => {
  const src = readFileSync(join(root, "src/lib/server/agent-platform.ts"), "utf8");
  assert.match(src, /\/v1\/import\/extract/);
  assert.match(src, /\/v1\/parts\/research/);
  assert.match(src, /mode: "auto"/);
  assert.doesNotMatch(src, /mode: "agent"/);
  assert.doesNotMatch(src, /@deepseek-ai/);
  assert.doesNotMatch(src, /defineTool/);
});
