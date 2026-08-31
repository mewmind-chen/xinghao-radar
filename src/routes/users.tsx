import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { assignLegacyPotential, listAppUsers, listLegacyPotential, startIdentityCheck, updateAppUser, type AppUserRow } from "@/lib/server/auth";
import { APP_ROLES, type AppRole } from "@/lib/auth/roles";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export const Route = createFileRoute("/users")({ component: UsersPage });

function UsersPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["app-users"], queryFn: () => listAppUsers() });
  const legacyQ = useQuery({ queryKey: ["legacy-potential"], queryFn: () => listLegacyPotential() });
  const [busyId, setBusyId] = useState<string | null>(null);
  const roleMut = useMutation({
    mutationFn: (data: { userId: string; role: AppRole | null }) => updateAppUser({ data }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["app-users"] }); toast.success("角色已保存"); },
    onError: (err: Error) => toast.error(err.message),
  });
  const toggleMut = useMutation({
    mutationFn: (data: { userId: string; potentialEnabled: boolean }) => updateAppUser({ data }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["app-users"] }); toast.success("潜力型号权限已保存"); },
    onError: (err: Error) => toast.error(err.message),
  });
  const checkMut = useMutation({
    mutationFn: (targetUserId: string) => startIdentityCheck({ data: { targetUserId } }),
    onSuccess: () => { toast.success("已进入权限检查"); window.location.href = "/"; },
    onError: (err: Error) => toast.error(err.message),
  });
  const assignMut = useMutation({
    mutationFn: (data: { partId: string; userId: string }) => assignLegacyPotential({ data }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["legacy-potential"] }); toast.success("已明确归属到用户"); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-medium">用户与权限</h1>
        <p className="text-sm text-muted-foreground">仅老板可见。角色和停用状态由服务端执行，潜力型号权限默认关闭。</p>
      </div>
      <div className="overflow-x-auto rounded-xl bg-card shadow-[var(--shadow-border)]">
        <table className="w-full min-w-[700px] text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-normal">用户</th>
              <th className="px-4 py-3 font-normal">角色</th>
              <th className="px-4 py-3 font-normal">潜力型号</th>
              <th className="px-4 py-3 font-normal">状态</th>
              <th className="px-4 py-3 font-normal">身份检查</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {q.data?.map((user) => (
              <tr key={user.userId}>
                <td className="px-4 py-3">
                  <div>{user.displayName}</div>
                  <div className="font-mono text-xs text-muted-foreground">{user.email}</div>
                </td>
                <td className="px-4 py-3">
                  <NativeSelect
                    className="h-9 w-32"
                    value={user.role ?? ""}
                    onChange={(e) => roleMut.mutate({ userId: user.userId, role: (e.target.value || null) as AppRole | null })}
                    disabled={roleMut.isPending}
                  >
                    <option value="">未配置</option>
                    {APP_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                  </NativeSelect>
                </td>
                <td className="px-4 py-3">
                  <Switch
                    checked={user.potentialEnabled}
                    onCheckedChange={(value) => toggleMut.mutate({ userId: user.userId, potentialEnabled: value })}
                    disabled={toggleMut.isPending}
                  />
                </td>
                <td className="px-4 py-3">
                  <Button
                    size="sm"
                    variant={user.status === "active" ? "outline" : "ghost"}
                    disabled={busyId === user.userId}
                    onClick={() => {
                      setBusyId(user.userId);
                      updateAppUser({ data: { userId: user.userId, status: user.status === "active" ? "disabled" : "active" } })
                        .then(() => qc.invalidateQueries({ queryKey: ["app-users"] }))
                        .catch((err: Error) => toast.error(err.message))
                        .finally(() => setBusyId(null));
                    }}
                  >
                    {user.status === "active" ? "启用中" : "已停用"}
                  </Button>
                </td>
                <td className="px-4 py-3">
                  <Button size="sm" variant="ghost" onClick={() => checkMut.mutate(user.userId)} disabled={checkMut.isPending}>
                    检查权限
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.data?.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无已登录用户。</p>}
      {legacyQ.data && legacyQ.data.length > 0 && (
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <h2 className="text-sm font-medium">旧潜力型号归属</h2>
          <p className="mt-1 text-xs text-muted-foreground">旧版全局 watchlist 不自动猜测归属；由老板逐条明确分配后才进入用户潜力池。</p>
          <div className="mt-3 space-y-2">
            {legacyQ.data.map((item) => (
              <LegacyPotentialAssignment
                key={item.partId}
                item={item}
                users={q.data ?? []}
                busy={assignMut.isPending}
                onAssign={(userId) => assignMut.mutate({ partId: item.partId, userId })}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function LegacyPotentialAssignment({
  item,
  users,
  busy,
  onAssign,
}: {
  item: { partId: string; mpn: string; note: string | null; assignedUsers: number };
  users: AppUserRow[];
  busy: boolean;
  onAssign: (userId: string) => void;
}) {
  const [userId, setUserId] = useState("");
  const targets = users.filter((user) => user.status === "active" && user.role);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="font-mono text-sm break-all">{item.mpn}</div>
        <div className="text-xs text-muted-foreground">{item.note || "无备注"} · 已分配 {item.assignedUsers} 人</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <NativeSelect className="h-9 w-36" value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">选择用户</option>
          {targets.map((user) => <option key={user.userId} value={user.userId}>{user.displayName} · {user.role}</option>)}
        </NativeSelect>
        <Button size="sm" disabled={!userId || busy} onClick={() => onAssign(userId)}>明确分配</Button>
      </div>
    </div>
  );
}
