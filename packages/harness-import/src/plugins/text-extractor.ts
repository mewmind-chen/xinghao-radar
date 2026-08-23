/**
 * text-extractor —— 纯文本 / 聊天记录 / 语音转写文本的规范化（必须插件）。
 *
 * 行业术语纠错走 domain.correctTradeText（绝不改型号字符），
 * 拆行后供规则解析与 AI 抽取共用。
 */

import { correctTradeText } from "../radar-domain.ts";

export function extractTextLines(raw: string): { normalized: string; lines: string[] } {
  const normalized = correctTradeText(raw ?? "");
  const lines = normalized
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return { normalized, lines };
}
