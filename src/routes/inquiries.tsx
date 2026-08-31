import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  createInquiry,
  listInquiries,
  setCustomerActive,
  setInquiryValid,
  softDeleteInquiries,
} from "@/lib/server/market";
import { formatQty, formatWhen, parseQty } from "@/lib/domain";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useAppAccess } from "@/lib/auth/use-app-access";

export const Route = createFileRoute("/inquiries")({ component: InquiriesPage });

function InquiriesPage() {
  const qc = useQueryClient();
  const access = useAppAccess();
  const canWrite = access.can("market.write");
  const [scope, setScope] = useState<"valid" | "history" | "all">("valid");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ["inquiries", scope, q],
    queryFn: () => listInquiries({ data: { scope, q: q || undefined } }),
  });
  const items = list.data?.items ?? [];
  const customers = list.data?.customers ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">客户询价</h1>
          <p className="text-sm text-muted-foreground">同一客户重复询同一型号，必须新记一条。</p>
        </div>
        {canWrite && <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          记一笔
        </Button>}
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect className="w-32" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="valid">当前有效</option>
          <option value="history">历史无效</option>
          <option value="all">全部</option>
        </NativeSelect>
        <Input className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="型号 / 客户" />
      </div>
      {canWrite && sel.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-lg bg-secondary px-3 py-2 text-sm">
          已选 {sel.length}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setInquiryValid({ data: { ids: sel, isValid: false } }).then(() => {
                qc.invalidateQueries();
                setSel([]);
                toast.success("已批量无效");
              })
            }
          >
            设为无效
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setInquiryValid({ data: { ids: sel, isValid: true } }).then(() => {
                qc.invalidateQueries();
                setSel([]);
              })
            }
          >
            恢复有效
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              softDeleteInquiries({ data: { ids: sel } }).then(() => {
                qc.invalidateQueries();
                setSel([]);
              })
            }
          >
            删除
          </Button>
        </div>
      )}
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)]">
        {items.map((it) => (
          <li key={it.id} className="flex items-start gap-3 px-3 py-3">
            <Checkbox
              checked={sel.includes(it.id)}
              onCheckedChange={() =>
                setSel((s) => (s.includes(it.id) ? s.filter((x) => x !== it.id) : [...s, it.id]))
              }
              className="mt-1"
            />
            <Link to="/parts/$partId" params={{ partId: it.partId }} search={{ from: "parts" }} className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Mpn value={it.mpn} />
                {it.brandCode && <span className="text-xs text-muted-foreground">{it.brandCode}</span>}
                <HitBadges flags={it.flags} />
                {!it.isValid && <span className="text-[11px] text-muted-foreground">无效</span>}
              </div>
              <div className="mt-1 text-sm">
                {it.customerName} · {it.qty != null ? formatQty(it.qty) : "—"}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatWhen(it.inquiredAt)}
                {it.stockLine ? ` · ${it.stockLine}` : ""}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">客户对象</h2>
        <ul className="space-y-2">
          {customers.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3">
              <span className="text-sm">{c.name}</span>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {c.isActive ? "启用" : "停用"}
                {canWrite && <Switch
                  checked={c.isActive}
                  onCheckedChange={(v) =>
                    setCustomerActive({ data: { id: c.id, isActive: v } }).then(() =>
                      qc.invalidateQueries(),
                    )
                  }
                />}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {canWrite && <InquiryDialog open={open} onOpenChange={setOpen} customers={customers.map((c) => c.name)} />}
    </div>
  );
}

function InquiryDialog({
  open,
  onOpenChange,
  customers,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  customers: string[];
}) {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState(customers[0] ?? "");
  const [mpn, setMpn] = useState("");
  const [qty, setQty] = useState("");
  const uniq = useMemo(() => [...new Set(customers)], [customers]);
  const mut = useMutation({
    mutationFn: () =>
      createInquiry({
        data: { customer, mpn, qty: qty ? parseQty(qty) : null },
      }),
    onSuccess: (r) => {
      toast.success(r.flags.stock ? "已记 · 命中库存" : "已记");
      qc.invalidateQueries();
      onOpenChange(false);
      setMpn("");
      setQty("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>记一笔询价</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>客户</Label>
            <Input list="cu-list" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            <datalist id="cu-list">
              {uniq.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <Label>型号</Label>
            <Input className="font-mono" value={mpn} onChange={(e) => setMpn(e.target.value)} />
          </div>
          <div>
            <Label>数量</Label>
            <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="5K" />
          </div>
          <Button disabled={mut.isPending || !mpn || !customer} onClick={() => mut.mutate()}>
            确认
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
