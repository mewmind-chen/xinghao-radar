import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus } from "lucide-react";
import { createPart, searchParts } from "@/lib/server/parts";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

type Search = { q?: string };

export const Route = createFileRoute("/parts/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    q: typeof s.q === "string" ? s.q : undefined,
  }),
  component: PartsPage,
});

function PartsPage() {
  const { q } = Route.useSearch();
  const [filter, setFilter] = useState<"all" | "stock" | "hit" | "watch">("all");
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const list = useQuery({
    queryKey: ["parts", q, filter],
    queryFn: () => searchParts({ data: { q, filter } }),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">型号库</h1>
          <p className="text-sm text-muted-foreground">一型号一主档，点进去看完整故事。</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          建档
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          className="w-36"
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
        >
          <option value="all">全部</option>
          <option value="hit">有命中</option>
          <option value="stock">有库存/途</option>
          <option value="watch">潜力池</option>
        </NativeSelect>
        {q ? <span className="self-center text-sm text-muted-foreground">搜索：{q}</span> : null}
      </div>
      {list.isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)]">
        {list.data?.map((p) => (
          <li key={p.id}>
            <Link
              to="/parts/$partId"
              params={{ partId: p.id }}
              search={{ from: "parts", q: q || undefined, filter }}
              className="flex flex-col gap-1 px-4 py-3 hover:bg-secondary/50 md:flex-row md:items-center md:justify-between"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Mpn value={p.mpn} />
                {p.brandCode && <span className="text-xs text-muted-foreground">{p.brandCode}</span>}
                {p.category && <span className="text-xs text-muted-foreground">{p.category}</span>}
                {p.analysisAt && (
                  <Badge variant="outline" className="text-[10px] text-emerald-600">
                    已分析
                  </Badge>
                )}
                <HitBadges flags={p.flags} />
              </div>
              <div className="font-mono text-xs text-muted-foreground tabular">{p.stockLine}</div>
            </Link>
          </li>
        ))}
      </ul>
      {list.data?.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">没有匹配的型号。</p>
      )}
      <CreatePartDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={(id) => nav({ to: "/parts/$partId", params: { partId: id }, search: { from: "parts", q: undefined, filter: "all" } })}
      />
    </div>
  );
}

function CreatePartDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [mpn, setMpn] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [pkg, setPkg] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      createPart({ data: { mpn, brand: brand || undefined, category, package: pkg || undefined } }),
    onSuccess: (p) => {
      toast.success("主档已建立");
      qc.invalidateQueries();
      onOpenChange(false);
      onCreated(p.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>建立型号主档</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>型号 MPN</Label>
            <Input value={mpn} onChange={(e) => setMpn(e.target.value)} className="font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>品牌</Label>
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="TI" />
            </div>
            <div>
              <Label>类别</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>封装</Label>
            <Input value={pkg} onChange={(e) => setPkg(e.target.value)} />
          </div>
          <Button disabled={!mpn.trim() || mut.isPending} onClick={() => mut.mutate()}>
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
