import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus } from "lucide-react";
import { listStock, openTransit, stockInbound } from "@/lib/server/stock";
import { formatCost, formatEtaLabel, formatQty, parseCost, parseQty } from "@/lib/domain";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/stock")({ component: StockPage });

function StockPage() {
  const [wh, setWh] = useState("all");
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<null | "in" | "transit">(null);
  const list = useQuery({
    queryKey: ["stock", wh, q],
    queryFn: () =>
      listStock({
        data: { warehouseId: wh === "all" ? undefined : wh, q: q || undefined },
      }),
  });
  const d = list.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">我的库存</h1>
          <p className="text-sm text-muted-foreground">
            在库 {formatQty(d?.summary.onHand ?? 0)} · 途 {formatQty(d?.summary.transit ?? 0)} ·{" "}
            {d?.summary.sku ?? 0} 个型号
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setMode("transit")}>
            记在途
          </Button>
          <Button onClick={() => setMode("in")}>
            <Plus className="size-4" />
            入库
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect className="w-36" value={wh} onChange={(e) => setWh(e.target.value)}>
          <option value="all">全部仓</option>
          <option value="transit">仅在途</option>
          {d?.warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code}
            </option>
          ))}
        </NativeSelect>
        <Input
          className="max-w-xs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="筛型号"
        />
      </div>
      {list.isLoading && <Skeleton className="h-24" />}
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)]">
        {d?.items.map((it) => (
          <li key={it.id}>
            <Link
              to="/parts/$partId"
              params={{ partId: it.partId }}
              search={{ from: "stock", q: q || undefined, warehouseId: wh === "all" ? undefined : wh }}
              className="flex flex-col gap-1 px-4 py-3 hover:bg-secondary/50 md:flex-row md:items-center md:justify-between"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Mpn value={it.mpn} />
                {it.brandCode && <span className="text-xs text-muted-foreground">{it.brandCode}</span>}
                <HitBadges flags={it.flags} />
              </div>
              <div className="font-mono text-xs tabular">
                {it.status === "in_transit"
                  ? `途 ${formatQty(it.qtyRemaining)}${
                      it.etaDate || it.etaText
                        ? ` · ${formatEtaLabel({
                            etaDate: it.etaDate,
                            etaText: it.etaText,
                            precision: it.etaPrecision as "date" | "week" | "month" | "fuzzy" | "stock" | null,
                          })}`
                        : ""
                    }`
                  : `${it.warehouseCode} ${formatQty(it.qtyRemaining)}`}
                {it.dateCode ? ` · ${it.dateCode}` : ""}
                {formatCost(it.costAmount, it.costCurrency, it.costTax)
                  ? ` · ${formatCost(it.costAmount, it.costCurrency, it.costTax)}`
                  : ""}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <InboundDialog open={mode} onClose={() => setMode(null)} warehouses={d?.warehouses ?? []} />
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
  const [wh, setWh] = useState(warehouses[0]?.id ?? "");
  const [qty, setQty] = useState("");
  const [dc, setDc] = useState("");
  const [eta, setEta] = useState("");
  const [cost, setCost] = useState("");
  const [supplier, setSupplier] = useState("");
  const mut = useMutation({
    mutationFn: async () => {
      const n = parseQty(qty);
      if (!n || n <= 0) throw new Error("数量无效");
      const parsed = parseCost(cost);
      if (open === "in") {
        await stockInbound({
          data: {
            mpn,
            warehouseId: wh,
            qty: n,
            dateCode: dc || undefined,
            costAmount: parsed.amount ?? undefined,
            costCurrency: parsed.currency ?? undefined,
            costTax: parsed.tax ?? undefined,
            supplier: supplier || undefined,
          },
        });
      } else {
        await openTransit({
          data: {
            mpn,
            qty: n,
            dateCode: dc || undefined,
            etaText: eta || undefined,
            costAmount: parsed.amount ?? undefined,
            costCurrency: parsed.currency ?? undefined,
            costTax: parsed.tax ?? undefined,
            supplier: supplier || undefined,
          },
        });
      }
    },
    onSuccess: () => {
      toast.success(open === "in" ? "已入库" : "已记在途");
      qc.invalidateQueries();
      onClose();
      setMpn("");
      setQty("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={Boolean(open)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{open === "in" ? "入库" : "记在途"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>型号</Label>
            <Input className="font-mono" value={mpn} onChange={(e) => setMpn(e.target.value)} />
          </div>
          {open === "in" && (
            <div>
              <Label>仓库</Label>
              <NativeSelect value={wh} onChange={(e) => setWh(e.target.value)}>
                {warehouses
                  .filter((w) => w.isActive)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code}
                    </option>
                  ))}
              </NativeSelect>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>数量</Label>
              <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="10K" />
            </div>
            <div>
              <Label>批次 DC</Label>
              <Input value={dc} onChange={(e) => setDc(e.target.value)} placeholder="2418" />
            </div>
          </div>
          {open === "transit" && (
            <div>
              <Label>货期原话</Label>
              <Input value={eta} onChange={(e) => setEta(e.target.value)} placeholder="4周 / 8月底 / 8/28" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>成本</Label>
              <Input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="$3.20 或 ¥22.5未税" />
            </div>
            <div>
              <Label>供应商</Label>
              <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </div>
          </div>
          <Button disabled={mut.isPending} onClick={() => mut.mutate()}>
            确认
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
