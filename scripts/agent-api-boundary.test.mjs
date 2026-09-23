import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

test("Radar import prefers Agent API then local fallback; confirmImport stays local", () => {
  const src = readFileSync(join(root, "src/lib/server/import.ts"), "utf8");
  assert.match(src, /extractViaPlatform/);
  assert.match(src, /resolveImportExtract/);
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

test("Radar manual review feature is fully removed", () => {
  const knowledge = readFileSync(join(root, "src/lib/server/knowledge.ts"), "utf8");
  const analysisDb = readFileSync(join(root, "src/lib/server/analysis-db.ts"), "utf8");
  const ui = readFileSync(join(root, "src/routes/parts.$partId.tsx"), "utf8");
  const client = readFileSync(join(root, "src/lib/server/agent-platform.ts"), "utf8");

  assert.doesNotMatch(knowledge, /submitPartReview|getPartReview|PartReviewInput|PartReviewOutcome|PartReviewLoaded|saveAnalysisReview|getAnalysisReview/);
  assert.doesNotMatch(analysisDb, /part_analysis_reviews|saveReview|getReview|ReviewRecord|ReviewRow/);
  assert.doesNotMatch(ui, /submitPartReview|getPartReview|人工校准|correctedJson/);
  assert.doesNotMatch(client, /part_analysis_reviews|submitPartReview|corrected_json/);
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

test("型号主档「带入分析资料」只读已保存的分析记录，不重抓、不写分析记录", () => {
  const ui = readFileSync(join(root, "src/routes/parts.$partId.tsx"), "utf8");
  const dialog = ui.slice(
    ui.indexOf("function CorrectPartDialog"),
    ui.indexOf("function StockOpDialog"),
  );
  assert.ok(dialog.length > 0, "CorrectPartDialog 必须存在");
  assert.match(dialog, /getPartAnalysis/);
  assert.match(dialog, /带入分析资料/);
  // 旧假功能：按钮文案与重抓外网的分析动作都不得回潮。
  assert.doesNotMatch(dialog, /analyzePartMpn/);
  assert.match(dialog, /已有分析资料，是否一键填写？/);
  // 回填逻辑必须是无外部依赖的纯函数。
  const fill = readFileSync(join(root, "src/lib/part-profile-fill.ts"), "utf8");
  assert.doesNotMatch(fill, /lookupHqb|lookup\.full|saveAnalysis|fetch\(/);
});

test("型号修正必须预检、填写原因并保护目标分析", () => {
  const partsSource = readFileSync(join(root, "src/lib/server/parts.ts"), "utf8");
  const analysisDbSource = readFileSync(join(root, "src/lib/server/analysis-db.ts"), "utf8");
  const partRouteSource = readFileSync(join(root, "src/routes/parts.$partId.tsx"), "utf8");
  const moveSource = analysisDbSource.slice(
    analysisDbSource.indexOf("export async function moveAnalysisKeyPreservingTargetWithSql"),
    analysisDbSource.indexOf("/** @deprecated"),
  );

  assert.match(partsSource, /previewPartIdentityCorrection/);
  assert.match(partsSource, /修正原因不能为空/);
  assert.match(moveSource, /on conflict \(mpn_key\) do nothing/i);
  assert.doesNotMatch(moveSource, /on conflict \(mpn_key\) do update/i);
  assert.match(partRouteSource, /检查影响/);
  assert.match(partRouteSource, /确认修正/);
});
