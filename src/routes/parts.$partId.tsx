import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, PenLine, Star } from "lucide-react";
import { getPartDetail, searchParts } from "@/lib/server/parts";
import { updatePartIdentity } from "@/lib/server/parts";
import { listStock } from "@/lib/server/stock";
import { receiveTransit, stockAdjust, stockMeta, stockOutbound, stockTransfer } from "@/lib/server/stock";
import { setOfferValid, setInquiryValid, toggleWatch } from "@/lib/server/market";
import { analyzePartMpn, getPartAnalysis, getPartReview, submitPartReview } from "@/lib/server/knowledge";
import type { PartKnowledgeAnalysis } from "@/lib/server/knowledge";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type DetailSearch = {
  /** 从哪个列表进入：型号库(parts) / 我的库存(stock)，决定上下切换的范围 */
  from: "parts" | "stock";
  q?: string;
  filter?: "all" | "stock" | "hit" | "watch";
  warehouseId?: string;
};

export const Route = createFileRoute("/parts/$partId")({
  validateSearch: (s: Record<string, unknown>): DetailSearch => ({
    from: s.from === "stock" ? "stock" : "parts",
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    filter: s.filter === "stock" || s.filter === "hit" || s.filter === "watch" ? s.filter : "all",
    warehouseId: typeof s.warehouseId === "string" && s.warehouseId ? s.warehouseId : undefined,
  }),
  component: PartDetail,
});

function PartDetail() {
  const { partId } = Route.useParams();
  const ctx = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["part", partId],
    queryFn: () => getPartDetail({ data: { id: partId } }),
  });
  const meta = useQuery({ queryKey: ["stock-meta"], queryFn: () => stockMeta() });
  const d = q.data;
  const [op, setOp] = useState<null | "out" | "move" | "adj" | "recv">(null);
  const [lotId, setLotId] = useState<string | null>(null);
  const [fixOpen, setFixOpen] = useState(false);

  // 上下切换上下文：按进入来源加载同一列表，定位当前序号
  const ctxList = useQuery({
    queryKey: ["detail-ctx", ctx.from, ctx.q ?? "", ctx.filter ?? "all", ctx.warehouseId ?? ""],
    queryFn: async (): Promise<{ id: string; mpn: string }[]> => {
      if (ctx.from === "stock") {
        const r = await listStock({
          data: { q: ctx.q || undefined, warehouseId: ctx.warehouseId || undefined },
        });
        const seen = new Set<string>();
        const out: { id: string; mpn: string }[] = [];
        for (const it of r.items) {
          if (!seen.has(it.partId)) {
            seen.add(it.partId);
            out.push({ id: it.partId, mpn: it.mpn });
          }
        }
        return out;
      }
      const rows = await searchParts({ data: { q: ctx.q ?? "", filter: ctx.filter ?? "all" } });
      return rows.map((p) => ({ id: p.id, mpn: p.mpn }));
    },
  });
  const ctxIdx = ctxList.data?.findIndex((p) => p.id === partId) ?? -1;
  const ctxPrev = ctxIdx > 0 ? ctxList.data![ctxIdx - 1] : null;
  const ctxNext =
    ctxIdx >= 0 && ctxIdx < (ctxList.data?.length ?? 0) - 1 ? ctxList.data![ctxIdx + 1] : null;

  // 切换型号时回到顶部
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [partId]);

  // 左右滑动手势切换型号（与「上一个/下一个」按钮等效）
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      const t = e.target as HTMLElement | null;
      // 对话框、表单控件、可点击元素内部不触发滑动切换
      if (!t || t.closest("[role='dialog'],button,a,input,select,textarea,[data-swipe='off']")) {
        touchRef.current = null;
        return;
      }
      if (e.touches.length !== 1) {
        touchRef.current = null;
        return;
      }
      touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const onTouchEnd = (e: TouchEvent) => {
      const st = touchRef.current;
      touchRef.current = null;
      if (!st || !e.changedTouches[0]) return;
      const dx = e.changedTouches[0].clientX - st.x;
      const dy = e.changedTouches[0].clientY - st.y;
      // 水平位移足够且明显大于纵向（滚动页面的纵向滑动不触发）
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const target = dx < 0 ? ctxNext : ctxPrev;
      if (target) {
        navigate({
          to: "/parts/$partId",
          params: { partId: target.id },
          search: ctx,
        });
      }
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [ctxPrev, ctxNext, ctx, navigate]);

  const watchMut = useMutation({
    mutationFn: (on: boolean) => toggleWatch({ data: { partId, on } }),
    onSuccess: () => {
      qc.invalidateQueries();
    },
  });

  const analyzeMut = useMutation({
    mutationFn: () => analyzePartMpn({ data: { mpn: d?.part.mpn ?? "" } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["part-analysis"] });
      qc.invalidateQueries({ queryKey: ["parts"] });
      if (r.ok) toast.success("型号分析已保存");
    },
  });

  // 进入即读取本型号已保存的分析（有则直接展示，无需重新抓取）
  const stored = useQuery({
    queryKey: ["part-analysis", d?.part.mpn],
    queryFn: () => getPartAnalysis({ data: { mpn: d?.part.mpn ?? "" } }),
    enabled: Boolean(d?.part.mpn),
    staleTime: 60_000,
  });

  // 人工决定（接受/拒绝/修正）。Radar 持久化最终动作，平台不写业务决定。
  const reviewQuery = useQuery({
    queryKey: ["part-review", d?.part.mpn],
    queryFn: () => getPartReview({ data: { mpn: d?.part.mpn ?? "" } }),
    enabled: Boolean(d?.part.mpn),
    staleTime: 30_000,
  });
  const [reviewNote, setReviewNote] = useState("");
  const [correctedJson, setCorrectedJson] = useState("");
  const reviewMut = useMutation({
    mutationFn: (decision: "accept" | "reject" | "corrected") =>
      submitPartReview({
        data: {
          mpn: d?.part.mpn ?? "",
          decision,
          note: reviewNote.trim() || undefined,
          correctedJson: decision === "corrected" && correctedJson.trim() ? correctedJson.trim() : undefined,
        },
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["part-review"] });
      if (r.ok) {
        setReviewNote("");
        setCorrectedJson("");
        toast.success("人工决定已保存（业务系统持有）");
      } else {
        toast.error(r.error || "保存决定失败");
      }
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

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <Link
          to="/parts/$partId"
          params={{ partId: ctxPrev?.id ?? "" }}
          search={ctx}
          title={ctxPrev?.mpn}
          className={cn(
            "shrink-0 rounded-md border border-border px-2 py-1",
            ctxPrev ? "hover:bg-secondary hover:text-foreground" : "pointer-events-none opacity-40",
          )}
          aria-disabled={!ctxPrev}
        >
          ← 上一个
        </Link>
        <span className="tabular">
          {ctxList.data ? (ctxIdx >= 0 ? `${ctxIdx + 1} / ${ctxList.data.length}` : "—") : "…"}
        </span>
        <Link
          to="/parts/$partId"
          params={{ partId: ctxNext?.id ?? "" }}
          search={ctx}
          title={ctxNext?.mpn}
          className={cn(
            "shrink-0 rounded-md border border-border px-2 py-1",
            ctxNext ? "hover:bg-secondary hover:text-foreground" : "pointer-events-none opacity-40",
          )}
          aria-disabled={!ctxNext}
        >
          下一个 →
        </Link>
      </div>
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
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFixOpen(true)}
              title="修正完整型号/品牌（录入错误时）"
            >
              <PenLine className="size-3.5" />
              修正
            </Button>
            <Button
              variant={d.watched ? "hit" : "outline"}
              className="w-full sm:w-auto"
              onClick={() => watchMut.mutate(!d.watched)}
            >
              <Star className={cn("size-4", d.watched && "fill-current")} />
              {d.watched ? "已关注" : "潜力"}
            </Button>
          </div>
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
              <span className="w-14 shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground tabular">
                {formatMd(ev.t)}
              </span>
              <span className="min-w-0">{ev.node}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">产品知识</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => analyzeMut.mutate()}
            disabled={analyzeMut.isPending}
          >
            {analyzeMut.isPending
              ? "分析中…"
              : stored.data
                ? "重新分析"
                : "型号分析"}
          </Button>
        </div>
        {(d.part.description || d.part.params) && (
          <div className="mb-2">
            {d.part.description && <p className="text-sm">{d.part.description}</p>}
            {d.part.params && (
              <p className="mt-1 font-mono text-xs text-muted-foreground">{d.part.params}</p>
            )}
          </div>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">仅基于已录入资料，不猜测车规/军工等级。</p>
        {!analyzeMut.data && !analyzeMut.isPending && stored.data?.analysis ? (
          <>
            <PartKnowledgePanel analysis={stored.data.analysis} loading={false} />
            {stored.data.analyzedAt && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                已保存 · 上次分析 {new Date(stored.data.analyzedAt).toLocaleString("zh-CN", { hour12: false })}
              </p>
            )}
          </>
        ) : null}
        {/* 本次分析结果（或进行中骨架）优先于缓存 */}
        <PartKnowledgePanel
          analysis={analyzeMut.data}
          loading={analyzeMut.isPending}
        />
        {reviewQuery.data?.decision && (
          <p className="mt-2 rounded-lg bg-secondary/40 px-3 py-2 text-[11px] text-muted-foreground">
            人工决定：
            {reviewQuery.data.decision === "accept"
              ? "已接受"
              : reviewQuery.data.decision === "reject"
                ? "已拒绝"
                : "已修正"}
            {reviewQuery.data.reviewedAt
              ? ` · ${new Date(reviewQuery.data.reviewedAt).toLocaleString("zh-CN", { hour12: false })}`
              : ""}
            {reviewQuery.data.note ? ` · ${reviewQuery.data.note}` : ""}
          </p>
        )}
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => reviewMut.mutate("accept")}
              disabled={reviewMut.isPending || !d?.part.mpn}
            >
              接受此分析
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => reviewMut.mutate("reject")}
              disabled={reviewMut.isPending || !d?.part.mpn}
            >
              拒绝此分析
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!correctedJson.trim()) {
                  toast.error("修正需要填写修正后的 JSON");
                  return;
                }
                reviewMut.mutate("corrected");
              }}
              disabled={reviewMut.isPending || !d?.part.mpn}
            >
              提交修正
            </Button>
          </div>
          <Textarea
            value={correctedJson}
            onChange={(e) => setCorrectedJson(e.target.value)}
            placeholder="修正后的分析 JSON（可选；提交修正时必填）"
            className="min-h-[64px] font-mono text-xs"
          />
          <Textarea
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            placeholder="备注（可选）"
            className="min-h-[40px] text-xs"
          />
        </div>
      </section>

      <CorrectPartDialog
        open={fixOpen}
        onClose={() => setFixOpen(false)}
        partId={partId}
        current={{ mpn: d.part.mpn, brand: d.part.brandCode ?? "" }}
        onDone={() => {
          qc.invalidateQueries();
          setFixOpen(false);
        }}
      />

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

function PartKnowledgePanel({
  analysis,
  loading,
}: {
  analysis: PartKnowledgeAnalysis | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="mt-3 space-y-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (!analysis) return null;
  if (!analysis.ok) {
    return (
      <p className="mt-3 rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
        型号分析暂不可用{analysis.error ? `：${analysis.error}` : ""}
      </p>
    );
  }

  const { positioning, headline, specs, applications, replacements, lcsc, hqew, internalBusinessAdvice } = analysis;
  const money = (n: number | null | undefined) =>
    n == null || !Number.isFinite(n) ? "—" : `¥${n.toLocaleString("zh-CN")}`;

  return (
    <div className="mt-3 space-y-3">
      <div className="flex gap-3">
        {lcsc?.imageUrl ? (
          <a href={lcsc.url || "#"} target="_blank" rel="noreferrer" className="shrink-0">
            <img
              src={lcsc.imageUrl}
              alt="芯片封装图"
              loading="lazy"
              className="h-28 w-28 rounded-lg border bg-white object-contain"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          </a>
        ) : null}
        <div className="min-w-0">
          {headline && <p className="text-sm font-medium">{headline}</p>}
          {positioning && <p className="mt-0.5 text-xs text-muted-foreground">{positioning}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lcsc && (
              <Badge variant="outline" className="text-[11px]">
                立创 {money(lcsc.price)} · 现货 {formatQty(lcsc.stock)}
              </Badge>
            )}
            {hqew && hqew.count > 0 && (
              <Badge variant="outline" className="text-[11px]">
                华强 {hqew.count} 家 · {formatQty(hqew.totalStock)} · 最低{" "}
                {money(hqew.minPrice)}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {internalBusinessAdvice && (
        <div className="rounded-lg bg-secondary/60 px-3 py-2.5">
          <h3 className="text-xs font-medium text-muted-foreground">内部业务建议</h3>
          <p className="mt-1 text-sm font-medium">{internalBusinessAdvice.action}</p>
          {internalBusinessAdvice.reasoning && (
            <p className="mt-1 text-xs text-muted-foreground">{internalBusinessAdvice.reasoning}</p>
          )}
        </div>
      )}

      {applications && applications.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">应用</h3>
          <div className="flex flex-wrap gap-1">
            {applications.slice(0, 8).map((a, i) => (
              <Badge key={i} variant="mute" className="text-[11px]">
                {a}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {specs && specs.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">规格参数</h3>
          <ul className="divide-y rounded-lg border">
            {specs.slice(0, 12).map((s, i) => (
              <li key={i} className="flex gap-3 px-2.5 py-1.5 text-xs">
                <span className="w-32 shrink-0 text-muted-foreground">{s.label}</span>
                <span className="min-w-0 break-words">{s.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {lcsc && lcsc.priceBreaks.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">立创量价</h3>
          <div className="flex flex-wrap gap-1.5">
            {lcsc.priceBreaks.map((b, i) => (
              <span key={i} className="rounded-md bg-secondary/60 px-2 py-1 text-[11px] tabular">
                {formatQty(b.qty)}+ {money(b.price)}
              </span>
            ))}
          </div>
        </div>
      )}

      {replacements && replacements.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">相似型号</h3>
          <ul className="space-y-1">
            {replacements.slice(0, 5).map((r, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-mono">{r.mpn}</span>
                {r.brand && <span className="text-muted-foreground">{r.brand}</span>}
                {r.package && <span className="text-muted-foreground">{r.package}</span>}
                {r.similarity && <span className="text-muted-foreground">{r.similarity}</span>}
                <span className="tabular">{money(r.price)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        分析数据来自立创商城 / 华强电子网公开页面，仅供参考，采购以实际确认单为准。
        {analysis.analyzedAt &&
          ` · ${new Date(analysis.analyzedAt).toLocaleString("zh-CN", { hour12: false })}`}
      </p>
    </div>
  );
}

function CorrectPartDialog({
  open,
  onClose,
  partId,
  current,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  partId: string;
  current: { mpn: string; brand: string };
  onDone: () => void;
}) {
  const [mpn, setMpn] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [pkg, setPkg] = useState("");
  const [fetched, setFetched] = useState(false);

  const analyzeMut = useMutation({
    mutationFn: () => analyzePartMpn({ data: { mpn: mpn.trim() } }),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(r.error ?? "分析失败");
        return;
      }
      // 自动带入立创标准型号/品牌/封装，供人工删减后保存
      if (r.resolvedMpn) setMpn(r.resolvedMpn);
      if (r.resolvedBrand) setBrand(r.resolvedBrand.split(/[（(]/)[0].trim());
      if (r.resolvedCategory) setCategory(r.resolvedCategory);
      if (r.resolvedPackage) setPkg(r.resolvedPackage);
      setFetched(true);
      toast.success("已带入立创标准资料，可删减尾缀后保存");
    },
  });

  const saveMut = useMutation({
    mutationFn: () =>
      updatePartIdentity({
        data: {
          id: partId,
          mpn: mpn.trim(),
          brand: brand.trim() || undefined,
          category: category.trim() || undefined,
          package: pkg.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("型号主档已修正");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修正型号主档</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            当前：<span className="font-mono">{current.mpn}</span>
            {current.brand ? ` · ${current.brand}` : ""}。修正后库存、渠道、询价、流水等历史全部保留。
          </p>
          <div>
            <Label>完整型号</Label>
            <div className="flex gap-1.5">
              <Input
                value={mpn}
                onChange={(e) => setMpn(e.target.value)}
                placeholder="如 AD9631ARZ-REEL7"
                className="font-mono"
              />
              <Button
                variant="outline"
                className="shrink-0"
                disabled={!mpn.trim() || analyzeMut.isPending}
                onClick={() => analyzeMut.mutate()}
              >
                {analyzeMut.isPending ? "查询中…" : "分析带入"}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              点击「分析带入」自动查立创标准型号；包装尾缀如 -REEL7 可直接删掉。
            </p>
          </div>
          {fetched && (
            <p className="rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-700">
              已带入立创标准资料，改为标准型号后保存
            </p>
          )}
          <div>
            <Label>品牌</Label>
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="如 ADI" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>类目</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="如 运算放大器" />
            </div>
            <div>
              <Label>封装</Label>
              <Input value={pkg} onChange={(e) => setPkg(e.target.value)} placeholder="如 SOIC-8" />
            </div>
          </div>
          <Button disabled={!mpn.trim() || saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? "保存中…" : "保存"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
