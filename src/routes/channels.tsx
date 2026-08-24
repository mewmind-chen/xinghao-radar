import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  createOffer,
  listOffers,
  setChannelActive,
  setOfferValid,
  softDeleteOffers,
} from "@/lib/server/market";
import { formatOfferLine, formatWhen, parseQty } from "@/lib/domain";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/channels")({ component: ChannelsPage });

function ChannelsPage() {
  const qc = useQueryClient();
  const [scope, setScope] = useState<"valid" | "history" | "all">("valid");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ["offers", scope, q],
    queryFn: () => listOffers({ data: { scope, q: q || undefined } }),
  });
  const items = list.data?.items ?? [];
  const channels = list.data?.channels ?? [];

  function toggle(id: string) {
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">渠道货源</h1>
          <p className="text-sm text-muted-foreground">只记货源事实。无效退出匹配，历史仍在。</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          记一笔
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect className="w-32" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="valid">当前有效</option>
          <option value="history">历史无效</option>
          <option value="all">全部</option>
        </NativeSelect>
        <Input className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="型号 / 渠道" />
      </div>
      {sel.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-lg bg-secondary px-3 py-2 text-sm">
          已选 {sel.length}
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setOfferValid({ data: { ids: sel, isValid: false } }).then(() => {
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
              setOfferValid({ data: { ids: sel, isValid: true } }).then(() => {
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
              softDeleteOffers({ data: { ids: sel } }).then(() => {
                qc.invalidateQueries();
                setSel([]);
                toast.success("已删除（录错才删）");
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
            <Checkbox checked={sel.includes(it.id)} onCheckedChange={() => toggle(it.id)} className="mt-1" />
            <Link to="/parts/$partId" params={{ partId: it.partId }} search={{ from: "parts" }} className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Mpn value={it.mpn} />
                {it.brandCode && <span className="text-xs text-muted-foreground">{it.brandCode}</span>}
                <HitBadges flags={it.flags} />
                {!it.isValid && <span className="text-[11px] text-muted-foreground">无效</span>}
              </div>
              <div className="mt-1 text-sm">
                {it.channelName} · {formatOfferLine(it)}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatWhen(it.offeredAt)}
                {it.stockLine ? ` · ${it.stockLine}` : ""}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">渠道对象</h2>
        <ul className="space-y-2">
          {channels.map((ch) => (
            <li key={ch.id} className="flex items-center justify-between gap-3">
              <span className="text-sm">{ch.name}</span>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {ch.isActive ? "启用" : "停用"}
                <Switch
                  checked={ch.isActive}
                  onCheckedChange={(v) =>
                    setChannelActive({ data: { id: ch.id, isActive: v } }).then(() =>
                      qc.invalidateQueries(),
                    )
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      </section>
      <OfferDialog open={open} onOpenChange={setOpen} channels={channels.map((c) => c.name)} />
    </div>
  );
}

function OfferDialog({
  open,
  onOpenChange,
  channels,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  channels: string[];
}) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState(channels[0] ?? "");
  const [mpn, setMpn] = useState("");
  const [qty, setQty] = useState("");
  const [dc, setDc] = useState("");
  const [tp, setTp] = useState(true);
  const [lt, setLt] = useState("");
  const uniq = useMemo(() => [...new Set(channels)], [channels]);
  const mut = useMutation({
    mutationFn: async () => {
      const n = qty ? parseQty(qty) : null;
      const r = await createOffer({
        data: {
          channel,
          mpn,
          qty: n,
          dateCode: dc || undefined,
          isTp: tp,
          leadTimeText: lt || undefined,
        },
      });
      return r;
    },
    onSuccess: (r) => {
      toast.success(r.flags.isHit ? `已记 · 命中 ${r.flags.inquiryCount ? "客" + r.flags.inquiryCount : ""}` : "已记");
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
          <DialogTitle>记一笔推货</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>渠道</Label>
            <Input list="ch-list" value={channel} onChange={(e) => setChannel(e.target.value)} />
            <datalist id="ch-list">
              {uniq.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div>
            <Label>型号</Label>
            <Input className="font-mono" value={mpn} onChange={(e) => setMpn(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>数量</Label>
              <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="20K" />
            </div>
            <div>
              <Label>DC</Label>
              <Input value={dc} onChange={(e) => setDc(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>货期 LT</Label>
            <Input value={lt} onChange={(e) => setLt(e.target.value)} placeholder="LT 4周" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={tp} onCheckedChange={(v) => setTp(Boolean(v))} />
            无报价，记为 TP
          </label>
          <Button disabled={mut.isPending || !mpn || !channel} onClick={() => mut.mutate()}>
            确认
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
