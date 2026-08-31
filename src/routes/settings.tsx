import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getAppSettings,
  setWarehouseActive,
  updateWindows,
  upsertWarehouse,
} from "@/lib/server/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useAppAccess } from "@/lib/auth/use-app-access";

export const Route = createFileRoute("/settings")({ component: SettingsPage });

function SettingsPage() {
  const qc = useQueryClient();
  const access = useAppAccess();
  const canManageSettings = access.can("settings.manage");
  const q = useQuery({ queryKey: ["settings"], queryFn: () => getAppSettings(), enabled: canManageSettings });
  const d = q.data;
  const [inq, setInq] = useState<number | null>(null);
  const [off, setOff] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const inquiry = inq ?? d?.settings.inquiryWindowDays ?? 90;
  const offer = off ?? d?.settings.offerWindowDays ?? 30;

  if (access.access && !canManageSettings) {
    return <p className="text-sm text-muted-foreground">无权查看系统设置。</p>;
  }

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

    </div>
  );
}
