import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ClipboardList, Plus } from "lucide-react";
import {
  listLotMovements,
  listStock,
  openTransit,
  receiveTransit,
  stockAdjust,
  stockInbound,
  stockLotUpdate,
  stockOutbound,
  stockTransfer,
} from "@/lib/server/stock";
import { formatCost, formatEtaLabel, formatInventoryQty, formatMd, formatStockDateCode, parseCost, parseQty } from "@/lib/domain";
import type { CostTax, Currency, StockMovement } from "@/lib/types";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppAccess } from "@/lib/auth/use-app-access";

export const Route = createFileRoute("/stock")({ component: StockPage });

type StockItem = Awaited<ReturnType<typeof listStock>>["items"][number];

type StockGroup = {
  partId: string;
  mpn: string;
  brandCode: string | null;
  items: StockItem[];
  onHand: number;
  transit: number;
};

function groupStock(items: StockItem[]): StockGroup[] {
  const groups = new Map<string, StockGroup>();
  for (const item of items) {
    let group = groups.get(item.partId);
    if (!group) {
      group = { partId: item.partId, mpn: item.mpn, brandCode: item.brandCode, items: [], onHand: 0, transit: 0 };
      groups.set(item.partId, group);
    }
    group.items.push(item);
    if (item.status === "in_transit") group.transit += item.qtyRemaining;
    else group.onHand += item.qtyRemaining;
  }
  return [...groups.values()];
}

function stockLineKey(item: StockItem): string {
  return [item.status, item.warehouseId, item.qtyRemaining, item.supplierName, item.dateCode, item.costAmount, item.costCurrency, item.costTax].join("|");
}

function StockPage() {
  const access = useAppAccess();
  const [wh, setWh] = useState("all");
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<null | "in" | "transit">(null);
  const [selected, setSelected] = useState<StockItem | null>(null);
  const list = useQuery({
    queryKey: ["stock", wh, q],
    queryFn: () => listStock({ data: { warehouseId: wh === "all" ? undefined : wh, q: q || undefined } }),
  });
  const d = list.data;
  const groups = groupStock(d?.items ?? []);

  useEffect(() => {
    if (!selected || !d) return;
    const refreshed = d.items.find((item) => item.id === selected.id) ?? null;
    if (!refreshed) {
      setSelected(null);
      return;
    }
    const changed = ["qtyRemaining", "status", "costAmount", "costCurrency", "costTax", "supplierName", "dateCode"]
      .some((key) => refreshed[key as keyof StockItem] !== selected[key as keyof StockItem]);
    if (changed) setSelected(refreshed);
  }, [d, selected]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">我的库存</h1>
          <p className="text-sm text-muted-foreground">
            在库 {formatInventoryQty(d?.summary.onHand ?? 0)} · 途 {formatInventoryQty(d?.summary.transit ?? 0)} · {d?.summary.sku ?? 0} 个型号 · {d?.summary.lots ?? 0} 批库存
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {access.can("inventory.import") && <a href="/import?kind=stock" className="inline-flex">
            <Button variant="outline"><ClipboardList className="size-4" />批量入库</Button>
          </a>}
          {access.can("stock.write") && <>
            <Button variant="outline" onClick={() => setMode("transit")}>记在途</Button>
            <Button onClick={() => setMode("in")}><Plus className="size-4" />入库</Button>
          </>}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <NativeSelect className="w-36" value={wh} onChange={(e) => setWh(e.target.value)}>
          <option value="all">全部仓</option>
          <option value="transit">仅在途</option>
          {d?.warehouses.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}
        </NativeSelect>
        <Input className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛型号" />
      </div>

      {list.isLoading && <Skeleton className="h-24" />}
      <ul className="space-y-3">
        {groups.map((group) => {
          const repeated = new Set<string>();
          const counts = new Map<string, number>();
          for (const item of group.items) counts.set(stockLineKey(item), (counts.get(stockLineKey(item)) ?? 0) + 1);
          for (const [key, count] of counts) if (count > 1) repeated.add(key);
          return (
            <li key={group.partId} className="overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)]">
              <div className="flex items-baseline justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Mpn value={group.mpn} />
                  {group.brandCode && <span className="text-xs text-muted-foreground">{group.brandCode}</span>}
                </div>
                <span className="shrink-0 text-xs tabular text-muted-foreground">
                  在库 {formatInventoryQty(group.onHand)}{group.transit ? ` · 途 ${formatInventoryQty(group.transit)}` : ""}
                </span>
              </div>
              <ul className="divide-y divide-border/70 border-t border-border/60">
                {group.items.map((it) => {
                  const location = it.status === "in_transit" ? "途" : (it.warehouseCode ?? "—");
                  const cost = formatCost(it.costAmount, it.costCurrency, it.costTax);
                  const shortDate = repeated.has(stockLineKey(it)) ? `入库${formatMd(it.inboundAt)}` : "";
                  const mobileParts = [location, formatInventoryQty(it.qtyRemaining), it.dateCode ? formatStockDateCode(it.dateCode) : "", cost, shortDate].filter(Boolean);
                  const desktopParts = [location, formatInventoryQty(it.qtyRemaining), it.supplierName ?? "供应商未填写", it.dateCode ? `DC${it.dateCode}` : "DC未填写", cost, shortDate].filter(Boolean);
                  return (
                    <li key={it.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(it)}
                        className="block w-full px-4 py-2.5 text-left hover:bg-secondary/50"
                      >
                        <div className="flex min-w-0 items-center gap-2 text-xs tabular">
                          <span className="md:hidden">{mobileParts.join(" · ")}</span>
                          <span className="hidden md:inline">{desktopParts.join(" · ")}</span>
                          {it.status === "in_transit" && (it.etaDate || it.etaText) && (
                            <span className="text-muted-foreground md:hidden">{formatEtaLabel({ etaDate: it.etaDate, etaText: it.etaText, precision: it.etaPrecision as "date" | "week" | "month" | "fuzzy" | "stock" | null })}</span>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

      <InboundDialog open={mode} onClose={() => setMode(null)} warehouses={d?.warehouses ?? []} />
      <LotSheet lot={selected} onClose={() => setSelected(null)} warehouses={d?.warehouses ?? []} canWrite={access.can("stock.write")} canFixModel={access.can("model.write")} />
    </div>
  );
}

function InboundDialog({
  open,
  onClose,
  warehouses,
}: {
  open: null | "in" | "transit";
  onClose: () => void;
  warehouses: { id: string; code: string; isActive: boolean }[];
}) {
  const qc = useQueryClient();
  const [mpn, setMpn] = useState("");
  const [wh, setWh] = useState("");
  const [qty, setQty] = useState("");
  const [dc, setDc] = useState("");
  const [eta, setEta] = useState("");
  const [cost, setCost] = useState("");
  const [supplier, setSupplier] = useState("");
  useEffect(() => { if (!wh && warehouses[0]) setWh(warehouses[0].id); }, [warehouses, wh]);
  const mut = useMutation({
    mutationFn: async () => {
      const n = parseQty(qty);
      if (!n || n <= 0) throw new Error("数量无效");
      const parsed = parseCost(cost);
      if (cost.trim() && (!parsed.currency || !parsed.tax)) throw new Error("成本请同时填写币种和税口径，例如 ¥22.5未税");
      if (open === "in") {
        await stockInbound({ data: { mpn, warehouseId: wh, qty: n, dateCode: dc || undefined, costAmount: parsed.amount ?? undefined, costCurrency: parsed.currency ?? undefined, costTax: parsed.tax ?? undefined, supplier: supplier || undefined } });
      } else {
        await openTransit({ data: { mpn, qty: n, dateCode: dc || undefined, etaText: eta || undefined, costAmount: parsed.amount ?? undefined, costCurrency: parsed.currency ?? undefined, costTax: parsed.tax ?? undefined, supplier: supplier || undefined } });
      }
    },
    onSuccess: () => { toast.success(open === "in" ? "已入库" : "已记在途"); qc.invalidateQueries(); onClose(); setMpn(""); setQty(""); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={Boolean(open)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent><DialogHeader><DialogTitle>{open === "in" ? "入库" : "记在途"}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div><Label>型号</Label><Input className="font-mono" value={mpn} onChange={(e) => setMpn(e.target.value)} /></div>
          {open === "in" && <div><Label>仓库</Label><NativeSelect value={wh} onChange={(e) => setWh(e.target.value)}>{warehouses.filter((w) => w.isActive).map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</NativeSelect></div>}
          <div className="grid grid-cols-2 gap-2"><div><Label>数量</Label><Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="10K" /></div><div><Label>批次 DC</Label><Input value={dc} onChange={(e) => setDc(e.target.value)} placeholder="2418" /></div></div>
          {open === "transit" && <div><Label>货期原话</Label><Input value={eta} onChange={(e) => setEta(e.target.value)} placeholder="4周 / 8月底 / 8/28" /></div>}
          <div className="grid grid-cols-2 gap-2"><div><Label>成本（币种+税口径）</Label><Input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="$3.20 或 ¥22.5未税" /></div><div><Label>供应商</Label><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></div></div>
          <Button disabled={mut.isPending} onClick={() => mut.mutate()}>确认</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LotSheet({
  lot,
  onClose,
  warehouses,
  canWrite,
  canFixModel,
}: {
  lot: StockItem | null;
  onClose: () => void;
  warehouses: { id: string; code: string; isActive: boolean }[];
  canWrite: boolean;
  canFixModel: boolean;
}) {
  const qc = useQueryClient();
  const [op, setOp] = useState<null | "in" | "out" | "move" | "adjust" | "cost" | "receive" | "edit">(null);
  const [qty, setQty] = useState("");
  const [countedQty, setCountedQty] = useState("");
  const [targetWh, setTargetWh] = useState("");
  const [note, setNote] = useState("");
  const [costAmount, setCostAmount] = useState("");
  const [currency, setCurrency] = useState<Currency | "">("");
  const [tax, setTax] = useState<CostTax | "">("");
  const [editSupplier, setEditSupplier] = useState("");
  const [editDc, setEditDc] = useState("");
  const movements = useQuery({ queryKey: ["lot-movements", lot?.id], queryFn: () => listLotMovements({ data: { lotId: lot!.id } }), enabled: Boolean(lot) });

  useEffect(() => {
    if (!lot) return;
    setTargetWh(warehouses.find((w) => w.id !== lot.warehouseId && w.isActive)?.id ?? warehouses.find((w) => w.isActive)?.id ?? "");
    setCostAmount(lot.costAmount == null ? "" : String(lot.costAmount));
    setCurrency(lot.costCurrency ?? "");
    setTax(lot.costTax ?? "");
    setEditSupplier(lot.supplierName ?? "");
    setEditDc(lot.dateCode ?? "");
    setOp(null); setQty(""); setCountedQty(String(lot.qtyRemaining)); setNote("");
  }, [lot, warehouses]);

  function openOperation(next: NonNullable<typeof op>) {
    if (next === "in" && lot?.warehouseId) setTargetWh(lot.warehouseId);
    setOp(next);
  }

  const mut = useMutation({
    mutationFn: async () => {
      if (!lot) throw new Error("批次不存在");
      if (op === "in") {
        const n = parseQty(qty) ?? Number(qty);
        if (!Number.isInteger(n) || n <= 0) throw new Error("数量必须是大于 0 的整数");
        const hasAmount = costAmount.trim() !== "";
        const amount = hasAmount ? Number(costAmount) : null;
        if (amount != null && (!Number.isFinite(amount) || amount < 0)) throw new Error("成本金额无效");
        if (hasAmount && (!currency || !tax)) throw new Error("成本请同时填写币种和税口径");
        return stockInbound({ data: {
          mpn: lot.mpn,
          warehouseId: targetWh || lot.warehouseId || "",
          qty: n,
          dateCode: editDc || undefined,
          supplier: editSupplier || undefined,
          costAmount: amount ?? undefined,
          costCurrency: hasAmount ? (currency || undefined) : undefined,
          costTax: hasAmount ? (tax || undefined) : undefined,
        } });
      }
      if (op === "cost" || op === "edit") {
        const hasAmount = costAmount.trim() !== "";
        const amount = hasAmount ? Number(costAmount) : null;
        if (amount != null && (!Number.isFinite(amount) || amount < 0)) throw new Error("成本金额无效");
        return stockLotUpdate({ data: {
          lotId: lot.id,
          costAmount: amount,
          costCurrency: hasAmount ? (currency || null) : null,
          costTax: hasAmount ? (tax || null) : null,
          ...(op === "edit" ? { supplier: editSupplier, dateCode: editDc } : {}),
        } });
      }
      if (op === "adjust") {
        const actual = Number(countedQty);
        if (!Number.isInteger(actual) || actual < 0) throw new Error("盘点数量必须是大于等于 0 的整数");
        return stockAdjust({ data: { lotId: lot.id, countedQty: actual, note: `修 ${lot.qtyRemaining} → ${actual}` } });
      }
      const n = parseQty(qty) ?? Number(qty);
      if (!Number.isInteger(n) || n <= 0) throw new Error("数量必须是大于 0 的整数");
      if (op === "out") return stockOutbound({ data: { lotId: lot.id, qty: n, note: note || undefined } });
      if (op === "move") return stockTransfer({ data: { lotId: lot.id, toWarehouseId: targetWh, qty: n, note: note || undefined } });
      if (op === "receive") return receiveTransit({ data: { lotId: lot.id, warehouseId: targetWh, qty: n } });
      throw new Error("请选择操作");
    },
    onSuccess: (result) => { toast.success("已记录库存流水"); qc.invalidateQueries(); setOp(null); setQty(""); setNote(""); if (result && "qtyRemaining" in result) setCountedQty(String(result.qtyRemaining)); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Sheet open={Boolean(lot)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="bottom" className="max-h-[86vh] overflow-y-auto md:inset-y-0 md:right-0 md:left-auto md:bottom-auto md:h-full md:max-h-none md:w-[440px] md:rounded-none md:p-6">
        {lot && <div className="grid gap-4">
          <DialogHeader>
            <DialogTitle className="pr-8 text-lg">{lot.mpn}</DialogTitle>
            <p className="text-sm text-muted-foreground">{lot.warehouseCode ?? "在途"} · {formatInventoryQty(lot.qtyRemaining)}{lot.dateCode ? ` · DC${lot.dateCode}` : ""}{formatCost(lot.costAmount, lot.costCurrency, lot.costTax) ? ` · ${formatCost(lot.costAmount, lot.costCurrency, lot.costTax)}` : ""}</p>
            <p className="text-xs text-muted-foreground">供应商：{lot.supplierName ?? "未填写"} {canWrite && <button type="button" className="ml-1 text-primary underline-offset-2 hover:underline" onClick={() => setOp("edit")}>补充</button>}</p>
            {canFixModel && <a className="text-xs text-primary underline-offset-2 hover:underline" href={`/parts/${lot.partId}?from=stock&q=`}>型号修正</a>}
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            {canWrite && lot.status === "on_hand" && <>
              <Button size="sm" className="bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300" onClick={() => openOperation("in")}>入</Button>
              <Button size="sm" className="bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/30 dark:text-red-300" onClick={() => openOperation("out")}>出</Button>
              <Button size="sm" className="bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/30 dark:text-blue-300" onClick={() => openOperation("move")}>调</Button>
              <Button size="sm" className="bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/30 dark:text-amber-300" onClick={() => openOperation("adjust")}>修</Button>
            </>}
            {canWrite && lot.status === "in_transit" && <Button size="sm" className="bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-teal-950/30 dark:text-teal-300" onClick={() => openOperation("receive")}>途→仓</Button>}
            {canWrite && <Button size="sm" variant="outline" onClick={() => setOp("cost")}>成本</Button>}
          </div>

          {op && <div className="grid gap-2 rounded-lg border border-border bg-secondary/30 p-3">
            <p className="font-medium">{op === "in" ? "按此型号新增入库批次" : op === "cost" ? "编辑成本" : op === "edit" ? "补充批次资料" : op === "out" ? "按此批次出库" : op === "move" ? "按此批次调拨" : op === "adjust" ? `盘点修正 · 当前 ${formatInventoryQty(lot.qtyRemaining)}` : "在途转入仓库"}</p>
            {op === "in" && <>
              <div><Label>仓库</Label><NativeSelect value={targetWh} onChange={(e) => setTargetWh(e.target.value)}>{warehouses.filter((w) => w.isActive).map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</NativeSelect></div>
              <div className="grid grid-cols-2 gap-2"><div><Label>数量</Label><Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="100 或 1K" /></div><div><Label>批次 DC</Label><Input value={editDc} onChange={(e) => setEditDc(e.target.value)} placeholder="2419" /></div></div>
              <div><Label>供应商</Label><Input value={editSupplier} onChange={(e) => setEditSupplier(e.target.value)} placeholder="未填写" /></div>
            </>}
            {(op === "cost" || op === "edit" || op === "in") && <>
              {op === "edit" && <div className="grid grid-cols-2 gap-2"><div><Label>供应商</Label><Input value={editSupplier} onChange={(e) => setEditSupplier(e.target.value)} placeholder="未填写" /></div><div><Label>完整 DC</Label><Input value={editDc} onChange={(e) => setEditDc(e.target.value)} placeholder="2419" /></div></div>}
              <div><Label>成本金额（留空表示未录）</Label><Input value={costAmount} onChange={(e) => setCostAmount(e.target.value)} placeholder="如 10.2" /></div>
              <div className="grid grid-cols-2 gap-2"><div><Label>币种</Label><NativeSelect value={currency} onChange={(e) => setCurrency(e.target.value as Currency | "")}><option value="">未填写</option><option value="CNY">CNY</option><option value="USD">USD</option></NativeSelect></div><div><Label>税别</Label><NativeSelect value={currency === "USD" ? "none" : tax} onChange={(e) => setTax(e.target.value as CostTax | "")}><option value="">未填写</option><option value="exclusive">未税</option><option value="inclusive">含税</option><option value="none">无</option></NativeSelect></div></div>
            </>}
            {op === "adjust" && <div><Label>盘点数量</Label><Input value={countedQty} onChange={(e) => setCountedQty(e.target.value)} placeholder={String(lot.qtyRemaining)} /><p className="mt-1 text-xs text-muted-foreground">系统将记录 {formatInventoryQty(lot.qtyRemaining)} → 输入数量，不需要填写正负差额。</p></div>}
            {(op === "out" || op === "move" || op === "receive") && <div><Label>数量</Label><Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="100 或 1K" /></div>}
            {(op === "move" || op === "receive") && <div><Label>{op === "move" ? "目标仓库" : "入到仓库"}</Label><NativeSelect value={targetWh} onChange={(e) => setTargetWh(e.target.value)}>{warehouses.filter((w) => w.isActive && (op !== "move" || w.id !== lot.warehouseId)).map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</NativeSelect></div>}
            {(op === "out" || op === "move") && <div><Label>备注</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>}
            <div className="flex gap-2"><Button disabled={mut.isPending} onClick={() => mut.mutate()}>保存</Button><Button variant="ghost" onClick={() => setOp(null)}>取消</Button></div>
          </div>}

          <div>
            <h3 className="mb-2 text-sm font-medium">库存流水</h3>
            {movements.isLoading ? <Skeleton className="h-10" /> : movements.data?.length ? <ul className="space-y-2">{movements.data.map((m) => <MovementRow key={m.id} movement={m} />)}</ul> : <p className="text-xs text-muted-foreground">暂无流水</p>}
          </div>
        </div>}
      </SheetContent>
    </Sheet>
  );
}

function MovementRow({ movement }: { movement: StockMovement }) {
  const view = movementView(movement);
  return (
    <li className="px-1 py-1.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className={view.color}>{view.label}</span>
        <span className="text-xs text-muted-foreground">{view.date}</span>
      </div>
      {view.warehouse && <div className="mt-0.5 text-xs text-muted-foreground">{view.warehouse}</div>}
      {(movement.note || movement.fromWarehouseCode || movement.toWarehouseCode || movement.sourceLotId) && (
        <details className="mt-1 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">展开详情</summary>
          <div className="mt-1 grid gap-0.5 pl-3">
            {movement.fromWarehouseCode && <span>来源仓：{movement.fromWarehouseCode}</span>}
            {movement.toWarehouseCode && <span>目标仓：{movement.toWarehouseCode}</span>}
            {movement.note && <span>备注：{movement.note}</span>}
            {movement.sourceLotId && <span>关联原始批次：同一采购批次</span>}
          </div>
        </details>
      )}
    </li>
  );
}

function movementView(m: StockMovement): { label: string; date: string; warehouse: string; color: string } {
  const qty = formatInventoryQty(m.qty);
  const date = shortDate(m.happenedAt);
  if (m.type === "in") return { label: `入 +${qty}`, date, warehouse: "", color: "text-emerald-700 dark:text-emerald-300" };
  if (m.type === "out") return { label: `出 −${qty}`, date, warehouse: "", color: "text-red-700 dark:text-red-300" };
  if (m.type === "transfer") return { label: `调 ${qty}`, date, warehouse: [m.fromWarehouseCode, m.toWarehouseCode].filter(Boolean).join(" → "), color: "text-blue-700 dark:text-blue-300" };
  if (m.type === "adjust") {
    const counted = m.note?.match(/修\s*(\d+)\s*→\s*(\d+)/);
    return { label: counted ? `修 ${formatInventoryQty(Number(counted[1]))}→${formatInventoryQty(Number(counted[2]))}` : `修 ${qty}`, date, warehouse: "", color: "text-amber-700 dark:text-amber-300" };
  }
  if (m.type === "transit_in") return { label: `途→仓 ${qty}`, date, warehouse: m.toWarehouseCode ?? "", color: "text-teal-700 dark:text-teal-300" };
  return { label: `途 +${qty}`, date, warehouse: m.toWarehouseCode ?? "在途", color: "text-teal-700 dark:text-teal-300" };
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(5, 10);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
