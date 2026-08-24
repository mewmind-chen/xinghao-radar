import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  ArrowRight,
  ClipboardList,
  Radio,
  Settings,
  Star,
  Truck,
} from "lucide-react";
import { getWorkbench } from "@/lib/server/workbench";
import { formatEtaLabel, formatQty } from "@/lib/domain";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/")({ component: Workbench });

function Workbench() {
  const q = useQuery({ queryKey: ["workbench"], queryFn: () => getWorkbench() });
  const data = q.data;
  const nav = useNavigate();
  const [paste, setPaste] = useState("");

  function goImport(draft?: string) {
    if (draft?.trim()) sessionStorage.setItem("import-draft", draft);
    void nav({ to: "/import" });
  }

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

      {/* 金刚区：低频功能入口（底部 Tab 之外的其余功能） */}
      <section className="rounded-xl bg-card p-2 shadow-[var(--shadow-border)]">
        <div className="grid grid-cols-4 gap-1">
          <GongLink to="/channels" icon={Truck} label="渠道货源" n={data?.stats.activeChannels ?? null} />
          <GongLink to="/inquiries" icon={ClipboardList} label="客户询价" n={data?.stats.validInquiries ?? null} />
          <GongLink to="/watchlist" icon={Star} label="潜力型号" n={data?.stats.watch ?? null} />
          <GongLink to="/settings" icon={Settings} label="设置" />
        </div>
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">智能导入</h2>
          <Link to="/import" className="text-xs text-muted-foreground hover:underline">
            全部方式 →
          </Link>
        </div>
        <Textarea
          className="min-h-20 font-mono text-sm"
          placeholder="贴渠道表或询价，去预览确认"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
        <div className="mt-2 flex gap-2">
          <Button className="flex-1" size="sm" disabled={!paste.trim()} onClick={() => goImport(paste)}>
            识别预览
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/import">拍照 / Excel</Link>
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          粘贴识别、拍照、Excel/CSV、Word/PDF 均在导入页完成，先预览再入库。
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

/** 金刚区入口卡（参考电商首页金刚区：图标 + 名称 + 数字角标） */
function GongLink({
  to,
  icon: Icon,
  label,
  n,
}: {
  to: string;
  icon: typeof Truck;
  label: string;
  n?: number | null;
}) {
  return (
    <Link to={to} className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 hover:bg-secondary/60">
      <span className="relative">
        <Icon className="size-5" />
        {n != null && n > 0 && (
          <span className="absolute -right-2.5 -top-1.5 rounded-full bg-primary px-1 text-[9px] leading-4 text-primary-foreground tabular">
            {n}
          </span>
        )}
      </span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </Link>
  );
}
