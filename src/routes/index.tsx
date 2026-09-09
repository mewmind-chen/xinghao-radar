import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Radio } from "lucide-react";
import { getWorkbench } from "@/lib/server/workbench";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/")({ component: Workbench });

function Workbench() {
  const q = useQuery({ queryKey: ["workbench"], queryFn: () => getWorkbench() });
  const data = q.data;

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
        <Stat label="今日入库" value={data?.stats.todayInbound} hint="入库事件数" />
      </div>

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

      <div className="grid gap-4 md:grid-cols-1">
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
