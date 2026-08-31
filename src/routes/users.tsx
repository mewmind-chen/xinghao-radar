import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  assignLegacyPotential,
  listAppUsers,
  listLegacyPotential,
  listPermissionGroups,
  startIdentityCheck,
  updateAppUser,
  updatePermissionGroup,
  type AppUserRow,
  type PermissionGroupRow,
} from "@/lib/server/auth";
import {
  APP_ROLES,
  BOSS_REQUIRED_PERMISSIONS,
  PERMISSION_GROUP_KEYS,
  PERMISSION_GROUP_LABELS,
  PERMISSION_GROUP_TO_ROLE,
  PERMISSION_LABELS,
  PERMISSION_SECTIONS,
  type AppRole,
  type Permission,
  type PermissionGroupKey,
} from "@/lib/auth/roles";
import { useAppAccess } from "@/lib/auth/use-app-access";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export const Route = createFileRoute("/users")({ component: UsersPage });

function UsersPage() {
  const qc = useQueryClient();
  const access = useAppAccess();
  const q = useQuery({ queryKey: ["app-users"], queryFn: () => listAppUsers() });
  const legacyQ = useQuery({ queryKey: ["legacy-potential"], queryFn: () => listLegacyPotential() });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<PermissionGroupKey>("boss");
  const [draftPermissions, setDraftPermissions] = useState<Permission[]>([]);
  const isBoss = access.access?.role === "老板" && !access.access.isImpersonating;

  const roleMut = useMutation({
    mutationFn: (data: { userId: string; role: AppRole | null }) => updateAppUser({ data }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["app-users"] });
      toast.success("角色已保存");
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const checkMut = useMutation({
    mutationFn: (targetUserId: string) => startIdentityCheck({ data: { targetUserId } }),
    onSuccess: () => {
      toast.success("已进入权限检查");
      window.location.href = "/";
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const assignMut = useMutation({
    mutationFn: (data: { partId: string; userId: string }) => assignLegacyPotential({ data }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["legacy-potential"] });
      toast.success("已明确归属到用户");
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const groupsQ = useQuery({
    queryKey: ["permission-groups"],
    queryFn: () => listPermissionGroups(),
    enabled: groupOpen && isBoss,
  });
  const groupMut = useMutation({
    mutationFn: (data: { role: AppRole; permissions: Permission[] }) => updatePermissionGroup({ data }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["permission-groups"] });
      void qc.invalidateQueries({ queryKey: ["current-access"] });
      toast.success("权限组已保存，同角色用户立即生效");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const selected = groupsQ.data?.find((group) => group.key === selectedGroup);
  useEffect(() => {
    if (selected) setDraftPermissions([...selected.permissions]);
  }, [selected]);

  function togglePermission(permission: Permission, enabled: boolean) {
    setDraftPermissions((current) => {
      if (enabled) return current.includes(permission) ? current : [...current, permission];
      return current.filter((item) => item !== permission);
    });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium">用户与权限</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            用户只分配角色；同一角色的所有人自动使用同一套权限设置。
          </p>
        </div>
        {isBoss && (
          <Button variant={groupOpen ? "default" : "outline"} onClick={() => setGroupOpen((open) => !open)}>
            {groupOpen ? "收起权限组" : "设置权限组"}
          </Button>
        )}
      </div>

      <div className="hidden overflow-hidden rounded-xl bg-card shadow-[var(--shadow-border)] lg:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-normal">用户</th>
              <th className="px-4 py-3 font-normal">角色</th>
              <th className="px-4 py-3 font-normal">状态</th>
              <th className="px-4 py-3 text-right font-normal">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {q.data?.map((user) => (
              <UserDesktopRow
                key={user.userId}
                user={user}
                rolePending={roleMut.isPending}
                busy={busyId === user.userId}
                checking={checkMut.isPending}
                onRole={(role) => roleMut.mutate({ userId: user.userId, role })}
                onToggleStatus={() => toggleStatus(user, setBusyId)}
                onCheck={() => checkMut.mutate(user.userId)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-2 lg:hidden">
        {q.data?.map((user) => (
          <UserMobileCard
            key={user.userId}
            user={user}
            rolePending={roleMut.isPending}
            busy={busyId === user.userId}
            onRole={(role) => roleMut.mutate({ userId: user.userId, role })}
            onToggleStatus={() => toggleStatus(user, setBusyId)}
          />
        ))}
      </div>
      {q.data?.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无已登录用户。</p>}

      {groupOpen && isBoss && (
        <PermissionGroupSettings
          groups={groupsQ.data ?? []}
          selectedGroup={selectedGroup}
          selected={selected}
          draftPermissions={draftPermissions}
          saving={groupMut.isPending}
          onSelect={(key) => setSelectedGroup(key)}
          onToggle={togglePermission}
          onSave={() => groupMut.mutate({ role: PERMISSION_GROUP_TO_ROLE[selectedGroup], permissions: draftPermissions })}
        />
      )}

      {legacyQ.data && legacyQ.data.length > 0 && (
        <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
          <h2 className="text-sm font-medium">历史潜力型号归属</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            这些型号尚未明确归属，系统不会自动猜测；由老板逐条分配后才进入对应用户的潜力型号列表。
          </p>
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

  function toggleStatus(user: AppUserRow, setBusy: (id: string | null) => void) {
    setBusy(user.userId);
    updateAppUser({ data: { userId: user.userId, status: user.status === "active" ? "disabled" : "active" } })
      .then(() => qc.invalidateQueries({ queryKey: ["app-users"] }))
      .catch((err: Error) => toast.error(err.message))
      .finally(() => setBusy(null));
  }
}

function UserRole({ user, pending, onRole }: { user: AppUserRow; pending: boolean; onRole: (role: AppRole | null) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <NativeSelect
        className="h-9 w-32"
        value={user.role ?? ""}
        onChange={(e) => onRole((e.target.value || null) as AppRole | null)}
        disabled={pending}
        aria-label={`${user.displayName}角色`}
      >
        <option value="">未配置</option>
        {APP_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
      </NativeSelect>
      {user.role && <span className="text-xs text-muted-foreground">套用：{user.permissionGroupName}</span>}
    </div>
  );
}

function StatusButton({ user, busy, onToggle }: { user: AppUserRow; busy: boolean; onToggle: () => void }) {
  return (
    <Button size="sm" variant={user.status === "active" ? "outline" : "ghost"} disabled={busy} onClick={onToggle}>
      {busy ? "保存中…" : user.status === "active" ? "启用中" : "已停用"}
    </Button>
  );
}

function UserDesktopRow({
  user,
  rolePending,
  busy,
  checking,
  onRole,
  onToggleStatus,
  onCheck,
}: {
  user: AppUserRow;
  rolePending: boolean;
  busy: boolean;
  checking: boolean;
  onRole: (role: AppRole | null) => void;
  onToggleStatus: () => void;
  onCheck: () => void;
}) {
  return (
    <tr>
      <td className="px-4 py-3">
        <div>{user.displayName}</div>
        <div className="font-mono text-xs text-muted-foreground">{user.email}</div>
      </td>
      <td className="px-4 py-3"><UserRole user={user} pending={rolePending} onRole={onRole} /></td>
      <td className="px-4 py-3"><StatusButton user={user} busy={busy} onToggle={onToggleStatus} /></td>
      <td className="px-4 py-3 text-right">
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCheck} disabled={checking}>检查权限</Button>
        </div>
      </td>
    </tr>
  );
}

function UserMobileCard({
  user,
  rolePending,
  busy,
  onRole,
  onToggleStatus,
}: {
  user: AppUserRow;
  rolePending: boolean;
  busy: boolean;
  onRole: (role: AppRole | null) => void;
  onToggleStatus: () => void;
}) {
  return (
    <article className="rounded-xl bg-card p-3 shadow-[var(--shadow-border)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{user.displayName}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{user.email}</div>
        </div>
        <StatusButton user={user} busy={busy} onToggle={onToggleStatus} />
      </div>
      <div className="mt-3"><UserRole user={user} pending={rolePending} onRole={onRole} /></div>
    </article>
  );
}

function permissionLabel(permission: Permission, role: AppRole): string {
  if (permission === "potential.read") return role === "跟进人" ? "查看自己的潜力型号" : "查看所有人的潜力型号";
  if (permission === "potential.write") return role === "跟进人" ? "管理自己的潜力型号" : "管理所有人的潜力型号";
  return PERMISSION_LABELS[permission];
}

function PermissionGroupSettings({
  groups,
  selectedGroup,
  selected,
  draftPermissions,
  saving,
  onSelect,
  onToggle,
  onSave,
}: {
  groups: PermissionGroupRow[];
  selectedGroup: PermissionGroupKey;
  selected: PermissionGroupRow | undefined;
  draftPermissions: Permission[];
  saving: boolean;
  onSelect: (key: PermissionGroupKey) => void;
  onToggle: (permission: Permission, enabled: boolean) => void;
  onSave: () => void;
}) {
  const role = PERMISSION_GROUP_TO_ROLE[selectedGroup];
  const memberCount = selected?.memberCount ?? 0;
  return (
    <section className="rounded-xl bg-card p-4 shadow-[var(--shadow-border)]">
      <div>
        <h2 className="text-base font-medium">设置权限组</h2>
        <p className="mt-1 text-xs text-muted-foreground">权限按角色统一生效；修改后，该角色下的所有用户都会同步更新。</p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {PERMISSION_GROUP_KEYS.map((key) => {
          const group = groups.find((item) => item.key === key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${selectedGroup === key ? "border-primary bg-primary/10" : "border-border hover:bg-secondary/60"}`}
            >
              <div className="font-medium">{PERMISSION_GROUP_LABELS[key]}</div>
              <div className="mt-1 text-xs text-muted-foreground">{group?.memberCount ?? 0} 名用户</div>
            </button>
          );
        })}
      </div>
      {selected ? (
        <div className="mt-4 space-y-4">
          {PERMISSION_SECTIONS.map((section) => (
            <div key={section.label}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">{section.label}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {section.permissions.map((permission) => {
                  const locked = (role === "老板" && BOSS_REQUIRED_PERMISSIONS.includes(permission))
                    || (role !== "老板" && permission === "settings.manage");
                  return (
                    <label key={permission} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                      <span>{permissionLabel(permission, role)}</span>
                      <Switch
                        checked={draftPermissions.includes(permission)}
                        disabled={locked || saving}
                        onCheckedChange={(value) => onToggle(permission, value)}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">保存后将影响 {memberCount} 名{role}。</p>
            <Button onClick={onSave} disabled={saving}>{saving ? "保存中…" : "保存权限组"}</Button>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">正在读取权限组设置…</p>
      )}
    </section>
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
        <div className="break-all font-mono text-sm">{item.mpn}</div>
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
