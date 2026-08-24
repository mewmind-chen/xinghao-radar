/**
 * Trusted (bounded) vs unbounded import input.
 * Fuzzy headerKey guessing is not a trust signal.
 */
export const TRUSTED_MPN_HEADERS = ["型号", "mpn", "料号"] as const;

const NARRATIVE_TEXT = /那边|还有一批|一块|左右|老[陈王李张]|微信说/;
const CONTROLLED_LINE =
  /^[A-Za-z][A-Za-z0-9._+\-/]{3,}\s+\d+(?:\.\d+)?\s*(?:K|k|万|W)\b/;

function normHeader(h: string): string {
  return String(h || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

export function isTrustedMpnHeader(header: string): boolean {
  const s = normHeader(header);
  return TRUSTED_MPN_HEADERS.some((name) => name === s);
}

export function isTrustedImportTable(table: string[][] | null | undefined): boolean {
  if (!Array.isArray(table) || table.length === 0) return false;
  const limit = Math.min(table.length, 8);
  for (let i = 0; i < limit; i++) {
    const row = table[i] || [];
    if (row.some((cell) => isTrustedMpnHeader(String(cell || "")))) return true;
  }
  return false;
}

export function isControlledImportText(text: string | null | undefined): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (NARRATIVE_TEXT.test(raw)) return false;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => CONTROLLED_LINE.test(line));
}
