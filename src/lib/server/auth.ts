import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { auth } from "@/lib/auth/server";
import {
  APP_ROLES,
  type AppRole,
  requirePrincipal,
  requireRealBoss,
  requireRole,
  sessionKeyForRequest,
  ForbiddenError,
} from "@/lib/auth/authorization.server";
import {
  BOSS_REQUIRED_PERMISSIONS,
  BOSS_ONLY_PERMISSIONS,
  PERMISSION_GROUP_KEYS,
  PERMISSION_GROUP_LABELS,
  PERMISSION_GROUP_TO_ROLE,
  type Permission,
  type PermissionGroupKey,
  permissionGroupKeyForRole,
  permissionGroupNameForRole,
  permissionsFromGroupRow,
  isAppRole,
  isPermission,
} from "@/lib/auth/roles";
import { getSql } from "@/lib/db";

export type AppUserRow = {
  userId: string;
  email: string;
  displayName: string;
  role: AppRole | null;
  permissionGroupKey: PermissionGroupKey | null;
  permissionGroupName: string | null;
  status: "active" | "disabled";
  createdAt: string;
};

export type PermissionGroupRow = {
  key: (typeof PERMISSION_GROUP_KEYS)[number];
  name: string;
  permissions: Permission[];
  memberCount: number;
};

export type LegacyPotentialRow = {
  partId: string;
  mpn: string;
  note: string | null;
  addedAt: string;
  assignedUsers: number;
};

type UserStatus = "active" | "disabled";

export type CreateAppUserInput = {
  name: string;
  email: string;
  password: string;
  passwordConfirmation: string;
  role: AppRole;
  status: UserStatus;
};

export type UpdateAppUserInput = {
  userId: string;
  name?: string;
  email?: string;
  role?: AppRole | null;
  status?: UserStatus;
};

export type SetUserPasswordInput = {
  targetUserId: string;
  newPassword: string;
  newPasswordConfirmation: string;
};

export type ChangeOwnPasswordInput = {
  currentPassword: string;
  newPassword: string;
  newPasswordConfirmation: string;
};

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function assertExactKeys(input: object, allowed: readonly string[], message: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(input).some((key) => !allowedSet.has(key))) throw new ForbiddenError(message);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ForbiddenError(`${label}不能为空`);
  return value.trim();
}

function normalizeLogin(value: unknown): string {
  const email = requiredText(value, "登录账号").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ForbiddenError("登录账号格式不正确");
  return email;
}

async function validatePassword(password: unknown, label = "密码"): Promise<string> {
  if (typeof password !== "string") throw new ForbiddenError(`${label}不能为空`);
  const ctx = await auth.$context;
  const min = ctx.password.config.minPasswordLength;
  const max = ctx.password.config.maxPasswordLength;
  if (password.length < min) throw new ForbiddenError(`${label}长度不能少于${min}位`);
  if (password.length > max) throw new ForbiddenError(`${label}长度不能超过${max}位`);
  return password;
}

async function appUserById(sql: Awaited<ReturnType<typeof getSql>>, userId: string): Promise<AppUserRow> {
  const rows = await sql`
    select u."id" as user_id, coalesce(au.email, u."email") as email,
      coalesce(au.display_name, u."name") as display_name,
      au.role, coalesce(au.status, 'active') as status,
      coalesce(au.created_at, u."createdAt") as created_at
    from "user" u left join app_users au on au.user_id = u."id"
    where u."id" = ${userId} limit 1
  `;
  if (!rows[0]) throw new Error("用户不存在");
  return mapUser(rows[0]);
}

async function deleteTargetSessions(userId: string): Promise<void> {
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

async function assertCredentialAccount(userId: string) {
  const ctx = await auth.$context;
  const account = (await ctx.internalAdapter.findAccounts(userId)).find(
    (candidate) => candidate.providerId === "credential" && candidate.password,
  );
  if (!account?.password) throw new ForbiddenError("该用户没有可用的密码登录账号");
  return { ctx, account, password: account.password };
}

function mapUser(row: Record<string, unknown>): AppUserRow {
  return {
    userId: String(row.user_id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: isAppRole(row.role) ? row.role : null,
    permissionGroupKey: isAppRole(row.role) ? permissionGroupKeyForRole(row.role) : null,
    permissionGroupName: isAppRole(row.role) ? permissionGroupNameForRole(row.role) : null,
    status: String(row.status) as "active" | "disabled",
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export const getCurrentAccess = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const principal = await requirePrincipal(context.bearerToken, { allowUnconfigured: true });
    return principal;
  });

export const createAppUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: CreateAppUserInput) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    assertExactKeys(
      data as Record<string, unknown>,
      ["name", "email", "password", "passwordConfirmation", "role", "status"],
      "创建用户参数不合法",
    );
    const name = requiredText(data.name, "姓名");
    const email = normalizeLogin(data.email);
    const password = await validatePassword(data.password);
    if (password !== data.passwordConfirmation) throw new ForbiddenError("两次输入的密码不一致");
    if (!isAppRole(data.role)) throw new ForbiddenError("角色不合法");
    if (data.status !== "active" && data.status !== "disabled") throw new ForbiddenError("状态不合法");

    const ctx = await auth.$context;
    const existing = await ctx.internalAdapter.findUserByEmail(email);
    if (existing) throw new ForbiddenError("登录账号已存在");
    const passwordHash = await ctx.password.hash(password);
    let created: { id: string } | null = null;
    try {
      created = await ctx.internalAdapter.createUser({
        email,
        name,
        image: null,
        emailVerified: false,
      });
      await ctx.internalAdapter.linkAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: passwordHash,
      });
      const sql = await getSql();
      await sql`
        insert into app_users (user_id, email, display_name, role, status)
        values (${created.id}, ${email}, ${name}, ${data.role}, ${data.status})
      `;
      return await appUserById(sql, created.id);
    } catch (error) {
      if (created) await ctx.internalAdapter.deleteUser(created.id).catch(() => undefined);
      if (error instanceof ForbiddenError) throw error;
      throw new ForbiddenError("创建用户失败，请检查登录账号是否已存在");
    }
  });

export const listAppUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    const sql = await getSql();
    const rows = await sql`
      select u."id" as user_id, coalesce(au.email, u."email") as email,
        coalesce(au.display_name, u."name") as display_name,
        au.role,
        coalesce(au.status, 'active') as status, coalesce(au.created_at, u."createdAt") as created_at
      from "user" u left join app_users au on au.user_id = u."id"
      order by coalesce(au.status, 'active') asc, coalesce(au.display_name, u."name") asc, u."email" asc
    `;
    return rows.map(mapUser);
  });

async function updateRoleAndStatus(
  sql: Awaited<ReturnType<typeof getSql>>,
  userId: string,
  role: AppRole | null | undefined,
  status: UserStatus | undefined,
): Promise<void> {
  if (!sql.transaction) throw new Error("当前数据库不支持事务");
  await sql.transaction(async (tx) => {
    // Lock every currently valid boss before counting. This serializes concurrent
    // demotions/disables so the last valid boss cannot disappear between checks.
    await tx`select user_id from app_users where role = '老板' and status = 'active' for update`;
    const current = await tx`select role, status from app_users where user_id = ${userId} for update`;
    if (!current[0]) throw new Error("用户不存在");
    const currentRole = isAppRole(current[0].role) ? current[0].role : null;
    const nextRole = role === undefined ? currentRole : role;
    const nextStatus = status === undefined ? String(current[0].status) : status;
    if (
      currentRole === "老板" &&
      String(current[0].status) === "active" &&
      (nextRole !== "老板" || nextStatus !== "active")
    ) {
      const remaining = await tx`
        select count(*)::int as count from app_users
        where role = '老板' and status = 'active' and user_id <> ${userId}
      `;
      if (Number(remaining[0]?.count ?? 0) < 1) throw new ForbiddenError("系统必须保留至少一名有效老板");
    }
    await tx`
      update app_users
      set role = ${nextRole}, status = ${nextStatus}, updated_at = now()
      where user_id = ${userId}
    `;
    if (nextStatus !== "active") await tx`delete from "session" where "userId" = ${userId}`;
  });
}

export const updateAppUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: UpdateAppUserInput) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    assertExactKeys(data as Record<string, unknown>, ["userId", "name", "email", "role", "status"], "用户参数不合法");
    const userId = requiredText(data.userId, "用户");
    const hasProfile = hasOwn(data, "name") || hasOwn(data, "email");
    const hasRoleStatus = hasOwn(data, "role") || hasOwn(data, "status");
    if (!hasProfile && !hasRoleStatus) throw new ForbiddenError("没有需要保存的用户资料");
    if (userId === principal.actorUserId && hasRoleStatus) {
      throw new ForbiddenError("老板不能在当前会话中修改自己的角色或状态");
    }
    if (hasOwn(data, "role") && data.role !== null && !isAppRole(data.role)) throw new ForbiddenError("角色不合法");
    if (hasOwn(data, "status") && data.status !== "active" && data.status !== "disabled") throw new ForbiddenError("状态不合法");

    const sql = await getSql();
    const identity = await sql`select "id", "email", "name" from "user" where "id" = ${userId} limit 1`;
    if (!identity[0]) throw new Error("用户不存在");
    const name = hasOwn(data, "name") ? requiredText(data.name, "姓名") : String(identity[0].name);
    const email = hasOwn(data, "email") ? normalizeLogin(data.email) : String(identity[0].email).toLowerCase();
    const duplicate = await sql`
      select "id" from "user" where lower(trim("email")) = ${email} and "id" <> ${userId} limit 1
    `;
    if (duplicate[0]) throw new ForbiddenError("登录账号已存在");
    if (hasProfile) {
      const ctx = await auth.$context;
      await ctx.internalAdapter.updateUser(userId, { name, email });
      await sql`
        insert into app_users (user_id, email, display_name)
        values (${userId}, ${email}, ${name})
        on conflict (user_id) do update set email = excluded.email, display_name = excluded.display_name, updated_at = now()
      `;
    }
    if (hasRoleStatus) await updateRoleAndStatus(sql, userId, data.role, data.status);
    return await appUserById(sql, userId);
  });

export const setUserPassword = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: SetUserPasswordInput) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    assertExactKeys(data as Record<string, unknown>, ["targetUserId", "newPassword", "newPasswordConfirmation"], "密码参数不合法");
    const targetUserId = requiredText(data.targetUserId, "目标用户");
    if (targetUserId === principal.actorUserId) throw new ForbiddenError("请使用账户菜单修改自己的密码");
    const password = await validatePassword(data.newPassword, "新密码");
    if (password !== data.newPasswordConfirmation) throw new ForbiddenError("两次输入的新密码不一致");
    const sql = await getSql();
    const target = await sql`select "id" from "user" where "id" = ${targetUserId} limit 1`;
    if (!target[0]) throw new Error("用户不存在");
    const ctx = await auth.$context;
    const passwordHash = await ctx.password.hash(password);
    const account = (await ctx.internalAdapter.findAccounts(targetUserId)).find((candidate) => candidate.providerId === "credential");
    if (account) await ctx.internalAdapter.updateAccount(account.id, { password: passwordHash });
    else await ctx.internalAdapter.linkAccount({ userId: targetUserId, providerId: "credential", accountId: targetUserId, password: passwordHash });
    await deleteTargetSessions(targetUserId);
    return { ok: true as const };
  });

export const changeOwnPassword = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: ChangeOwnPasswordInput) => input)
  .handler(async ({ data, context }) => {
    const principal = await requirePrincipal(context.bearerToken, { allowUnconfigured: true, ignoreIdentityCheck: true });
    assertExactKeys(data as Record<string, unknown>, ["currentPassword", "newPassword", "newPasswordConfirmation"], "密码参数不合法");
    if (typeof data.currentPassword !== "string") throw new ForbiddenError("当前密码不正确");
    const password = await validatePassword(data.newPassword, "新密码");
    if (password !== data.newPasswordConfirmation) throw new ForbiddenError("两次输入的新密码不一致");
    const { ctx, account, password: currentHash } = await assertCredentialAccount(principal.actorUserId);
    const valid = await ctx.password.verify({ hash: currentHash, password: data.currentPassword });
    if (!valid) throw new ForbiddenError("当前密码不正确");
    const passwordHash = await ctx.password.hash(password);
    await ctx.internalAdapter.updateAccount(account.id, { password: passwordHash });
    await deleteTargetSessions(principal.actorUserId);
    return { ok: true as const };
  });

function parsePermissionGroupRow(row: Record<string, unknown>): PermissionGroupRow {
  const role = PERMISSION_GROUP_TO_ROLE[String(row.role_key) as keyof typeof PERMISSION_GROUP_TO_ROLE];
  if (!role) throw new ForbiddenError("权限组配置不可用，请联系系统管理员");
  const permissions = permissionsFromGroupRow(role, row);
  if (!permissions) throw new ForbiddenError("权限组配置不可用，请联系系统管理员");
  return {
    key: permissionGroupKeyForRole(role),
    name: PERMISSION_GROUP_LABELS[permissionGroupKeyForRole(role)],
    permissions,
    memberCount: Number(row.member_count ?? 0),
  };
}

export const listPermissionGroups = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<PermissionGroupRow[]> => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    const sql = await getSql();
    const rows = await sql`
      select pg.role_key, pg.display_name, pg.permissions, count(au.user_id)::int as member_count
      from permission_groups pg
      left join app_users au on au.role = case pg.role_key
        when 'boss' then '老板' when 'inspector' then '最高督察'
        when 'manager' then '主管' when 'follower' then '跟进人' end
      group by pg.role_key, pg.display_name, pg.permissions
      order by case pg.role_key when 'boss' then 1 when 'inspector' then 2 when 'manager' then 3 when 'follower' then 4 end
    `;
    const byKey = new Map(rows.map((row) => [String(row.role_key), row]));
    return PERMISSION_GROUP_KEYS.map((key) => {
      const row = byKey.get(key);
      if (!row) throw new ForbiddenError("权限组配置不可用，请联系系统管理员");
      return parsePermissionGroupRow(row);
    });
  });

export const updatePermissionGroup = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { role: AppRole; permissions: Permission[] }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    const incoming = data as Record<string, unknown>;
    const groupUpdateKeys = new Set(["role", "permissions"]);
    if (Object.keys(incoming).some((key) => !groupUpdateKeys.has(key))) {
      throw new ForbiddenError("权限组只能按固定角色设置");
    }
    if (!isAppRole(data.role) || !Array.isArray(data.permissions)) {
      throw new ForbiddenError("权限组设置无效");
    }
    const permissions = data.permissions.filter((value): value is Permission => isPermission(value));
    if (permissions.length !== data.permissions.length || new Set(permissions).size !== permissions.length) {
      throw new ForbiddenError("权限组设置包含无效权限");
    }
    if (data.role !== "老板" && BOSS_ONLY_PERMISSIONS.some((permission) => permissions.includes(permission))) {
      throw new ForbiddenError("管理系统设置只能属于老板权限组");
    }
    if (data.role === "老板" && BOSS_REQUIRED_PERMISSIONS.some((permission) => !permissions.includes(permission))) {
      throw new ForbiddenError("老板权限组必须保留核心管理权限");
    }
    const sql = await getSql();
    const key = permissionGroupKeyForRole(data.role);
    const result = await sql.query(
      "update permission_groups set permissions = $1::text[], updated_at = now() where role_key = $2 returning role_key, display_name, permissions",
      [permissions, key],
    );
    if (result.length !== 1) throw new ForbiddenError("固定权限组不存在，已拒绝保存");
    if (!permissionsFromGroupRow(data.role, result[0])) throw new ForbiddenError("保存后的权限组校验失败");
    return { ok: true as const, role: data.role, permissions };
  });

export const startIdentityCheck = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { targetUserId: string }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "identity.check");
    const sql = await getSql();
    const target = await sql`select user_id from app_users where user_id = ${data.targetUserId} and status = 'active' limit 1`;
    if (!target[0]) throw new Error("目标用户不存在或已停用");
    const key = sessionKeyForRequest(context.bearerToken);
    if (!sql.transaction) throw new Error("当前数据库不支持事务");
    await sql.transaction(async (tx) => {
      await tx`delete from identity_checks where session_key = ${key}`;
      await tx`
        insert into identity_checks (session_key, actor_user_id, target_user_id)
        values (${key}, ${principal.actorUserId}, ${data.targetUserId})
      `;
    });
    return { ok: true as const };
  });

/** Legacy global watchlist rows stay untouched until the boss assigns them. */
export const listLegacyPotential = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<LegacyPotentialRow[]> => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    const sql = await getSql();
    const rows = await sql`
      select w.part_id, p.mpn, w.note, w.added_at,
        count(distinct pm.user_id)::int as assigned_users
      from watchlist w
      join parts p on p.id = w.part_id
      left join potential_models pm on pm.part_id = w.part_id
      group by w.part_id, p.mpn, w.note, w.added_at
      order by w.added_at desc
    `;
    return rows.map((row) => ({
      partId: String(row.part_id),
      mpn: String(row.mpn),
      note: row.note ? String(row.note) : null,
      addedAt: new Date(String(row.added_at)).toISOString(),
      assignedUsers: Number(row.assigned_users ?? 0),
    }));
  });

export const assignLegacyPotential = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { partId: string; userId: string; note?: string | null }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    const sql = await getSql();
    const target = await sql`
      select au.user_id, au.role, au.status
      from app_users au where au.user_id = ${data.userId} limit 1
    `;
    if (!target[0] || String(target[0].status) !== "active" || !APP_ROLES.includes(target[0].role as AppRole)) {
      throw new ForbiddenError("目标用户没有可用业务角色");
    }
    const legacy = await sql`select part_id, note from watchlist where part_id = ${data.partId} limit 1`;
    if (!legacy[0]) throw new Error("旧潜力型号不存在");
    await sql`
      insert into potential_models (user_id, part_id, note)
      values (${data.userId}, ${data.partId}, ${data.note ?? legacy[0].note ?? null})
      on conflict (user_id, part_id) do update set note = excluded.note
    `;
    return { ok: true as const };
  });

export const exitIdentityCheck = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "identity.check");
    const sql = await getSql();
    await sql`delete from identity_checks where session_key = ${sessionKeyForRequest(context.bearerToken)}`;
    return { ok: true as const };
  });
