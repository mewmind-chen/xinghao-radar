/**
 * document-parser —— PDF / Word 文本抽取（必须插件）。
 *
 * - PDF: unpdf（内置 pdfjs，服务端友好）
 * - Word: 仅 .docx（OOXML）；老式 .doc(OLE2) 无纯 JS 轻量方案，返回 null 降级
 * - 任何失败返回 null，上层回退到宿主传入文本 / 规则解析 / 截图引导
 */

const PDF_MAGIC = "%PDF";

function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === PDF_MAGIC;
}

/** docx 是 OOXML zip：PK\x03\x04 魔数；老 doc 是 OLE2（D0 CF 11 E0）。 */
function docxSubtype(buf: Buffer): "docx" | "doc-legacy" | "unknown" {
  const b = buf.subarray(0, 4);
  if (b[0] === 0x50 && b[1] === 0x4b) return "docx";
  if (b[0] === 0xd0 && b[1] === 0xcf) return "doc-legacy";
  return "unknown";
}

export async function extractDocumentText(
  buf: Buffer,
  hint?: { mime?: string; filename?: string },
): Promise<string | null> {
  const name = (hint?.filename ?? "").toLowerCase();
  try {
    if (looksLikePdf(buf) || hint?.mime === "application/pdf" || name.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      const merged = (Array.isArray(text) ? text.join("\n") : text).trim();
      return merged || null;
    }
    const subtype = docxSubtype(buf);
    if (subtype === "docx") {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: buf });
      const t = (value ?? "").trim();
      return t || null;
    }
    // doc-legacy / unknown：V1 不支持，明确降级
    return null;
  } catch {
    return null;
  }
}
