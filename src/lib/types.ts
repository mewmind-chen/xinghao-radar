export type CostTax = "none" | "exclusive" | "inclusive";
export type Currency = "USD" | "CNY";
export type PackState = "full" | "loose" | "mixed";
export type LotStatus = "on_hand" | "in_transit" | "closed";
export type MovementType =
  | "in"
  | "out"
  | "transfer"
  | "adjust"
  | "transit_open"
  | "transit_in";
export type EtaPrecision = "date" | "week" | "month" | "fuzzy" | "stock";
export type ImportKind = "offer" | "inquiry" | "stock" | "transit" | "potential" | "mixed";
export type ImportSource = "excel" | "csv" | "pdf" | "word" | "image" | "text";

export type Warehouse = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
};

export type Brand = {
  code: string;
  fullName: string;
  aliases: string;
};

export type Part = {
  id: string;
  mpnKey: string;
  mpn: string;
  brandCode: string | null;
  category: string | null;
  package: string | null;
  description: string | null;
  lifecycle: string | null;
  params: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Channel = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
};

export type Customer = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
};

export type StockLot = {
  id: string;
  sourceLotId?: string | null;
  originLotId?: string | null;
  partId: string;
  warehouseId: string | null;
  warehouseCode: string | null;
  status: LotStatus;
  qtyIn: number;
  qtyRemaining: number;
  dateCode: string | null;
  package: string | null;
  standardPack: string | null;
  packState: PackState | null;
  costAmount: number | null;
  costCurrency: Currency | null;
  costTax: CostTax | null;
  supplierId: string | null;
  supplierName: string | null;
  inboundAt: string;
  orderedAt: string | null;
  etaDate: string | null;
  etaText: string | null;
  etaPrecision: EtaPrecision | null;
};

export type StockMovement = {
  id: string;
  partId: string;
  lotId: string | null;
  sourceLotId?: string | null;
  type: MovementType;
  qty: number;
  fromWarehouseId: string | null;
  fromWarehouseCode: string | null;
  toWarehouseId: string | null;
  toWarehouseCode: string | null;
  happenedAt: string;
  note: string | null;
};

export type ChannelOffer = {
  id: string;
  channelId: string;
  channelName: string;
  channelActive: boolean;
  partId: string;
  mpn: string;
  brandCode: string | null;
  qty: number | null;
  dateCode: string | null;
  priceAmount: number | null;
  priceCurrency: Currency | null;
  priceTax: CostTax | null;
  isTp: boolean;
  leadTimeText: string | null;
  offeredAt: string;
  isValid: boolean;
  invalidatedAt: string | null;
};

export type CustomerInquiry = {
  id: string;
  customerId: string;
  customerName: string;
  customerActive: boolean;
  partId: string;
  mpn: string;
  brandCode: string | null;
  qty: number | null;
  inquiredAt: string;
  isValid: boolean;
  invalidatedAt: string | null;
};

export type MatchFlags = {
  partId: string;
  onHand: number;
  byWarehouse: { id: string; code: string; qty: number }[];
  inTransit: number;
  transitEtaLabel: string | null;
  inquiryCount: number;
  offerCount: number;
  watch: boolean;
  stock: boolean;
  transit: boolean;
  isHit: boolean;
  isDual: boolean;
};

export type ImportRow = {
  id: string;
  kind: ImportKind;
  mpn: string;
  brand: string | null;
  qty: number | null;
  qtyRaw: string | null;
  dateCode: string | null;
  priceAmount: number | null;
  priceCurrency: Currency | null;
  priceTax: CostTax | null;
  isTp: boolean;
  leadTimeText: string | null;
  etaText: string | null;
  warehouse: string | null;
  channel: string | null;
  customer: string | null;
  package: string | null;
  standardPack: string | null;
  packState: PackState | null;
  costAmount: number | null;
  costCurrency: Currency | null;
  costTax: CostTax | null;
  note: string | null;
  duplicate: boolean;
  duplicateReason: string | null;
  selected: boolean;
  warning: string | null;
};

export type AppSettings = {
  inquiryWindowDays: number;
  offerWindowDays: number;
};
