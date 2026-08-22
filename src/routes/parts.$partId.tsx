import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Star } from "lucide-react";
import { getPartDetail } from "@/lib/server/parts";
import { receiveTransit, stockOutbound, stockTransfer, stockAdjust, stockMeta } from "@/lib/server/stock";
import { setOfferValid, setInquiryValid, toggleWatch } from "@/lib/server/market";
import {
  formatCost,
  formatEtaLabel,
  formatMd,
  formatMovementLine,
  formatOfferLine,
  formatQty,
  formatWhen,
  PACK_STATE_LABEL,
  parseQty,
} from "@/lib/domain";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/parts/$partId")({ component: PartDetail });

function PartDetail() {
  const { partId } = Route.useParams();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["part", partId],
    queryFn: () => getPartDetail({ data: { id: partId } }),
  });
  const meta = useQuery({ queryKey: ["stock-meta"], queryFn: () => stockMeta() });
  const d = q.data;
  const [op, setOp] = useState<null | "out" | "move" | "adj" | "recv">(null);
  const [lotId, setLotId] = useState<string | null>(null);

  const watchMut = useMutation({
    mutationFn: (on: boolean) => toggleWatch({ data: { partId, on } }),
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });

  if (q.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (!d) return <p className="text-sm text-muted-foreground">型号不存在。</p>;

  const onHandLots = d.lots.filter((l) => l.status === "on_hand");
  const transitLots = d.lots.filter((l) => l.status === "in_transit");
  const validOffers = d.offers.filter((o) => o.isValid);
  const histOffers = d.offers.filter((o) => !o.isValid);
  const validInq = d.inquiries.filter((i) => i.isValid);
  const histInq = d.inquiries.filter((i) => !i.isValid);

  const timeline = [
    ...d.offers.map((o) => ({
      t: o.offeredAt,
      key: "o" + o.id,
      node: (
        <span>
          渠道 {o.channelName} 推 {formatOfferLine(o)}
          {!o.isValid && <span className="ml-2 text-muted-foreground">无效</span>}
        </span>
      ),
    })),
    ...d.inquiries.map((i) => ({
      t: i.inquiredAt,
      key: "i" + i.id,
      node: (
        <span>
          客户 {i.customerName} 询 {i.qty != null ? formatQty(i.qty) : "—"}
          {!i.isValid && <span className="ml-2 text-muted-foreground">无效</span>}
        </span>
      ),
    })),
    ...d.movements.map((m) => ({
      t: m.happenedAt,
      key: "m" + m.id,
      node: <span className="font-mono tabular">{formatMovementLine(m)}</span>,
    })),
  ].sort((a, b) => (a.t < b.t ? 1 : -1));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link to="/parts" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="size-4" />
        型号库
      </Link>

      <header className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="max-w-full font-mono text-xl font-medium tracking-tight break-all md:text-2xl">
                {d.part.mpn}
              </h1>
              {d.part.brandCode && <Badge variant="outline">{d.part.brandCode}</Badge>}
              {d.part.category && <span className="text-sm text-muted-foreground">{d.part.category}</span>}
              <HitBadges flags={d.flags} />
            </div>
            <p className="mt-2 font-mono text-sm tabular text-foreground">{d.stockLine}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {[d.part.package, d.part.lifecycle].filter(Boolean).join(" · ")}
            </p>
          </div>
          <Button
            variant={d.watched ? "hit" : "outline"}
            className="w-full sm:w-auto"
            onClick={() => watchMut.mutate(!d.watched)}
          >
            <Star className={cn("size-4", d.watched && "fill-current")} />
            {d.watched ? "已关注" : "潜力"}
          </Button>
        </div>
      </header>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">我的库存</h2>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setOp("out")}>
              出
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOp("move")}>
              调
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOp("adj")}>
              修
            </Button>
          </div>
        </div>
        {onHandLots.length === 0 && <p className="text-sm text-muted-foreground">无在库。</p>}
        <ul className="space-y-2">
          {onHandLots.map((l) => (
            <li key={l.id} className="rounded-lg bg-secondary/60 px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{l.warehouseCode}</span>
                <span className="font-mono tabular">{formatQty(l.qtyRemaining)}</span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {[
                  l.dateCode && `DC ${l.dateCode}`,
                  l.standardPack,
                  l.packState && PACK_STATE_LABEL[l.packState],
                  formatCost(l.costAmount, l.costCurrency, l.costTax),
                  l.supplierName,
                  formatMd(l.inboundAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </li>
          ))}
        </ul>
        {transitLots.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">在途</h3>
            <ul className="space-y-2">
              {transitLots.map((l) => (
                <li key={l.id} className="rounded-lg bg-warn/10 px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>
                      途 {formatQty(l.qtyRemaining)}
                      {l.etaDate || l.etaText
                        ? ` · ${formatEtaLabel({ etaDate: l.etaDate, etaText: l.etaText, precision: l.etaPrecision })}`
                        : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setLotId(l.id);
                        setOp("recv");
                      }}
                    >
                      转入库
                    </Button>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {[
                      l.dateCode && `DC ${l.dateCode}`,
                      formatCost(l.costAmount, l.costCurrency, l.costTax),
                      l.supplierName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">渠道</h2>
        {validOffers.length === 0 && <p className="text-sm text-muted-foreground">当前无有效货源。</p>}
        <ul className="space-y-2">
          {validOffers.map((o) => (
            <li key={o.id} className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm">
                  {o.channelName} · {formatOfferLine(o)}
                </div>
                <div className="text-xs text-muted-foreground">{formatWhen(o.offeredAt)}</div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setOfferValid({ data: { ids: [o.id], isValid: false } }).then(() => {
                    qc.invalidateQueries();
                    toast.success("已设为无效");
                  })
                }
              >
                无效
              </Button>
            </li>
          ))}
        </ul>
        {histOffers.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              历史推货 {histOffers.length}
            </summary>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {histOffers.map((o) => (
                <li key={o.id}>
                  {o.channelName} · {formatOfferLine(o)} · {formatWhen(o.offeredAt)}
                  <button
                    className="ml-2 text-xs underline"
                    onClick={() =>
                      setOfferValid({ data: { ids: [o.id], isValid: true } }).then(() =>
                        qc.invalidateQueries(),
                      )
                    }
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">客户</h2>
        {validInq.length === 0 && <p className="text-sm text-muted-foreground">当前无有效询价。</p>}
        <ul className="space-y-2">
          {validInq.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm">
                  {i.customerName} · {i.qty != null ? formatQty(i.qty) : "—"}
                </div>
                <div className="text-xs text-muted-foreground">{formatWhen(i.inquiredAt)}</div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setInquiryValid({ data: { ids: [i.id], isValid: false } }).then(() => {
                    qc.invalidateQueries();
                    toast.success("已设为无效");
                  })
                }
              >
                无效
              </Button>
            </li>
          ))}
        </ul>
        {histInq.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              历史询价 {histInq.length}
            </summary>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {histInq.map((i) => (
                <li key={i.id}>
                  {i.customerName} · {i.qty != null ? formatQty(i.qty) : "—"} · {formatWhen(i.inquiredAt)}
                  <button
                    className="ml-2 text-xs underline"
                    onClick={() =>
                      setInquiryValid({ data: { ids: [i.id], isValid: true } }).then(() =>
                        qc.invalidateQueries(),
                      )
                    }
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">库存流水</h2>
        <ul className="space-y-1 font-mono text-sm tabular">
          {d.movements
            .filter((m) => m.type !== "transit_open")
            .map((m) => (
              <li key={m.id}>{formatMovementLine(m)}</li>
            ))}
        </ul>
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">型号动态</h2>
        <ul className="space-y-2 text-sm">
          {timeline.slice(0, 40).map((ev) => (
            <li key={ev.key} className="flex gap-3">
              <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground tabular">
                {formatMd(ev.t)}
              </span>
              <span className="min-w-0">{ev.node}</span>
            </li>
          ))}
        </ul>
      </section>

      {(d.part.description || d.part.params) && (
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <h2 className="mb-2 text-sm font-medium">产品知识</h2>
          {d.part.description && <p className="text-sm">{d.part.description}</p>}
          {d.part.params && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">{d.part.params}</p>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">仅基于已录入资料，不猜测车规/军工等级。</p>
        </section>
      )}

      <StockOpDialog
        open={op}
        onClose={() => {
          setOp(null);
          setLotId(null);
        }}
        partId={partId}
        warehouses={meta.data?.warehouses ?? []}
        lotId={lotId}
        transitQty={transitLots.find((l) => l.id === lotId)?.qtyRemaining}
        onDone={() => {
          qc.invalidateQueries();
          setOp(null);
          setLotId(null);
        }}
      />
    </div>
  );
}

function StockOpDialog({
  open,
  onClose,
  partId,
  warehouses,
  lotId,
  transitQty,
  onDone,
}: {
  open: null | "out" | "move" | "adj" | "recv";
  onClose: () => void;
  partId: string;
  warehouses: { id: string; code: string; isActive: boolean }[];
  lotId: string | null;
  transitQty?: number;
  onDone: () => void;
}) {
  const [wh, setWh] = useState(warehouses[0]?.id ?? "");
  const [wh2, setWh2] = useState(warehouses[1]?.id ?? warehouses[0]?.id ?? "");
  const [qty, setQty] = useState("");
  const title =
    open === "out" ? "出库" : open === "move" ? "调拨" : open === "adj" ? "修正" : open === "recv" ? "在途转入库" : "";

  async function submit() {
    try {
      const n = parseQty(qty) ?? Number(qty);
      if (!Number.isFinite(n) || n === 0) throw new Error("数量无效");
      if (open === "out") await stockOutbound({ data: { partId, warehouseId: wh, qty: n } });
      if (open === "move")
        await stockTransfer({
          data: { partId, fromWarehouseId: wh, toWarehouseId: wh2, qty: n },
        });
      if (open === "adj")
        await stockAdjust({ data: { partId, warehouseId: wh, qtyDelta: n } });
      if (open === "recv" && lotId)
        await receiveTransit({ data: { lotId, warehouseId: wh, qty: n } });
      toast.success("已记录流水");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "失败");
    }
  }

  return (
    <Dialog open={Boolean(open)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {open !== "recv" && (
            <div>
              <Label>{open === "move" ? "从" : "仓库"}</Label>
              <NativeSelect value={wh} onChange={(e) => setWh(e.target.value)}>
                {warehouses.filter((w) => w.isActive).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {open === "move" && (
            <div>
              <Label>到</Label>
              <NativeSelect value={wh2} onChange={(e) => setWh2(e.target.value)}>
                {warehouses.filter((w) => w.isActive).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          {open === "recv" && (
            <div>
              <Label>入到仓库</Label>
              <NativeSelect value={wh} onChange={(e) => setWh(e.target.value)}>
                {warehouses.filter((w) => w.isActive).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </NativeSelect>
              <p className="mt-1 text-xs text-muted-foreground">
                剩余在途 {transitQty != null ? formatQty(transitQty) : "—"} · 途→仓不增加总敞口
              </p>
            </div>
          )}
          <div>
            <Label>{open === "adj" ? "调整数量（可负）" : "数量"}</Label>
            <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="1000 或 1K" />
          </div>
          <Button onClick={submit}>确认</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
