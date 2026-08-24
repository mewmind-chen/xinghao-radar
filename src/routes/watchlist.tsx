import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { listWatchlist, toggleWatch } from "@/lib/server/market";
import { HitBadges } from "@/components/hit-badges";
import { Mpn } from "@/components/mpn";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/watchlist")({ component: WatchPage });

function WatchPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["watchlist"], queryFn: () => listWatchlist() });
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-medium">潜力型号</h1>
        <p className="text-sm text-muted-foreground">关注池。新询价或新货源会在工作台命中。</p>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)]">
        {list.data?.map((it) => (
          <li key={it.partId} className="flex items-start gap-3 px-4 py-3">
            <Star className="mt-0.5 size-4 fill-current text-primary" />
            <Link to="/parts/$partId" params={{ partId: it.partId }} search={{ from: "parts" }} className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Mpn value={it.mpn} />
                {it.brandCode && <span className="text-xs text-muted-foreground">{it.brandCode}</span>}
                <HitBadges flags={it.flags} />
              </div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{it.stockLine}</div>
              {it.note && <div className="text-xs text-muted-foreground">{it.note}</div>}
            </Link>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                toggleWatch({ data: { partId: it.partId, on: false } }).then(() => {
                  qc.invalidateQueries();
                  toast.success("已移出");
                })
              }
            >
              移出
            </Button>
          </li>
        ))}
      </ul>
      {list.data?.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">潜力池是空的。在型号详情点「潜力」。</p>
      )}
    </div>
  );
}
