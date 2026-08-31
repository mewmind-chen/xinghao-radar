import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  assignLegacyPotential,
  createAppUser,
  listAppUsers,
  listLegacyPotential,
  listPermissionGroups,
  setUserPassword,
  startIdentityCheck,
  updateAppUser,
  updatePermissionGroup,
  type AppUserRow,
  type CreateAppUserInput,
  type PermissionGroupRow,
  type SetUserPasswordInput,
  type UpdateAppUserInput,
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export const Route = createFileRoute("/users")({ component: UsersPage });

function UsersPage() {
  const qc = useQueryClient();
  const access = useAppAccess();
  const q = useQuery({ queryKey: ["app-users"], queryFn: () => listAppUsers() });
  const legacyQ = useQuery({ queryKey: ["legacy-potential"], queryFn: () => listLegacyPotential() });
  const [createOpen, setCreateOpen] = useState(false);
  const [manageUser, setManageUser] = useState<AppUserRow | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<PermissionGroupKey>("boss");
  const [draftPermissions, setDraftPermissions] = useState<Permission[]>([]);
  const isBoss = access.access?.role === "老板" && !access.access.isImpersonating;

  const createMut = useMutation({
    mutationFn: (data: CreateAppUserInput) => createAppUser({ data }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["app-users"] });
      setCreateOpen(false);
      toast.success("用户已创建");
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const updateMut = useMutation({
    mutationFn: (data: UpdateAppUserInput) => updateAppUser({ data }),
    onSuccess: (user) => {
      void qc.invalidateQueries({ queryKey: ["app-users"] });
      setManageUser(user);
      toast.success("用户资料已保存");
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const passwordMut = useMutation({
    mutationFn: (data: SetUserPasswordInput) => setUserPassword({ data }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["app-users"] });
      toast.success("密码已修改，旧会话已失效");
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
        {isBoss && <div className="flex flex-wrap gap-2">
          <Button onClick={() => setCreateOpen(true)}>新建用户</Button>
          <Button variant={groupOpen ? "default" : "outline"} onClick={() => setGroupOpen((open) => !open)}>
            {groupOpen ? "收起权限组" : "设置权限组"}
          </Button>
        </div>}
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
                isCurrent={user.userId === access.access?.actorUserId}
                checking={checkMut.isPending}
                onManage={() => setManageUser(user)}
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
            isCurrent={user.userId === access.access?.actorUserId}
            onManage={() => setManageUser(user)}
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
      {isBoss && (
        <UserCreateDialog open={createOpen} saving={createMut.isPending} onOpenChange={setCreateOpen} onSubmit={(data) => createMut.mutate(data)} />
      )}
      {isBoss && manageUser && (
        <UserManagementDialog
          user={manageUser}
          isCurrent={manageUser.userId === access.access?.actorUserId}
          saving={updateMut.isPending}
          passwordSaving={passwordMut.isPending}
          onOpenChange={(open) => { if (!open) setManageUser(null); }}
          onSave={(data) => updateMut.mutate(data)}
          onPassword={(data) => passwordMut.mutate(data)}
          onCheck={() => checkMut.mutate(manageUser.userId)}
          checking={checkMut.isPending}
        />
      )}
    </div>
  );
}

function UserRole({ user }: { user: AppUserRow }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span>{user.role ?? "未配置"}</span>
      {user.role && <span className="text-xs text-muted-foreground">套用：{user.permissionGroupName}</span>}
    </div>
  );
}

function StatusBadge({ status }: { status: AppUserRow["status"] }) {
  return <span className={status === "active" ? "text-emerald-700" : "text-muted-foreground"}>{status === "active" ? "启用" : "已停用"}</span>;
}

function UserDesktopRow({
  user,
  isCurrent,
  checking,
  onManage,
  onCheck,
}: {
  user: AppUserRow;
  isCurrent: boolean;
  checking: boolean;
  onManage: () => void;
  onCheck: () => void;
}) {
  return (
    <tr>
      <td className="px-4 py-3">
        <div>{user.displayName}</div>
        <div className="font-mono text-xs text-muted-foreground">{user.email}</div>
      </td>
      <td className="px-4 py-3"><UserRole user={user} /></td>
      <td className="px-4 py-3"><StatusBadge status={user.status} /></td>
      <td className="px-4 py-3 text-right">
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onManage}>管理</Button>
          {!isCurrent && <Button size="sm" variant="ghost" onClick={onCheck} disabled={checking}>检查权限</Button>}
        </div>
      </td>
    </tr>
  );
}

function UserMobileCard({
  user,
  isCurrent,
  onManage,
}: {
  user: AppUserRow;
  isCurrent: boolean;
  onManage: () => void;
}) {
  return (
    <article className="rounded-xl bg-card p-3 shadow-[var(--shadow-border)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{user.displayName}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{user.email}</div>
        </div>
        <StatusBadge status={user.status} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <UserRole user={user} />
        <Button size="sm" variant="outline" onClick={onManage}>管理{isCurrent ? "（本人）" : ""}</Button>
      </div>
  </article>
  );
}

function UserCreateDialog({
  open,
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: CreateAppUserInput) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [role, setRole] = useState<AppRole>("跟进人");
  const [status, setStatus] = useState<"active" | "disabled">("active");

  useEffect(() => {
    if (!open) {
      setName("");
      setEmail("");
      setPassword("");
      setConfirmation("");
      setRole("跟进人");
      setStatus("active");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建用户</DialogTitle>
          <DialogDescription>直接设置正式登录密码和角色；不会生成临时密码，也不会要求首次登录修改。</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({ name, email, password, passwordConfirmation: confirmation, role, status });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label htmlFor="new-user-name">姓名</Label><Input id="new-user-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></div>
            <div><Label htmlFor="new-user-email">登录账号</Label><Input id="new-user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></div>
            <div><Label htmlFor="new-user-password">密码</Label><Input id="new-user-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></div>
            <div><Label htmlFor="new-user-confirm">确认密码</Label><Input id="new-user-confirm" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} required /></div>
            <div><Label htmlFor="new-user-role">角色</Label><NativeSelect id="new-user-role" value={role} onChange={(event) => setRole(event.target.value as AppRole)} required>{APP_ROLES.map((item) => <option key={item} value={item}>{item}</option>)}</NativeSelect></div>
            <div><Label htmlFor="new-user-status">状态</Label><NativeSelect id="new-user-status" value={status} onChange={(event) => setStatus(event.target.value as "active" | "disabled")}><option value="active">启用</option><option value="disabled">停用</option></NativeSelect></div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={saving}>{saving ? "创建中…" : "创建用户"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UserManagementDialog({
  user,
  isCurrent,
  saving,
  passwordSaving,
  onOpenChange,
  onSave,
  onPassword,
  onCheck,
  checking,
}: {
  user: AppUserRow;
  isCurrent: boolean;
  saving: boolean;
  passwordSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: UpdateAppUserInput) => void;
  onPassword: (data: SetUserPasswordInput) => void;
  onCheck: () => void;
  checking: boolean;
}) {
  const [mode, setMode] = useState<"profile" | "password">("profile");
  const [name, setName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<AppRole | "">(user.role ?? "");
  const [status, setStatus] = useState(user.status);
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    setMode("profile");
    setName(user.displayName);
    setEmail(user.email);
    setRole(user.role ?? "");
    setStatus(user.status);
    setNewPassword("");
    setConfirmation("");
  }, [user]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>管理用户</DialogTitle>
          <DialogDescription>{user.displayName} · {user.email}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2 border-b border-border pb-3">
          <Button type="button" size="sm" variant={mode === "profile" ? "default" : "outline"} onClick={() => setMode("profile")}>编辑资料</Button>
          {!isCurrent && <Button type="button" size="sm" variant={mode === "password" ? "default" : "outline"} onClick={() => { setMode("password"); setNewPassword(""); setConfirmation(""); }}>修改密码</Button>}
          {!isCurrent && <Button type="button" size="sm" variant="ghost" className="hidden md:inline-flex" onClick={onCheck} disabled={checking}>{checking ? "检查中…" : "检查权限"}</Button>}
        </div>
        {mode === "profile" ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data: UpdateAppUserInput = { userId: user.userId, name, email };
              if (!isCurrent) {
                data.role = role || null;
                data.status = status;
              }
              onSave(data);
            }}
          >
            <div><Label htmlFor="manage-user-name">姓名</Label><Input id="manage-user-name" value={name} onChange={(event) => setName(event.target.value)} required /></div>
            <div><Label htmlFor="manage-user-email">登录账号</Label><Input id="manage-user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="manage-user-role">角色</Label>
                <NativeSelect id="manage-user-role" value={role} disabled={isCurrent} onChange={(event) => setRole(event.target.value as AppRole | "")}>
                  <option value="">未配置</option>
                  {APP_ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="manage-user-status">状态</Label>
                <NativeSelect id="manage-user-status" value={status} disabled={isCurrent} onChange={(event) => setStatus(event.target.value as "active" | "disabled")}>
                  <option value="active">启用</option><option value="disabled">停用</option>
                </NativeSelect>
              </div>
            </div>
            <div className="rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
              权限组由角色固定映射：{user.permissionGroupName ?? "未配置权限组"}。不能为单个用户选择权限组或添加权限例外。
              {isCurrent && <span className="ml-1">当前会话不能修改自己的角色或状态。</span>}
            </div>
            <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button><Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存资料"}</Button></div>
          </form>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              onPassword({ targetUserId: user.userId, newPassword, newPasswordConfirmation: confirmation });
              setNewPassword("");
              setConfirmation("");
            }}
          >
            <p className="text-sm text-muted-foreground">为其他用户设置新密码。保存后旧密码和旧会话立即失效，不会触发首次登录修改。</p>
            <div><Label htmlFor="manage-user-new-password">新密码</Label><Input id="manage-user-new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} required /></div>
            <div><Label htmlFor="manage-user-confirm-password">确认新密码</Label><Input id="manage-user-confirm-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} required /></div>
            <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button><Button type="submit" disabled={passwordSaving}>{passwordSaving ? "保存中…" : "保存新密码"}</Button></div>
          </form>
        )}
      </DialogContent>
    </Dialog>
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
