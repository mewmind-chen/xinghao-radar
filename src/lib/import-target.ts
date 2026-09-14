import type { ImportKind, ImportRow } from "./types";

export type ImportPreviewField =
  | "mpn"
  | "brand"
  | "customer"
  | "qty"
  | "dc"
  | "channel"
  | "supplier"
  | "warehouse"
  | "price"
  | "cost"
  | "tp"
  | "currency"
  | "eta"
  | "status";

const PREVIEW_FIELDS: Record<Exclude<ImportKind, "mixed">, readonly ImportPreviewField[]> = {
  inquiry: ["mpn", "brand", "customer", "qty", "tp", "currency", "status"],
  offer: ["mpn", "brand", "qty", "dc", "channel", "price", "currency", "status"],
  stock: ["mpn", "brand", "qty", "dc", "supplier", "warehouse", "cost", "currency", "status"],
  transit: ["mpn", "brand", "qty", "dc", "supplier", "warehouse", "eta", "status"],
  potential: ["mpn", "brand", "status"],
};

export function previewFieldsForKind(kind: ImportKind): readonly ImportPreviewField[] {
  return kind === "mixed" ? [] : PREVIEW_FIELDS[kind];
}

export function sanitizeImportRowForKind(row: ImportRow, kind: ImportKind): ImportRow {
  if (kind === "mixed") return row;

  const base = { ...row, kind };
  if (kind === "inquiry") {
    return {
      ...base,
      dateCode: null,
      priceTax: null,
      leadTimeText: null,
      etaText: null,
      warehouse: null,
      channel: null,
      package: null,
      standardPack: null,
      packState: null,
      costAmount: null,
      costCurrency: null,
      costTax: null,
    };
  }
  if (kind === "offer") {
    return {
      ...base,
      etaText: null,
      warehouse: null,
      customer: null,
      costAmount: null,
      costCurrency: null,
      costTax: null,
    };
  }
  if (kind === "stock") {
    return {
      ...base,
      priceAmount: null,
      priceCurrency: null,
      priceTax: null,
      isTp: false,
      leadTimeText: null,
      etaText: null,
      customer: null,
    };
  }
  if (kind === "transit") {
    return {
      ...base,
      priceAmount: null,
      priceCurrency: null,
      priceTax: null,
      isTp: false,
      leadTimeText: null,
      customer: null,
      costAmount: null,
      costCurrency: null,
      costTax: null,
    };
  }
  return {
    ...base,
    qty: null,
    qtyRaw: null,
    dateCode: null,
    priceAmount: null,
    priceCurrency: null,
    priceTax: null,
    isTp: false,
    leadTimeText: null,
    etaText: null,
    warehouse: null,
    channel: null,
    customer: null,
    package: null,
    standardPack: null,
    packState: null,
    costAmount: null,
    costCurrency: null,
    costTax: null,
  };
}
