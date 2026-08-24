import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowRight, Radio } from "lucide-react";
import { getWorkbench } from "@/lib/server/workbench";
import { confirmImport, parseImport } from "@/lib/server/import";
import { formatEtaLabel, formatQty } from "@/lib/domain";
import type { ImportRow } from "@/lib/types";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const IMPORT_KIND_LABEL: Record<ImportRow["kind"], string> = {
  offer: "推货",
  inquiry: "询价",
  stock: "入库",
  transit: "在途",
  mixed: "混合",
};

export const Route = createFileRoute("/")({ component: Workbench });

function Workbench() {
  const q = useQuery({ queryKey: ["workbench"], queryFn: () => getWorkbench() });
  const qc = useQueryClient();
  const data = q.data;
  const [paste, setPaste] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [done, setDone] = useState<{ identified: number; hit: number; dual: number } | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  // 工作台内联导入：粘贴 → 识别 → 预览勾选 → 确认入库（不跳转导入页）
  const parseMut = useMutation({
    mutationFn: (text: string) =>
      parseImport({ data: { kind: "mixed", sourceType: "text", text } }),
    onSuccess: (r) => {
      setRows(r.rows);
      setDone(null);
      setParseErr(
        r.rows.length === 0
          ? r.extractMessage || "没有识别到型号，请检查粘贴内容"
          : null,
      );
    },
    onError: (e: Error) => setParseErr(e.message),
  });

  const confirmMut = useMutation({
    mutationFn: () =>
      confirmImport({
        data: {
          kind: "mixed",
          sourceType: "text",
          excerpt: paste.slice(0, 500),
          rows: rows ?? [],
        },
      }),
    onSuccess: (r) => {
      setRows(null);
      setPaste("");
      setDone({ identified: r.summary.identified, hit: r.summary.hit, dual: r.summary.dual });
      qc.invalidateQueries();
      toast.success("已入库");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function toggleRow(id: string) {
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, selected: !r.selected } : r)) ?? null);
  }

  const selectedCount = rows?.filter((r) => r.selected).length ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium tracking-tight">工作台</h1>
          <p className="text-sm text-muted-foreground">今日命中自动汇总，不弹窗骚扰。</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="今日命中" value={data?.stats.todayHits} hint={data ? `双命中 ${data.stats.dualHits}` : ""} />
        <Stat label="今日询价" value={data?.stats.todayInquiries} />
        <Stat label="今日推货" value={data?.stats.todayOffers} />
        <Stat
          label="库存 / 途"
          value={data ? `${data.stats.stockSku} / ${data.stats.transitSku}` : undefined}
        />
      </div>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">智能导入</h2>
          <Link to="/import" className="text-xs text-muted-foreground hover:underline">
            更多方式 →
          </Link>
        </div>
        <Textarea
          className="min-h-20 font-mono text-sm"
          placeholder="贴渠道表或询价，直接在这里识别入库"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            className="flex-1"
            size="sm"
            disabled={!paste.trim() || parseMut.isPending}
            onClick={() => parseMut.mutate(paste)}
          >
            {parseMut.isPending ? "识别中…" : "识别预览"}
          </Button>
          {rows && (
            <Button size="sm" variant="ghost" onClick={() => { setRows(null); setParseErr(null); }}>
              清空
            </Button>
          )}
        </div>
        {parseErr && <p className="mt-2 text-xs text-destructive">{parseErr}</p>}
        {rows && (
          <div className="mt-2 space-y-2 rounded-lg border border-border p-2">
            <p className="text-xs text-muted-foreground">
              识别 {rows.length} 行 · 勾选要入库的
            </p>
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5">
                  <Checkbox checked={r.selected} onCheckedChange={() => toggleRow(r.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{r.mpn}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {IMPORT_KIND_LABEL[r.kind]}
                      {r.qty != null ? ` · ${formatQty(r.qty)}` : ""}
                      {r.channel
                        ? ` · ${r.channel}`
                        : r.customer
                          ? ` · ${r.customer}`
                          : r.warehouse
                            ? ` · ${r.warehouse}`
                            : ""}
                      {r.warning ? ` · ⚠ ${r.warning}` : ""}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Button
              className="w-full"
              size="sm"
              disabled={confirmMut.isPending || selectedCount === 0}
              onClick={() => confirmMut.mutate()}
            >
              {confirmMut.isPending ? "入库中…" : `确认入库（${selectedCount}）`}
            </Button>
          </div>
        )}
        {done && (
          <p className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
            已入库 {done.identified} 条 · 命中 {done.hit} · 双命中 {done.dual}
          </p>
        )}
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          拍照 / Excel / Word / PDF 等其它方式见「更多方式」，先预览再入库。
        </p>
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">今日命中</h2>
          <Radio className="size-4 text-hit" />
        </div>
        {q.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        )}
        {data && data.hits.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">今日暂无交叉命中。</p>
        )}
        <ul className="divide-y divide-border">
          {data?.hits.map((h) => (
            <li key={h.partId}>
              <Link
                to="/parts/$partId"
                params={{ partId: h.partId }}
                search={{ from: "parts" }}
                className="flex items-start justify-between gap-3 py-3 hover:bg-secondary/60"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Mpn value={h.mpn} />
                    {h.brandCode && (
                      <span className="text-xs text-muted-foreground">{h.brandCode}</span>
                    )}
                    <HitBadges flags={h.flags} />
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground tabular">{h.stockLine}</div>
                </div>
                <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <h2 className="mb-3 text-sm font-medium">在途将到</h2>
          {data?.pendingTransit.length === 0 && (
            <p className="text-sm text-muted-foreground">没有在途。</p>
          )}
          <ul className="space-y-2">
            {data?.pendingTransit.map((t) => (
              <li key={t.id}>
                <Link to="/parts/$partId" params={{ partId: t.partId }} search={{ from: "parts" }} className="block">
                  <div className="flex items-baseline justify-between gap-2">
                    <Mpn value={t.mpn} />
                    <span className="font-mono text-xs tabular">
                      途 {formatQty(t.qty)}
                      {t.etaDate
                        ? ` · ${formatEtaLabel({ etaDate: t.etaDate, etaText: t.etaText, precision: t.etaText?.includes("周") ? "week" : t.etaText?.includes("月") ? "month" : "date" })}`
                        : t.etaText
                          ? ` · ${t.etaText}`
                          : ""}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <h2 className="mb-3 text-sm font-medium">有询无货</h2>
          {data?.demandNoStock.length === 0 && (
            <p className="text-sm text-muted-foreground">窗口内需求都有库存覆盖。</p>
          )}
          <ul className="space-y-2">
            {data?.demandNoStock.map((t) => (
              <li key={t.partId}>
                <Link to="/parts/$partId" params={{ partId: t.partId }} search={{ from: "parts" }} className="flex items-baseline justify-between">
                  <Mpn value={t.mpn} />
                  <span className="font-mono text-xs">客{t.inquiryCount}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value?: number | string; hint?: string }) {
  return (
    <div className="rounded-xl bg-card px-3 py-3 shadow-[var(--shadow-border)]">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl tabular">{value ?? "—"}</div>
      {hint ? <div className="text-[11px] text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
