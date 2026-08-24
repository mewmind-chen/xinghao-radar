/**
 * Radar → electronics-agent-platform HTTP client.
 * Business facts stay here. The platform only returns candidates / research results.
 */
import type { ImportKind, ImportRow, ImportSource } from "@/lib/types";

function nid(): string {
  return crypto.randomUUID();
}

export const AGENT_API_URL = (process.env.AGENT_API_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const AGENT_API_TOKEN = String(process.env.AGENT_API_TOKEN || "").trim();

export type PlatformCandidate = {
  kind?: ImportKind;
  mpn?: string;
  brand?: string | null;
  qty?: number | null;
  qtyRaw?: string | null;
  dateCode?: string | null;
  priceAmount?: number | null;
  priceCurrency?: "USD" | "CNY" | null;
  priceTax?: "none" | "exclusive" | "inclusive" | null;
  isTp?: boolean;
  leadTimeText?: string | null;
  etaText?: string | null;
  warehouse?: string | null;
  channel?: string | null;
  customer?: string | null;
  package?: string | null;
  standardPack?: string | null;
  packState?: "full" | "loose" | "mixed" | null;
  costAmount?: number | null;
  costCurrency?: "USD" | "CNY" | null;
  costTax?: "none" | "exclusive" | "inclusive" | null;
  note?: string | null;
  warnings?: { message?: string }[];
};

export function candidateToImportRow(c: PlatformCandidate, fallbackKind: ImportKind): ImportRow {
  const kind = c.kind && c.kind !== ("mixed" as ImportKind) ? c.kind : fallbackKind === "mixed" ? "offer" : fallbackKind;
  return {
    id: nid(),
    kind,
    mpn: String(c.mpn || "").trim(),
    brand: c.brand ?? null,
    qty: c.qty ?? null,
    qtyRaw: c.qtyRaw ?? null,
    dateCode: c.dateCode ?? null,
    priceAmount: c.priceAmount ?? null,
    priceCurrency: c.priceCurrency ?? null,
    priceTax: c.priceTax ?? null,
    isTp: Boolean(c.isTp),
    leadTimeText: c.leadTimeText ?? null,
    etaText: c.etaText ?? null,
    warehouse: c.warehouse ?? null,
    channel: c.channel ?? null,
    customer: c.customer ?? null,
    package: c.package ?? null,
    standardPack: c.standardPack ?? null,
    packState: c.packState ?? null,
    costAmount: c.costAmount ?? null,
    costCurrency: c.costCurrency ?? null,
    costTax: c.costTax ?? null,
    note: c.note ?? null,
    duplicate: false,
    duplicateReason: null,
    selected: true,
    warning: c.warnings?.map((w) => w.message).filter(Boolean).join("；") || null,
  };
}

async function postJson(path: string, body: unknown, timeoutMs: number): Promise<unknown | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (AGENT_API_TOKEN) headers.authorization = `Bearer ${AGENT_API_TOKEN}`;
  try {
    const res = await fetch(`${AGENT_API_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function extractViaPlatform(input: {
  kind: ImportKind;
  sourceType: ImportSource;
  text?: string;
  filename?: string;
  fileBase64?: string;
  mime?: string;
}): Promise<{ rows: ImportRow[]; usedAi: boolean } | null> {
  const body = await postJson("/v1/import/extract", input, 30_000);
  if (!body || typeof body !== "object") return null;
  const rec = body as { candidates?: PlatformCandidate[]; usedAi?: boolean; needsAgent?: boolean };
  const candidates = Array.isArray(rec.candidates) ? rec.candidates : [];
  if (!candidates.length) return rec.needsAgent ? null : { rows: [], usedAi: Boolean(rec.usedAi) };
  const kind = input.kind === "mixed" ? "offer" : input.kind;
  const rows = candidates.filter((c) => c.mpn).map((c) => candidateToImportRow(c, kind));
  return { rows, usedAi: Boolean(rec.usedAi) };
}

export type PlatformPartResearch = {
  ok?: boolean;
  mpn?: string;
  identity?: {
    mpn?: string;
    brand?: string;
    category?: string;
    package?: string;
    imageUrl?: string;
    lcscUrl?: string;
    lcscStock?: number | null;
    priceBreaks?: { qty: number; price: number }[];
    applications?: string[];
    specs?: { label: string; value: string }[];
  };
  offers?: { sourceKey?: string; model?: string; stock?: number | null; price?: number | null }[];
  dossier?: { headline?: string; extra?: { what?: string } };
};

export async function researchPartViaPlatform(mpn: string): Promise<PlatformPartResearch | null> {
  const body = await postJson("/v1/parts/research", { mpn, steps: ["lcsc", "hqew"] }, 120_000);
  if (!body || typeof body !== "object") return null;
  const rec = body as PlatformPartResearch;
  if (rec.ok === false) return null;
  return rec;
}
