import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL(".", import.meta.url);
const rootPath = fileURLToPath(root);
const baseUrl = (process.env.PLATFORM_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const token = String(process.env.PLATFORM_TOKEN || "").trim();
const outputPath = process.env.RESULTS_PATH || join(rootPath, "results.json");
const mode = process.env.IMPORT_MODE || "agent";

function safeRoute(route) {
  if (!route || typeof route !== "object") return route ?? null;
  const keys = ["id", "provider", "providerId", "model", "role", "quality", "fallbackCount", "escalated"];
  return Object.fromEntries(keys.filter((key) => key in route).map((key) => [key, route[key]]));
}

function summarize(name, request, status, body, error = null) {
  const b = body && typeof body === "object" ? body : {};
  const mapping = b.mapping && typeof b.mapping === "object" ? b.mapping : null;
  return {
    case: name,
    sourceType: request.sourceType,
    mode: request.mode,
    httpStatus: status,
    ok: b.ok ?? (status >= 200 && status < 300 && !b.error),
    error: b.error ?? (error ? "request_error" : null),
    reason: b.reason ?? (error || null),
    viaHarness: b.viaHarness ?? false,
    route: b.route ?? null,
    toolsCalled: Array.isArray(b.toolsCalled) ? b.toolsCalled : [],
    candidates: Array.isArray(b.candidates) ? b.candidates.length : 0,
    candidateMpns: Array.isArray(b.candidates) ? b.candidates.map((c) => c?.mpn).filter(Boolean) : [],
    mapping: mapping?.columns
      ? { columns: mapping.columns.map((c) => ({ header: c.header, target: c.target })) }
      : mapping,
    modelRoute: safeRoute(b.modelRoute),
    previewRows: Array.isArray(b.preview?.sample) ? b.preview.sample.length : null,
    inputRows: request._inputRows ?? null,
    transportError: error,
  };
}

async function post(name, request) {
  const payload = { ...request };
  delete payload._inputRows;
  try {
    const res = await fetch(`${baseUrl}/v1/import/extract`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return summarize(name, request, res.status, body);
  } catch (err) {
    return summarize(name, request, 0, null, err instanceof Error ? err.message : String(err));
  }
}

async function base64File(name) {
  const bytes = await readFile(new URL(name, root));
  return Buffer.from(bytes).toString("base64");
}

const narrative = "客户今天问两个料：TPS54560DDAR 1000pcs，比较急，STM32F103C8T6 500pcs。都是要现货，前一个最好 24+，后一个批次没有特别要求。";
const standardCsv = "MPN,Quantity,Brand\nTPS54560DDAR,1000,TI\nSTM32F103C8T6,500,ST\n";
const cases = [
  {
    name: "Unknown Excel EN",
    request: {
      kind: "offer",
      sourceType: "excel",
      filename: "unknown-en.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileBase64: await base64File("unknown-en.xlsx"),
      mode,
      _inputRows: 2,
    },
  },
  {
    name: "Unknown Excel CN",
    request: {
      kind: "offer",
      sourceType: "excel",
      filename: "unknown-cn.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileBase64: await base64File("unknown-cn.xlsx"),
      mode,
      _inputRows: 2,
    },
  },
  { name: "Narrative Text", request: { kind: "offer", sourceType: "text", text: narrative, mode } },
  {
    name: "CSV Standard",
    request: { kind: "offer", sourceType: "csv", filename: "standard.csv", text: standardCsv, mode: "auto" },
  },
  {
    name: "CSV Unknown",
    request: {
      kind: "offer",
      sourceType: "csv",
      filename: "unknown-en.csv",
      text: await readFile(new URL("unknown-en.csv", root), "utf8"),
      mode,
      _inputRows: 2,
    },
  },
  {
    name: "Image",
    request: {
      kind: "offer",
      sourceType: "image",
      filename: "unknown-image.png",
      mime: "image/png",
      fileBase64: await base64File("unknown-image.png"),
      mode,
    },
  },
  {
    name: "Large Excel",
    request: {
      kind: "offer",
      sourceType: "excel",
      filename: "unknown-large.xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileBase64: await base64File("unknown-large.xlsx"),
      mode,
      _inputRows: 180,
    },
  },
];

const results = [];
for (const entry of cases) results.push(await post(entry.name, entry.request));
await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, `${JSON.stringify({ baseUrl, mode, results }, null, 2)}\n`));
for (const result of results) console.log(JSON.stringify(result));
