/**
 * Radar Import contract routing — CASE 1–9.
 * Production change that would make these fail: treating needsAgent+empty
 * candidates as Platform failure and succeeding via headerKey/heuristicParse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { headerKey, heuristicParse, tableToRows } from "../../packages/harness-import/src/index.ts";
import {
  interpretPlatformExtract,
  isControlledImportText,
  isTrustedImportTable,
  resolveImportExtract,
} from "../../src/lib/server/import-contract.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const INTERNAL_TABLE = [
  ["型号", "品牌", "数量", "批次", "价格", "货期", "仓库"],
  ["TPS54560DDAR", "TI", "10K", "2418", "$1.15", "现货", "香港"],
];

const UNKNOWN_EN_TABLE = [
  ["Part Number", "Maker", "Available", "Target", "Leadtime"],
  ["TPS54560DDAR", "TI", "10000", "1.15", "spot"],
];

const UNKNOWN_ZH_TABLE = [
  ["货号", "品牌", "库存数", "含税单价"],
  ["TPS54560DDAR", "TI", "10000", "1.15"],
];

const CHAT_TEXT = `老陈那边 TI 54560 还有一批
10K
24+
香港现货
一块一美金左右`;

const CONTROLLED_TEXT = `TPS7A4700RGWR  20K  24+  TP  LT 4周
STM32F103C8T6  10K  2418  $1.15  现货`;

test("CASE 1: trusted internal Excel is deterministic and does not call Platform", async () => {
  assert.equal(isTrustedImportTable(INTERNAL_TABLE), true);
  let calledPlatform = false;
  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "excel" },
    {
      readTable: async () => INTERNAL_TABLE,
      extractViaPlatform: async () => {
        calledPlatform = true;
        return { status: 200, body: { needsAgent: true, candidates: [] } };
      },
    },
  );
  assert.equal(calledPlatform, false);
  assert.equal(out.extractOrigin, "trusted_template");
  assert.equal(out.extractState, "completed");
  assert.equal(out.usedAi, false);
  assert.equal(out.rows[0].mpn, "TPS54560DDAR");
  assert.equal(out.rows[0].qty, 10000);
});

test("CASE 2: unknown English Excel must not succeed via headerKey guessing", async () => {
  assert.equal(headerKey("Part Number"), "mpn", "fuzzy helper still exists");
  assert.equal(isTrustedImportTable(UNKNOWN_EN_TABLE), false);
  const guessed = tableToRows(UNKNOWN_EN_TABLE, "offer");
  assert.ok(guessed.length > 0, "old headerKey would succeed — that is the bug");

  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "excel" },
    {
      readTable: async () => UNKNOWN_EN_TABLE,
      extractViaPlatform: async () => ({
        status: 200,
        body: {
          ok: true,
          needsAgent: true,
          reason: "table_mapping_required",
          candidates: [],
          preview: { headers: UNKNOWN_EN_TABLE[0], sample: [UNKNOWN_EN_TABLE[1]] },
        },
      }),
    },
  );
  assert.equal(out.extractState, "needs_mapping");
  assert.equal(out.rows.length, 0);
  assert.notEqual(out.extractOrigin, "trusted_template");
});

test("CASE 3: unknown Chinese Excel (货号) is unbounded, not the internal whitelist", async () => {
  assert.equal(isTrustedImportTable(UNKNOWN_ZH_TABLE), false);
  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "excel" },
    {
      readTable: async () => UNKNOWN_ZH_TABLE,
      extractViaPlatform: async () => ({
        status: 200,
        body: { needsAgent: true, reason: "table_mapping_required", candidates: [] },
      }),
    },
  );
  assert.equal(out.extractState, "needs_mapping");
  assert.equal(out.rows.length, 0);
});

test("CASE 4: WeChat/chat text must not let heuristicParse become the primary result", async () => {
  assert.equal(isControlledImportText(CHAT_TEXT), false);
  const heuristicHits = heuristicParse(CHAT_TEXT, "offer");
  assert.ok(heuristicHits.length > 0, "heuristic would steal the chat text — that is the bug");

  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "text", text: CHAT_TEXT },
    {
      extractViaPlatform: async () => ({
        status: 200,
        body: { needsAgent: true, reason: "unstructured_required", candidates: [] },
      }),
    },
  );
  assert.notEqual(out.extractOrigin, "controlled_text");
  assert.equal(out.rows.length, 0);
  assert.ok(out.extractState === "needs_mapping" || out.extractState === "agent_unavailable");
});

test("CASE 5: controlled offer lines may use deterministic fast path without Platform", async () => {
  assert.equal(isControlledImportText(CONTROLLED_TEXT), true);
  let calledPlatform = false;
  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "text", text: CONTROLLED_TEXT },
    {
      extractViaPlatform: async () => {
        calledPlatform = true;
        return { status: 500, body: null, failureReason: "server_error" };
      },
    },
  );
  assert.equal(calledPlatform, false);
  assert.equal(out.extractOrigin, "controlled_text");
  assert.equal(out.extractState, "completed");
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].mpn, "TPS7A4700RGWR");
});

test("CASE 6: vision_unavailable is not a generic empty-candidate failure", async () => {
  const interp = interpretPlatformExtract({
    status: 422,
    failureReason: "http_error",
    body: { ok: false, error: "vision_unavailable", candidates: [] },
  });
  assert.equal(interp.state, "vision_unavailable");

  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "image", fileBase64: "not-a-png", mime: "image/png" },
    {
      extractViaPlatform: async () => ({
        status: 422,
        body: { ok: false, error: "vision_unavailable", candidates: [] },
      }),
      runLocalImageFallback: async () => ({
        rows: [{ mpn: "TPS54560DDAR", kind: "offer" }],
        usedAi: true,
      }),
    },
  );
  assert.equal(out.extractState, "vision_unavailable");
  assert.equal(out.extractOrigin, "local_fallback");
  assert.equal(out.usedAi, true);
  assert.equal(out.rows[0].mpn, "TPS54560DDAR");
});

test("CASE 7: Platform transport failure keeps Import usable without arbitrary Excel regex success", async () => {
  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "excel" },
    {
      readTable: async () => UNKNOWN_EN_TABLE,
      extractViaPlatform: async () => ({
        status: 0,
        body: null,
        failureReason: "network_error",
      }),
    },
  );
  assert.equal(out.extractState, "platform_unavailable");
  assert.equal(out.rows.length, 0, "must not headerKey-succeed unknown Excel");
});

test("CASE 8: ambiguous MPN is not autocompleted to TPS54560DDAR", async () => {
  const rows = tableToRows(
    [
      ["型号", "数量"],
      ["TPS54560DDA?", "10K"],
    ],
    "offer",
  );
  assert.equal(rows[0].mpn, "TPS54560DDA?");
  assert.notEqual(rows[0].mpn, "TPS54560DDAR");

  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "excel" },
    {
      readTable: async () => [
        ["型号", "数量"],
        ["TPS54560DDA?", "10K"],
      ],
      extractViaPlatform: async () => {
        throw new Error("trusted template must not call Platform");
      },
    },
  );
  assert.equal(out.rows[0].mpn, "TPS54560DDA?");
});

test("CASE 9: needsAgent + empty candidates must not enter arbitrary Excel regex success", async () => {
  const interp = interpretPlatformExtract({
    status: 200,
    body: { needsAgent: true, reason: "table_mapping_required", candidates: [] },
  });
  assert.equal(interp.state, "needs_mapping");
  assert.equal(interp.rows.length, 0);

  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "excel" },
    {
      readTable: async () => UNKNOWN_EN_TABLE,
      extractViaPlatform: async () => ({
        status: 200,
        body: { needsAgent: true, reason: "table_mapping_required", candidates: [] },
      }),
    },
  );
  assert.equal(out.extractState, "needs_mapping");
  assert.deepEqual(out.rows, []);
});

test("Platform completed candidates become preview rows with origin=platform", async () => {
  const out = await resolveImportExtract(
    { kind: "offer", sourceType: "excel" },
    {
      readTable: async () => UNKNOWN_EN_TABLE,
      extractViaPlatform: async () => ({
        status: 200,
        body: {
          ok: true,
          needsAgent: false,
          usedAi: true,
          candidates: [{ mpn: "TPS54560DDAR", brand: "TI", qty: 10000 }],
        },
      }),
    },
  );
  assert.equal(out.extractState, "completed");
  assert.equal(out.extractOrigin, "platform");
  assert.equal(out.usedAi, true);
  assert.equal(out.rows[0].mpn, "TPS54560DDAR");
});

test("agent_unavailable fallbackFrom is not treated as regex-success", () => {
  const interp = interpretPlatformExtract({
    status: 200,
    body: {
      needsAgent: true,
      reason: "table_mapping_required",
      fallbackFrom: "agent_unavailable",
      candidates: [],
    },
  });
  assert.equal(interp.state, "agent_unavailable");
  assert.equal(interp.rows.length, 0);
});

test("parseImport no longer treats needsAgent empty as Platform failure then headerKey", () => {
  const src = readFileSync(join(root, "src/lib/server/import.ts"), "utf8");
  const client = readFileSync(join(root, "src/lib/server/agent-platform.ts"), "utf8");
  assert.match(src, /resolveImportExtract/);
  assert.match(src, /export const confirmImport/);
  assert.doesNotMatch(client, /needsAgent \? null/);
});
