import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractImport, OpenRouterProvider, type ExtractRequest, type SourceType } from "../../packages/import-engine/src/index.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.IMPORT_LAB_PORT || 8090);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CALLS_PER_HOUR = 20;
const callWindow = new Map<string, { startedAt: number; count: number }>();

type IncomingPayload = {
  source?: { type?: SourceType; filename?: string; mime?: string; text?: string; contentBase64?: string };
  kindHint?: ExtractRequest["kindHint"];
  modelMode?: "primary" | "compare";
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function radarAccess(req: IncomingMessage): Promise<{ subject: string; role: string } | null> {
  if (process.env.IMPORT_LAB_DEV_AUTH === "true" && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")) {
    return { subject: "local-dev", role: "老板" };
  }
  const cookie = readHeader(req, "cookie");
  const authorization = readHeader(req, "authorization");
  if (!cookie && !authorization) return null;
  const bridge = process.env.RADAR_AUTH_BRIDGE_URL || "http://127.0.0.1:8082/api/import-lab/access";
  try {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    if (authorization) headers.set("authorization", authorization);
    const response = await fetch(bridge, { headers, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const body = await response.json() as { allowed?: boolean; subject?: string; role?: string };
    const subject = body.subject;
    const role = body.role;
    if (!body.allowed || !subject || !role || !["老板", "最高督察"].includes(role)) return null;
    return { subject, role };
  } catch {
    return null;
  }
}

function consumeRate(subject: string): boolean {
  const now = Date.now();
  const current = callWindow.get(subject);
  if (!current || now - current.startedAt >= 60 * 60 * 1000) {
    callWindow.set(subject, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_CALLS_PER_HOUR) return false;
  current.count++;
  return true;
}

async function body(req: IncomingMessage): Promise<string> {
  const contentLength = Number(readHeader(req, "content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new Error("request_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decode(value: string): Uint8Array {
  const buffer = Buffer.from(value, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function makeRequest(payload: IncomingPayload): ExtractRequest {
  const source = payload.source;
  if (!source || !source.type || !["text", "excel", "csv", "image", "pdf", "docx"].includes(source.type)) throw new Error("invalid_source");
  const content = source.type === "text" ? String(source.text || "") : decode(String(source.contentBase64 || ""));
  return {
    requestId: crypto.randomUUID(),
    source: { type: source.type, filename: source.filename, mime: source.mime, content },
    kindHint: payload.kindHint && ["offer", "inquiry", "stock", "transit", "mixed"].includes(payload.kindHint) ? payload.kindHint : "mixed",
    modelMode: payload.modelMode === "compare" ? "compare" : "primary",
  };
}

async function runExtract(req: IncomingMessage): Promise<unknown> {
  const auth = await radarAccess(req);
  if (!auth) return { status: 401, body: { error: "unauthorized", message: "请先登录Radar，只有老板和最高督察可使用Import Lab" } };
  if (!consumeRate(auth.subject)) return { status: 429, body: { error: "rate_limited", message: "本账号本小时模型调用次数已达上限" } };
  let payload: IncomingPayload;
  try { payload = JSON.parse(await body(req)) as IncomingPayload; }
  catch (error) { return { status: error instanceof Error && error.message === "request_too_large" ? 413 : 400, body: { error: "invalid_request", message: "请求内容无效或超过32MB" } }; }
  let request: ExtractRequest;
  try { request = makeRequest(payload); }
  catch { return { status: 400, body: { error: "invalid_source", message: "输入类型或内容无效" } }; }

  if (request.modelMode === "compare" && !process.env.IMPORT_LAB_COMPARE_MODEL?.trim()) {
    return { status: 400, body: { error: "compare_model_unconfigured", message: "尚未配置 IMPORT_LAB_COMPARE_MODEL" } };
  }
  const primary = await extractImport(request, new OpenRouterProvider());
  if (request.modelMode !== "compare") return { status: 200, body: { primary } };
  const compareModel = process.env.IMPORT_LAB_COMPARE_MODEL?.trim();
  if (!compareModel) return { status: 400, body: { error: "compare_model_unconfigured", message: "尚未配置 IMPORT_LAB_COMPARE_MODEL" } };
  const comparison = await extractImport(request, new OpenRouterProvider({ model: compareModel, modelEnv: "IMPORT_LAB_COMPARE_MODEL" }));
  return { status: 200, body: { primary, comparison } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/import-lab/api/health") { json(res, 200, { ok: true, service: "import-lab" }); return; }
  if (url.pathname === "/import-lab/api/extract" && req.method === "POST") {
    const result = await runExtract(req) as { status: number; body: unknown };
    json(res, result.status, result.body);
    return;
  }
  if (url.pathname === "/import-lab" || url.pathname === "/import-lab/") {
    const html = await readFile(join(ROOT, "index.html"), "utf8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(html);
    return;
  }
  res.statusCode = 404;
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[import-lab] listening on http://127.0.0.1:${PORT}/import-lab/`);
});
