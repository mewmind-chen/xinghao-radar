# Radar Agent-first Import Recovery

Date: 2026-08-25
Scope: Radar Import only. Part, Company, Market Source, and unrelated Source Runtime work were frozen.

## Baseline and root causes

- Radar production baseline was `4f08291` (`main`). The page shell, Router, PGlite bootstrap, and runtime assets were not changed.
- The first production blocker was deterministic duplicate detection: `price_amount` is numeric, but the SQL `coalesce(..., -1)` sentinel made PGlite infer an integer parameter. A valid decimal such as `1.32` therefore failed before Preview. The fix casts both operands and the sentinel to `numeric`.
- The independent Platform blocker was contract validation scanning `JSON.stringify(request)` for forbidden write/SQL words. Opaque image bytes (and ordinary prose containing `sql`) could match by chance, so an image was rejected with HTTP 422 before Harness. The Platform fix scans structural fields and semantic values while treating file bytes and user text as opaque data.
- This was not caused by Firecrawl, AnySearch, ICNet, or Mouser. The zero-source run below removed all four source credentials and still reached the official Harness.

## Official runtime evidence

The post-fix `mode=agent` calls returned `viaHarness=true` and `route=harness`. They also returned actual `import_*` tool calls, not a generic web result or a local fallback. The tabular/text route was `opencode-go / deepseek-v4-flash`; the image route selected the existing image-capable policy `deepseek-official / deepseek-v4-flash-vision-exp`. No model name was added or hard-coded for this recovery.

The common observed tool chain was:

`import_classify → import_table_preview → import_validate_mapping → import_apply_mapping → import_normalize_text → import_validate_rows`

The event order is runtime-dependent; `results.json` records the returned set. The agent decides semantic mapping/extraction only. Import Core reads the original rows, applies the mapping, normalizes and validates them, and creates Candidates.

## Unknown supplier mapping

The English fixture was deliberately not added to any header alias table:

```text
Item Code → mpn
Available → qty
Maker     → brand
Lot       → dateCode
```

The Chinese fixture was also unseen by deterministic aliases:

```text
货号 → mpn
可供 → qty
原厂 → brand
周期 → dateCode
```

No new `Item Code`, `Available`, `Maker`, `Lot`, `货号`, `可供`, `原厂`, or `周期` aliases were added to Radar. The architecture regression test fails if those fixture-specific headers appear in the import implementation.

## Large Excel boundary

The 180-row unknown Excel produced 180 Candidates and an 8-row bounded preview sample. Only the header and bounded sample were sent to the Agent for semantic mapping; deterministic Core applied the resulting mapping to all 180 original rows. The model did not rewrite the full table row-by-row.

## Narrative, CSV, and image

- Narrative text produced two Candidates: `TPS54560DDAR` and `STM32F103C8T6`. The original MPN characters were retained; quantity and urgency/lot semantics were extracted through the Harness and then validated by Core.
- Standard CSV was exercised in `mode=auto`; it is allowed to remain deterministic when unambiguous. The current runtime selected Harness and still returned two Candidates. Unknown CSV was forced through `mode=agent` and returned the same semantic mapping as the unknown Excel.
- The synthetic image contains the two MPNs, quantities, brands, and lot notes. After the opaque-payload fix it reached the image-capable Harness route and returned two Candidates.

## ZERO-SOURCE-KEY acceptance

The verification container was started without:

```text
FIRECRAWL_API_KEY=false
ANYSEARCH_API_KEY=false
ICNET_COOKIE=false
MOUSER_API_KEY=false
```

Import Excel, narrative text, unknown CSV, and image all passed with `viaHarness=true`, `route=harness`, and non-empty `import_*` tool calls. The only credential used was the existing Harness model access; its value is not present in this evidence.

## Radar production page

`https://radar.newmindchen.com/import` returned HTTP 200 and was exercised with narrative text, unknown Excel, unknown CSV, and image. Each produced a visible `预览 2 行 · AI 识别（Platform）` state with two Candidates. No destructive Confirm was executed. The configured Cloudflare ingress maps this production hostname to the existing Radar service at `127.0.0.1:8082`; no new server, domain, or deployment architecture was introduced.

## Narrative request-budget recovery

The final production blocker was in Radar's Platform client, not in Import semantics. Before this fix, `src/lib/server/agent-platform.ts` passed a hard-coded `30_000` ms timeout to `AbortSignal.timeout`. Platform's HTTP guard had a separate `120_000` ms deadline and continued the Harness request after Radar aborted, so the page classified the transport abort as `timeout` and entered the existing text `local_fallback` path. The DSH tool execution bound is `60_000` ms per tool call; it is not a shorter total Import request bound.

Commit `7fea69e` introduced the named `AGENT_IMPORT_REQUEST_BUDGET_MS = 150_000` constant. This leaves a finite 30-second transport buffer above Platform's 120-second deadline, while keeping Part's existing request budget unchanged. The fallback semantics are unchanged for a genuine Platform 504 or unavailable runtime.

After deploying the fix branch to the existing production service, the same Narrative fixture passed five consecutive times:

| Run | elapsedMs | viaHarness | route | Preview rows | timeout |
|---:|---:|---:|---|---:|---:|
| 1 | 51581 | true | harness | 2 | false |
| 2 | 45779 | true | harness | 2 | false |
| 3 | 27617 | true | harness | 2 | false |
| 4 | 57609 | true | harness | 2 | false |
| 5 | 100296 | true | harness | 2 | false |

The same post-fix production run also passed Unknown Excel (`45044ms`, 2 rows), Unknown CSV (`16713ms`, 2 rows), and Image (`18247ms`, 2 rows), all with `viaHarness=true` and `route=harness`. No Confirm was executed.

The product boundary remains:

`Extract → Candidate → Preview → Human Review → Confirm → Radar DB`

Agent Import never writes Radar DB. `confirmImport` remains the explicit human-controlled write boundary.

## Regression checks

- Radar: `npm run typecheck` passed; `npm test` passed **237/237** (235 baseline tests plus two timeout regressions); `npm run build` passed and verified `pglite.data`, `pglite.wasm`, and `initdb.wasm` in the production output.
- Platform: `npm test` passed **161/161** on `fix/agent-import-recovery`; the only Platform files in this branch are the structural opaque-data validation fix and its contract regression test.
- No Part, Company, Market Source, Firecrawl, AnySearch, ICNet, Mouser, Plugin, or new database schema changes are included.

Machine-readable case results, model routes, mappings, tool calls, source-key state, and production-page observations are in `results.json`; timeout-specific smoke measurements are in `timeout-smoke-results.json`.
