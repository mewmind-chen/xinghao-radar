import type { TableDocument, TableSheet } from "./types.ts";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;
export const MAX_TABLE_ROWS = 20_000;
export const MAX_OUTPUT_ROWS = 5_000;
export const MAX_PDF_PAGES = 30;

export function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function base64Of(content: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < content.length; i += chunk) binary += String.fromCharCode(...content.subarray(i, i + chunk));
  return btoa(binary);
}

export function textOf(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

export function parseCsv(text: string): TableDocument {
  const input = text.replace(/^\uFEFF/, "");
  const delimiter = (input.split(/\r?\n/, 1)[0] ?? "").includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === delimiter && !quoted) {
      row.push(cell.trim()); cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some((v) => v.length)) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell.trim()); if (row.some((v) => v.length)) rows.push(row); }
  return { sourceType: "csv", sheets: [{ name: "CSV", rows }] };
}

export async function parseExcel(content: Uint8Array): Promise<TableDocument> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(content, { type: "buffer", cellStyles: false });
  const sheets: TableSheet[] = wb.SheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: false, defval: "" })
      .map((r) => (r ?? []).map((v) => String(v ?? "").trim()));
    const merges = (sheet["!merges"] ?? []).map((m: { s: { r: number; c: number }; e: { r: number; c: number } }) => `${m.s.r}:${m.s.c}-${m.e.r}:${m.e.c}`);
    return { name, rows, merges };
  });
  return { sourceType: "excel", sheets };
}

export async function extractDocx(content: Uint8Array): Promise<string | null> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(content) });
  const text = String(result.value ?? "").trim();
  return text || null;
}

export async function extractPdfText(content: Uint8Array): Promise<{ text: string; pages: string[]; pageCount: number } | null> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(content));
  const result = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(result.text) ? result.text.map((v) => String(v ?? "")) : [String(result.text ?? "")];
  const text = pages.join("\n\n").trim();
  const pageCount = typeof pdf.numPages === "number" ? pdf.numPages : pages.length;
  return { text, pages, pageCount };
}

export function looksLikePdf(content: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(content.subarray(0, 5)) === "%PDF-";
}

export function looksLikeDoc(content: Uint8Array): boolean {
  return content[0] === 0xd0 && content[1] === 0xcf && content[2] === 0x11 && content[3] === 0xe0;
}

export function looksLikeDocx(content: Uint8Array): boolean {
  return content[0] === 0x50 && content[1] === 0x4b && content[2] === 0x03 && content[3] === 0x04;
}
