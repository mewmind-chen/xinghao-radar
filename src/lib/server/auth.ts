import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
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

export const updateAppUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { userId: string; role?: AppRole | null; status?: "active" | "disabled" }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRealBoss(await requirePrincipal(context.bearerToken, { ignoreIdentityCheck: true }));
    requireRole(principal, "users.manage");
    const incoming = data as Record<string, unknown>;
    const userUpdateKeys = new Set(["userId", "role", "status"]);
    if (Object.keys(incoming).some((key) => !userUpdateKeys.has(key))) {
      throw new ForbiddenError("用户只能分配角色和状态");
    }
    if (data.role !== undefined && data.role !== null && !APP_ROLES.includes(data.role)) {
      throw new ForbiddenError("角色不合法");
    }
    if (data.userId === principal.actorUserId && data.status === "disabled") {
      throw new ForbiddenError("不能停用当前老板账号");
    }
    const sql = await getSql();
    const identity = await sql`select "id", "email", "name" from "user" where "id" = ${data.userId} limit 1`;
    if (!identity[0]) throw new Error("用户不存在");
    await sql`
      insert into app_users (user_id, email, display_name)
      values (${data.userId}, ${String(identity[0].email).toLowerCase()}, ${String(identity[0].name)})
      on conflict (user_id) do nothing
    `;
    if (data.role !== undefined) {
      await sql`update app_users set role = ${data.role}, updated_at = now() where user_id = ${data.userId}`;
    }
    if (data.status !== undefined) {
      await sql`update app_users set status = ${data.status}, updated_at = now() where user_id = ${data.userId}`;
    }
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
