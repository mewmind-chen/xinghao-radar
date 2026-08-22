import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getAppSettings,
  setWarehouseActive,
  undoImportBatch,
  updateWindows,
  upsertWarehouse,
} from "@/lib/server/settings";
import { formatWhen } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => getAppSettings() });
  const d = q.data;
  const [inq, setInq] = useState<number | null>(null);
  const [off, setOff] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const inquiry = inq ?? d?.settings.inquiryWindowDays ?? 90;
  const offer = off ?? d?.settings.offerWindowDays ?? 30;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-medium">设置</h1>
        <p className="text-sm text-muted-foreground">窗口只控制提醒，不删除历史。</p>
      </div>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">匹配时间范围</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>客户询价提醒</Label>
            <NativeSelect
              value={String(inquiry)}
              onChange={(e) => setInq(Number(e.target.value))}
            >
              {[30, 60, 90, 180].map((n) => (
                <option key={n} value={n}>
                  {n} 天
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label>渠道货源提醒</Label>
            <NativeSelect value={String(offer)} onChange={(e) => setOff(Number(e.target.value))}>
              {[7, 15, 30, 60].map((n) => (
                <option key={n} value={n}>
                  {n} 天
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <Button
          className="mt-3"
          size="sm"
          onClick={() =>
            updateWindows({ data: { inquiryWindowDays: inquiry, offerWindowDays: offer } }).then(
              () => {
                qc.invalidateQueries();
                toast.success("已保存");
              },
            )
          }
        >
          保存窗口
        </Button>
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">仓库</h2>
        <ul className="space-y-2">
          {d?.warehouses.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-3">
              <span className="text-sm">
                {w.code}
                <span className="ml-2 text-muted-foreground">{w.name}</span>
              </span>
              <Switch
                checked={w.isActive}
                onCheckedChange={(v) =>
                  setWarehouseActive({ data: { id: w.id, isActive: v } }).then(() =>
                    qc.invalidateQueries(),
                  )
                }
              />
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input className="w-24" placeholder="代码" value={code} onChange={(e) => setCode(e.target.value)} />
          <Input className="w-32" placeholder="显示名" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              upsertWarehouse({ data: { code, name } }).then(() => {
                setCode("");
                setName("");
                qc.invalidateQueries();
              })
            }
          >
            新增仓库
          </Button>
        </div>
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">导入批次</h2>
        <ul className="space-y-2 text-sm">
          {d?.batches.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2">
              <span>
                {b.kind} · {b.sourceType} {b.filename ?? ""} · {formatWhen(b.createdAt)}
                {b.undoneAt && <span className="ml-2 text-muted-foreground">已撤销</span>}
              </span>
              {!b.undoneAt && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    undoImportBatch({ data: { id: b.id } })
                      .then(() => {
                        qc.invalidateQueries();
                        toast.success("批次已撤销");
                      })
                      .catch((e: Error) => toast.error(e.message))
                  }
                >
                  撤销
                </Button>
              )}
            </li>
          ))}
          {d?.batches.length === 0 && (
            <li className="text-muted-foreground">还没有导入批次。</li>
          )}
        </ul>
      </section>

      <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
        <h2 className="mb-3 text-sm font-medium">操作日志</h2>
        <ul className="space-y-1 font-mono text-xs text-muted-foreground">
          {d?.logs.map((l) => (
            <li key={l.id}>
              {formatWhen(l.createdAt)} · {l.action} · {l.entityType} · {l.detail ?? l.entityId}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
