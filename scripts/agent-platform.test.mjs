import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateToImportRow,
  researchPartViaPlatform,
  researchPartViaPlatformWithOutcome,
} from "../src/lib/server/agent-platform.ts";
import { platformPartToHqb, mapHqbResponse } from "../src/lib/server/knowledge-map.ts";
import { radarContextFromFlags } from "../src/lib/server/radar-context-provider.ts";
import { runPartAnalysisFlow } from "../src/lib/server/part-analysis-flow.ts";

test("platform candidate becomes Radar preview row; write flags stay local", () => {
  const row = candidateToImportRow(
    { kind: "offer", mpn: "TPS54560DDAR", qty: 10000, warnings: [{ message: "qty conflict" }] },
    "offer",
  );
  assert.equal(row.mpn, "TPS54560DDAR");
  assert.equal(row.qty, 10000);
  assert.equal(row.selected, true);
  assert.equal(row.duplicate, false);
  assert.match(row.warning ?? "", /qty conflict/);
});

test("platform part research maps into existing knowledge panel fields", () => {
  const mapped = mapHqbResponse(
    platformPartToHqb({
      ok: true,
      identity: { mpn: "NE555P", brand: "TI", lcscUrl: "https://item.szlcsc.com/1.html", lcscStock: 10 },
      offers: [{ sourceKey: "lcsc", stock: 10, price: 1.2 }],
      dossier: { headline: "555 timer", extra: { what: "通用定时器" } },
      advice: {
        usedInternal: true,
        action: "有库存无询价：控制新进，优先出货",
        internalView: "库存在手 1200（radar），无打开询价。",
        combined: "综合建议：先出库存，不按公开热度加仓。",
      },
      recommendation: { action: "有库存无询价：控制新进，优先出货", reasoning: "综合建议：先出库存。" },
    }),
  );
  assert.equal(mapped.ok, true);
  assert.equal(mapped.resolvedMpn, "NE555P");
  assert.equal(mapped.lcsc?.stock, 10);
  assert.equal(mapped.internalBusinessAdvice?.action, "有库存无询价：控制新进，优先出货");
  assert.match(mapped.internalBusinessAdvice?.reasoning ?? "", /先出库存/);
});

test("Radar context provider reduces match flags to the approved minimal snapshot", () => {
  const context = radarContextFromFlags({
    onHand: 1200,
    inTransit: 300,
    byWarehouse: [
      { id: "wh-1", code: "SZ", qty: 1000 },
      { id: "wh-2", code: "HK", qty: 200 },
    ],
    inquiryCount: 3,
  });
  assert.deepEqual(context, {
    inventory: { source: "radar", onHand: 1200, inTransit: 300, warehouse: "SZ 1000；HK 200" },
    quotation: { source: "radar", openCount: 3, recentCount: 3 },
  });
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /customer|cost|lot|channel/i);
});

test("part research POST carries only the caller's Radar context snapshot", async () => {
  const originalFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await researchPartViaPlatform("TPS54560DDAR", {
      inventory: { source: "radar", onHand: 1200, inTransit: 300, warehouse: "SZ 1000；HK 200" },
      quotation: { source: "radar", openCount: 3, recentCount: 2 },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(sent?.context, {
    inventory: { source: "radar", onHand: 1200, inTransit: 300, warehouse: "SZ 1000；HK 200" },
    quotation: { source: "radar", openCount: 3, recentCount: 2 },
  });
  assert.doesNotMatch(JSON.stringify(sent?.context), /customer|cost|lot|channel/i);
});

test("part research classifies platform failures without exposing response details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream diagnostics must not leak", { status: 503 });
  try {
    const outcome = await researchPartViaPlatformWithOutcome("TPS54560DDAR");
    assert.equal(outcome.result, null);
    assert.equal(outcome.failureReason, "server_error");
    assert.doesNotMatch(JSON.stringify(outcome), /upstream diagnostics/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("part research exposes safe downgrade reasons for 401 and timeout", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 401 });
    assert.equal((await researchPartViaPlatformWithOutcome("TPS54560DDAR")).failureReason, "unauthorized");

    globalThis.fetch = async () => {
      const err = new Error("request aborted");
      err.name = "TimeoutError";
      throw err;
    };
    assert.equal((await researchPartViaPlatformWithOutcome("TPS54560DDAR")).failureReason, "timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider exception still calls Platform without context, then falls back to HQB", async () => {
  const calls = [];
  const result = await runPartAnalysisFlow(" TPS54560DDAR ", {
    getContext: async () => {
      throw new Error("database connection string must not surface");
    },
    researchPlatform: async (mpn, context) => {
      calls.push({ kind: "platform", mpn, context });
      return { result: null, failureReason: "timeout" };
    },
    hasUsablePlatformResult: () => true,
    lookupFallback: async (mpn) => {
      calls.push({ kind: "hqb", mpn });
      return {
        ok: true,
        record: {
          identity: { mpn, brand: "TI", lcscUrl: "https://example.test/part" },
          offers: [{ sourceKey: "lcsc", stock: 12, price: 1.2 }],
        },
      };
    },
    logDegraded: () => {},
  });

  assert.equal(result.source, "fallback");
  assert.deepEqual(calls, [
    { kind: "platform", mpn: "TPS54560DDAR", context: null },
    { kind: "hqb", mpn: "TPS54560DDAR" },
  ]);
});
