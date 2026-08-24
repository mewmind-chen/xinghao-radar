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
  assert.match(src, /getRadarPartContext/);
  assert.match(src, /\/api\/agent\/lookup\.full/);
});

test("Radar agent client has no Harness types", () => {
  const src = readFileSync(join(root, "src/lib/server/agent-platform.ts"), "utf8");
  assert.match(src, /\/v1\/import\/extract/);
  assert.match(src, /\/v1\/parts\/research/);
  assert.match(src, /context/);
  assert.match(src, /mode: "auto"/);
  assert.doesNotMatch(src, /mode: "agent"/);
  assert.doesNotMatch(src, /@deepseek-ai/);
  assert.doesNotMatch(src, /defineTool/);
});

test("Radar uses its dedicated platform token and does not reuse AGENT_API_TOKEN", () => {
  const src = readFileSync(join(root, "src/lib/server/agent-platform.ts"), "utf8");
  assert.match(src, /ELECTRONICS_AGENT_PLATFORM_TOKEN/);
  assert.doesNotMatch(src, /process\.env\.AGENT_API_TOKEN/);
});

test("Radar analysis degrades provider and Platform failures into a safe HQB fallback", () => {
  const src = readFileSync(join(root, "src/lib/server/knowledge.ts"), "utf8");
  const flow = readFileSync(join(root, "src/lib/server/part-analysis-flow.ts"), "utf8");
  assert.match(src, /analyzePartMpnWithDependencies/);
  assert.match(flow, /context_provider_unavailable/);
  assert.match(flow, /platform_unavailable/);
  assert.match(flow, /lookupFallback/);
});

test("Radar human review is persisted locally and never sent to the platform", () => {
  const knowledge = readFileSync(join(root, "src/lib/server/knowledge.ts"), "utf8");
  const analysisDb = readFileSync(join(root, "src/lib/server/analysis-db.ts"), "utf8");
  const ui = readFileSync(join(root, "src/routes/parts.$partId.tsx"), "utf8");
  const migration = readFileSync(join(root, "migrations/0004_part_analysis_review.sql"), "utf8");
  const client = readFileSync(join(root, "src/lib/server/agent-platform.ts"), "utf8");

  assert.match(knowledge, /export const submitPartReview/);
  assert.match(knowledge, /修正需要 correctedJson/);
  assert.match(knowledge, /saveAnalysisReview/);
  assert.match(analysisDb, /insert into part_analysis_reviews/);
  assert.match(migration, /corrected_json/);
  assert.match(migration, /check \(decision in \('accept', 'reject', 'corrected'\)\)/);
  assert.match(ui, /submitPartReview/);
  assert.match(ui, /提交修正/);
  assert.match(ui, /correctedJson/);
  assert.doesNotMatch(client, /part_analysis_reviews|submitPartReview|corrected_json/);
  const fn = knowledge.slice(
    knowledge.indexOf("export const submitPartReview"),
    knowledge.indexOf("export const getPartReview"),
  );
  assert.match(fn, /saveAnalysisReview/);
  assert.doesNotMatch(fn, /researchPartViaPlatform|AGENT_API_URL|lookup\.full/);
});

test("Radar context provider is read-only and excludes sensitive business details", () => {
  const src = readFileSync(join(root, "src/lib/server/radar-context-provider.ts"), "utf8");
  assert.match(src, /normalizeMpn/);
  assert.match(src, /getSettings/);
  assert.match(src, /matchFlagsForParts/);
  assert.doesNotMatch(src, /\b(insert|update|delete)\b/i);
  assert.doesNotMatch(src, /customer_name|cost_amount|lot_id|channel_name/i);
  assert.doesNotMatch(src, /Harness|@deepseek-ai|defineTool/);
});
