/**
 * input-router —— 识别输入类型并路由到解析插件（方案第 7 节，必须插件）。
 *
 * 纯函数、零副作用：只依据 sourceType / mime / filename 判定，
 * 不读文件内容（内容由对应插件负责）。
 */

import type { ImportSource } from "./schema.ts";

export type InputPlugin = "excel" | "csv" | "image" | "document" | "text";

export type RouteDecision = {
  plugin: InputPlugin;
  /** document 插件下的子类型 */
  docType?: "pdf" | "word";
};

export function routeInput(input: {
  sourceType: ImportSource;
  mime?: string;
  filename?: string;
}): RouteDecision {
  const { sourceType, mime = "", filename = "" } = input;
  const name = filename.toLowerCase();

  if (sourceType === "excel" || /\.xlsx?$/.test(name)) return { plugin: "excel" };
  if (sourceType === "csv") return { plugin: "csv" };
  if (sourceType === "image" || mime.startsWith("image/")) return { plugin: "image" };

  if (sourceType === "pdf" || mime === "application/pdf" || name.endsWith(".pdf")) {
    return { plugin: "document", docType: "pdf" };
  }
  if (
    sourceType === "word" ||
    mime.includes("wordprocessingml") ||
    mime === "application/msword" ||
    /\.(docx?|rtf)$/.test(name)
  ) {
    return { plugin: "document", docType: "word" };
  }

  return { plugin: "text" };
}
