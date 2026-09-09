import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { listOperationLogs } from "@/lib/server/audit";

export const Route = createFileRoute("/logs")({ component: LogsPage });

function LogsPage() {
  const query = useQuery({ queryKey: ["operation-logs"], queryFn: () => listOperationLogs({ data: { limit: 50, offset: 0 } }) });
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-medium tracking-tight">操作记录</h1>
        <p className="mt-1 text-sm text-muted-foreground">仅向有“查看操作记录”权限的用户展示；密码、令牌等敏感字段不会写入日志。</p>
      </div>
      {query.isLoading && <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">正在读取操作记录…</p>}
      {query.isError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">操作记录读取失败：{(query.error as Error).message}</p>}
      {query.data && (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm text-muted-foreground">共 {query.data.total} 条</div>
          {query.data.items.length === 0 ? <p className="p-5 text-sm text-muted-foreground">暂无操作记录。</p> : (
            <div className="divide-y divide-border">
              {query.data.items.map((item) => (
                <article key={item.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[160px_minmax(0,1fr)_180px] md:items-center">
                  <time className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString("zh-CN")}</time>
                  <div className="min-w-0">
                    <div className="font-medium">{item.action} · {item.entityType} · <span className="font-mono text-xs">{item.entityId}</span></div>
                    <div className="truncate text-xs text-muted-foreground">{item.detail || item.failureReason || "—"}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">操作者：{item.actorName || "系统"}{item.effectiveName && item.effectiveName !== item.actorName ? ` · 生效身份：${item.effectiveName}` : ""}</div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
