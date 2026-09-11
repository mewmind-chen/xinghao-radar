import { IMPORT_SYSTEM_PROMPT, MAPPING_SCHEMA, ROW_SCHEMA, kindInstruction, parseResponse } from "../provider.ts";
import type { ExtractionProvider, ProviderRequest, ProviderResponse } from "../types.ts";

export type ChatCompletionsConfig = {
  /** 写入 runs[].provider 的通道名，例如 "command-code" / "opencode-go" / "deepseek-api" */
  name: string;
  /** OpenAI 兼容根地址，不含 /chat/completions，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  /** 额外请求头（OpenCode Go 需要 x-opencode-session） */
  extraHeaders?: Record<string, string>;
  /** 是否发送 OpenRouter 专有参数——仅 openrouter 上游可 true */
  openRouterParams?: boolean;
  /**
   * response_format 形态：
   * - "json_schema"：OpenAI 结构化输出（仅上游明确支持时使用）
   * - "json_object"：最通用的 JSON 模式（默认）
   * - "none"：完全依赖 prompt（v2 已自足）
   * ⚠️ 不同上游对 response_format 的支持不同，发错会 400，故做成可配置而非写死。
   */
  responseFormat?: "json_schema" | "json_object" | "none";
  reasoningEffort?: "low" | "medium" | "high" | null;
};

function dataUrl(mime: string | undefined, fileBase64: string): string {
  return `data:${mime || "application/octet-stream"};base64,${fileBase64}`;
}

/** 与 OpenRouterProvider 同样的附件构造：图片走 image_url，PDF 走 file */
function filePart(request: ProviderRequest): Record<string, unknown> | null {
  if (!request.fileBase64) return null;
  if (request.sourceType === "image") return { type: "image_url", image_url: { url: dataUrl(request.mime, request.fileBase64) } };
  if (request.sourceType === "pdf") return { type: "file", file: { filename: request.filename || "document.pdf", file_data: dataUrl("application/pdf", request.fileBase64) } };
  return null;
}

export class ChatCompletionsProvider implements ExtractionProvider {
  readonly name: string;
  readonly model: string;
  // ⚠️ 不能写成构造函数参数属性（constructor(private readonly config: ...)）：
  // 本包运行时是 Node strip-only 模式，参数属性会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  private readonly config: ChatCompletionsConfig;
  private readonly responseFormat: "json_schema" | "json_object" | "none";

  constructor(config: ChatCompletionsConfig) {
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.responseFormat = config.responseFormat
      || (process.env.IMPORT_RESPONSE_FORMAT as never)
      || "json_object";
  }

  available(): boolean {
    return Boolean(process.env[this.config.apiKeyEnv]?.trim());
  }

  async extract(request: ProviderRequest): Promise<ProviderResponse | null> {
    const key = process.env[this.config.apiKeyEnv]?.trim();
    if (!key) return null;
    const schema = request.responseKind === "rows" ? ROW_SCHEMA : MAPPING_SCHEMA;
    const content: unknown[] = [{ type: "text", text: `${kindInstruction(request.kindHint)}\n${request.userText}` }];
    const attachment = filePart(request);
    if (attachment) content.push(attachment);
    const payload: Record<string, unknown> = {
      model: this.config.model,
      temperature: 0,
      // 不设 max_tokens：直连通道由上游决定输出上限。
      // 这里曾按 responseKind 收紧到 2500 —— 对推理模型是致命的：思考 token
      // 也算在额度内，实测列映射任务需要约 1.2 万 token 推理，2500 会被
      // finish_reason=length 截断、content 为空，于是白白失败并降级到兜底通道。
      messages: [
        { role: "system", content: IMPORT_SYSTEM_PROMPT },
        { role: "user", content },
      ],
    };
    if (this.responseFormat === "json_schema") {
      payload.response_format = {
        type: "json_schema",
        json_schema: { name: request.responseKind === "rows" ? "import_rows" : "import_mappings", strict: true, schema },
      };
    } else if (this.responseFormat === "json_object") {
      payload.response_format = { type: "json_object" };
    }
    if (this.config.reasoningEffort) payload.reasoning_effort = this.config.reasoningEffort;
    // ⚠️ 只有 OpenRouter 认 provider 字段；发给 DeepSeek / OpenCode Go 会 400
    if (this.config.openRouterParams) payload.provider = { require_parameters: true, allow_fallbacks: true };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            ...(this.config.extraHeaders ?? {}),
          },
          signal: AbortSignal.timeout(90_000),
          body: JSON.stringify(payload),
        });
        if (response.ok) return parseResponse(await response.json() as Record<string, unknown>, this.config.model);
        // 仅对可重试状态码重试；其余（含 400/401/403）判定为通道失败
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) return null;
      } catch {
        if (attempt === 1) return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    return null;
  }
}

/**
 * Command Code Provider API —— OpenAI 兼容，已是"直连"形态，无需走 CLI。
 * 端点：https://api.commandcode.ai/provider/v1/chat/completions
 * 文档：https://commandcode.ai/docs/provider
 * ⚠️ baseUrl 含 /provider 段；Go 套餐无 API 权限（403 upgrade_required）。
 * ⚠️ 模型 ID 必须带命名空间：vendor/model。
 */
export function commandCodeProvider(): ExtractionProvider {
  return new ChatCompletionsProvider({
    name: "command-code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKeyEnv: "COMMAND_CODE_API_KEY",
    model: process.env.IMPORT_MODEL_CMDCODE || "deepseek/deepseek-v4.1-flash",
    reasoningEffort: (process.env.IMPORT_REASONING_EFFORT as never) || null,
  });
}

export function openCodeGoProvider(): ExtractionProvider {
  return new ChatCompletionsProvider({
    name: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKeyEnv: "OPENCODE_GO_API_KEY",
    model: process.env.IMPORT_MODEL_OPENCODE_GO || "deepseek-v4-flash",
    // 实测必需：缺此头报 MissingSessionID
    extraHeaders: { "x-opencode-session": process.env.OPENCODE_SESSION_ID || `radar-import-${process.pid}` },
  });
}

export function deepSeekApiProvider(): ExtractionProvider {
  return new ChatCompletionsProvider({
    name: "deepseek-api",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    model: process.env.IMPORT_MODEL_DEEPSEEK || "deepseek-flash",
  });
}
