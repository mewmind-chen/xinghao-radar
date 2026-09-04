import test from "node:test";
import assert from "node:assert/strict";
import { extractImport } from "../packages/import-engine/src/index.ts";

const noProvider = {
  name: "test",
  model: "test",
  available: () => false,
  async extract() { return null; },
};

test("deterministic text extraction preserves multi-DC evidence and standard pack", async () => {
  const result = await extractImport({
    requestId: "date-code-ui-test",
    kindHint: "stock",
    source: {
      type: "text",
      content: "INV-DC-SPLIT-20260904 30000 6包2607+9包2548+ 每包2000片",
    },
  }, noProvider);
  assert.equal(result.status, "completed");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].dateCode, "6包2607+9包2548+");
  assert.equal(result.rows[0].standardPack, "2000");
  assert.equal(result.rows[0].qty, 30000);
});

test("deterministic text extraction keeps descriptive year evidence for normalization", async () => {
  const result = await extractImport({
    requestId: "descriptive-date-code-ui-test",
    kindHint: "offer",
    source: { type: "text", content: "INV-DATE-20260904 10K 2024年以后" },
  }, noProvider);
  assert.equal(result.status, "completed");
  assert.equal(result.rows[0].dateCode, "2024年以后");
});
