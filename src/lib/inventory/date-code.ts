export type DateCodeResolution = {
  dateCode: string | null;
  splits: { dateCode: string; qty: number }[];
  warning: string | null;
};

const TOKEN = /(?<!\d)(\d{2})(?:(\d{2}))?\+/g;

function normalizeToken(year: string, week?: string): string | null {
  if (!week) return `${year}+`;
  const n = Number(week);
  return n >= 1 && n <= 53 ? `${year}${week}+` : null;
}

export function normalizeDateCodeToken(value: string): string | null {
  const compact = value.normalize("NFKC").replace(/\s+/g, "").trim();
  const yearAfter = compact.match(/^20(\d{2})年(?:以后|之后)$/);
  if (yearAfter) return `${yearAfter[1]}+`;
  const match = compact.match(/^(\d{2})(\d{2})?\+$/);
  return match ? normalizeToken(match[1], match[2]) : null;
}

/**
 * DC only accepts YY+ or YYWW+ (ISO-like week 01–53). Package wording is
 * ignored when there is one unambiguous token. Multiple DCs are split only
 * when package counts and standard pack size prove the quantities.
 */
export function resolveDateCode(
  raw: string | null | undefined,
  qty: number | null | undefined,
  standardPack: string | null | undefined,
): DateCodeResolution {
  const source = raw?.normalize("NFKC").trim() ?? "";
  if (!source) return { dateCode: null, splits: [], warning: null };
  const descriptive = normalizeDateCodeToken(source);
  if (descriptive && !source.includes("+")) return { dateCode: descriptive, splits: [], warning: null };
  const matches = [...source.matchAll(TOKEN)];
  if (matches.length === 0) {
    return { dateCode: null, splits: [], warning: "DC 必须是 YY+ 或 YYWW+（周次 01–53）" };
  }
  const tokens = matches.map((match) => normalizeToken(match[1], match[2]));
  if (tokens.some((token) => !token)) {
    return { dateCode: null, splits: [], warning: "DC 周次必须在 01–53，无法确认的行不能写入" };
  }
  const unique = [...new Set(tokens as string[])];
  if (unique.length === 1) return { dateCode: unique[0], splits: [], warning: null };

  const counts = matches.map((match) => {
    const before = source.slice(0, match.index ?? 0);
    const count = before.match(/(\d+(?:\.\d+)?)\s*(?:包|packs?|pcs?)\s*$/i);
    return count ? Number(count[1]) : null;
  });
  const pack = standardPack ? Number(standardPack.replace(/,/g, "").trim()) : NaN;
  const total = qty == null ? NaN : Number(qty);
  if (
    !Number.isFinite(pack) || pack <= 0 || !Number.isInteger(pack) ||
    counts.some((count) => count == null || !Number.isInteger(count) || count <= 0) ||
    !Number.isFinite(total) || !Number.isInteger(total) ||
    counts.reduce<number>((sum, count) => sum + (count ?? 0) * pack, 0) !== total
  ) {
    return {
      dateCode: null,
      splits: [],
      warning: "多个 DC 只有在包数 × 标准装量等于总数时才能拆分；当前信息不足，不能猜测",
    };
  }
  return {
    dateCode: null,
    splits: unique.map((dateCode) => {
      const index = (tokens as string[]).indexOf(dateCode);
      return { dateCode, qty: (counts[index] ?? 0) * pack };
    }),
    warning: null,
  };
}

export function normalizeDateCode(value: string | null | undefined): string | null {
  return resolveDateCode(value, null, null).dateCode;
}
