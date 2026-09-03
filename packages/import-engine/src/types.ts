export type ImportKind = "offer" | "inquiry" | "stock" | "transit";
export type ImportKindHint = ImportKind | "mixed";
export type SourceType = "text" | "excel" | "csv" | "image" | "pdf" | "docx";

export type Currency = "USD" | "CNY" | null;
export type CostTax = "none" | "exclusive" | "inclusive" | null;
export type PackState = "full" | "loose" | "mixed" | null;

export type CandidateValues = {
  mpn: string | null;
  brand: string | null;
  qty: number | null;
  qtyRaw: string | null;
  dateCode: string | null;
  priceAmount: number | null;
  priceCurrency: Currency;
  priceTax: CostTax;
  isTp: boolean;
  leadTimeText: string | null;
  etaText: string | null;
  warehouse: string | null;
  channel: string | null;
  customer: string | null;
  package: string | null;
  standardPack: string | null;
  packState: PackState;
  costAmount: number | null;
  costCurrency: Currency;
  costTax: CostTax;
  note: string | null;
};

export type SourceEvidence =
  | { type: "text"; start: number; end: number; quote: string }
  | { type: "cell"; sheet: string; row: number; column: number; address: string; quote: string }
  | { type: "page"; page: number; quote?: string; region?: [number, number, number, number] }
  | { type: "image"; region?: [number, number, number, number]; quote?: string };

export type CandidateRow = CandidateValues & {
  id: string;
  kind: ImportKind | null;
  evidence: Partial<Record<keyof CandidateValues | "kind", SourceEvidence[]>>;
  verification: "exact" | "visual_only" | "human_override" | "unverified";
  issues: string[];
};

export type TableSheet = {
  name: string;
  rows: string[][];
  merges?: string[];
};

export type TableDocument = {
  sheets: TableSheet[];
  sourceType: "excel" | "csv";
};

export type TableMapping = {
  sheet: string;
  headerRow: number;
  dataStartRow: number;
  columns: Partial<Record<keyof CandidateValues, number>>;
  unmappedHeaders: string[];
  needsReview: boolean;
  reason?: string;
};

export type ExtractionIssue = {
  code:
    | "empty_input"
    | "unsupported_file"
    | "file_too_large"
    | "too_many_rows"
    | "too_many_pages"
    | "invalid_file"
    | "provider_unavailable"
    | "provider_error"
    | "invalid_model_output"
    | "missing_mpn"
    | "missing_kind"
    | "missing_evidence"
    | "ambiguous_mapping";
  message: string;
  rowId?: string;
  field?: string;
};

export type ModelRun = {
  provider: string;
  model: string;
  upstreamProvider: string | null;
  status: "completed" | "failed";
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  error?: string;
};

export type ExtractionStatus =
  | "completed"
  | "needs_review"
  | "needs_mapping"
  | "unsupported"
  | "invalid_input"
  | "provider_unavailable"
  | "provider_error";

export type ExtractionResult = {
  schemaVersion: "1";
  requestId: string;
  status: ExtractionStatus;
  route: "deterministic" | "model_rows" | "model_mapping";
  sourceDigest: string;
  rows: CandidateRow[];
  mappings: TableMapping[];
  issues: ExtractionIssue[];
  runs: ModelRun[];
};

export type ExtractRequest = {
  requestId?: string;
  source: {
    type: SourceType;
    filename?: string;
    mime?: string;
    content: string | Uint8Array;
  };
  kindHint: ImportKindHint;
  modelMode?: "primary" | "compare";
};

export type ProviderRequest = {
  kindHint: ImportKindHint;
  userText: string;
  sourceType: SourceType;
  filename?: string;
  mime?: string;
  fileBase64?: string;
  responseKind: "rows" | "mapping";
};

export type ProviderResponse = {
  raw: string;
  model: string;
  upstreamProvider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
};

export interface ExtractionProvider {
  readonly name: string;
  readonly model: string;
  available(): boolean;
  extract(request: ProviderRequest): Promise<ProviderResponse | null>;
}
