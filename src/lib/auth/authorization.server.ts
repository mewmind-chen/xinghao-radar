import { createHash } from "node:crypto";
import { getRequest } from "@tanstack/react-start/server";
import { getSql, type Sql } from "@/lib/db";
import { realAuthEnabled, readSessionToken } from "./server";
import { DEV_USER_ID, getSessionUser, UnauthorizedError } from "./verify.server";
import { APP_ROLES, type AppRole, type Permission, roleHasPermission } from "./roles";

export { APP_ROLES } from "./roles";
export type { AppRole, Permission } from "./roles";
export type UserStatus = "active" | "disabled";

export const ROLE_LABELS: Record<AppRole, string> = {
  老板: "老板",
  最高督察: "最高督察",
  主管: "主管",
  跟进人: "跟进人",
};

export type AppPrincipal = {
  userId: string;
  actorUserId: string;
  email: string;
  displayName: string;
  role: AppRole | null;
  status: UserStatus;
  potentialEnabled: boolean;
  isImpersonating: boolean;
  sessionKey: string;
};

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

function sessionKeyFor(bearerToken?: string): string {
  const raw = bearerToken || readSessionToken();
  if (raw) return createHash("sha256").update(raw).digest("hex");
  const request = getRequest();
  const authorization = request?.headers.get("authorization") ?? "";
  if (authorization) return createHash("sha256").update(authorization).digest("hex");
  return "anonymous-session";
}

function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value || undefined;
}

async function ensureAppUser(
  sql: Sql,
  identity: { id: string; email: string | null },
): Promise<void> {
  const email = identity.email?.trim().toLowerCase() || `${identity.id}@local.invalid`;
  await sql`
    insert into app_users (user_id, email, display_name)
    select ${identity.id}, ${email}, coalesce(nullif("name", ''), ${email})
    from "user" where "id" = ${identity.id}
    on conflict (user_id) do update set email = excluded.email, updated_at = now()
  `;

  // A boss is never guessed from the first login.  Optional bootstrap is only
  // activated when the operator explicitly names the local account.
  const configuredBoss = env("AUTH_INITIAL_BOSS_EMAIL")?.toLowerCase();
  if (!configuredBoss || configuredBoss !== email) return;
  const boss = await sql`select user_id from app_users where role = '老板' limit 1`;
  if (boss.length === 0) {
    await sql`update app_users set role = '老板', updated_at = now() where user_id = ${identity.id}`;
  }
}

export async function requirePrincipal(
  bearerToken?: string,
  options: { allowUnconfigured?: boolean; ignoreIdentityCheck?: boolean } = {},
): Promise<AppPrincipal> {
  const identity = realAuthEnabled
    ? await getSessionUser(bearerToken)
    : { id: DEV_USER_ID, email: "dev@example.com" };
  if (!identity) throw new UnauthorizedError();
  const sql = await getSql();
  await ensureAppUser(sql, identity);
  const key = sessionKeyFor(bearerToken);
  const rows = await sql`
    select au.*, ic.target_user_id as checked_user_id
    from app_users au
    left join identity_checks ic on ic.session_key = ${key} and ic.actor_user_id = ${identity.id}
    where au.user_id = ${identity.id}
    limit 1
  `;
  const own = rows[0];
  if (!own || String(own.status) !== "active") throw new ForbiddenError("账号已停用");
  if (!options.allowUnconfigured && !isAppRole(own.role)) {
    throw new ForbiddenError("账号尚未配置业务角色");
  }
  const targetId = options.ignoreIdentityCheck
    ? identity.id
    : own.checked_user_id
      ? String(own.checked_user_id)
      : identity.id;
  let effective = own;
  if (targetId !== identity.id) {
    const target = await sql`select * from app_users where user_id = ${targetId} limit 1`;
    if (!target[0] || String(target[0].status) !== "active") throw new ForbiddenError("被检查账号已停用");
    effective = target[0];
  }
  return {
    userId: targetId,
    actorUserId: identity.id,
    email: String(effective.email),
    displayName: String(effective.display_name),
    role: isAppRole(effective.role) ? effective.role : null,
    status: String(effective.status) as UserStatus,
    potentialEnabled: Boolean(effective.potential_enabled),
    isImpersonating: targetId !== identity.id,
    sessionKey: key,
  };
}

export function requireRole(principal: AppPrincipal, permission: Permission): AppPrincipal {
  if (!principal.role || !roleHasPermission(principal.role, permission)) {
    throw new ForbiddenError(`无权执行：${permission}`);
  }
  return principal;
}

export function requirePotential(principal: AppPrincipal, permission: "potential.read" | "potential.write"): AppPrincipal {
  requireRole(principal, permission);
  if (!principal.potentialEnabled) {
    throw new ForbiddenError("潜力型号权限未开启");
  }
  return principal;
}

export function potentialScopeFor(principal: AppPrincipal): "all" | "own" | "none" {
  if (!principal.potentialEnabled) return "none";
  return principal.role === "跟进人" ? "own" : "all";
}

export function requireRealBoss(principal: AppPrincipal): AppPrincipal {
  if (principal.isImpersonating || principal.actorUserId !== principal.userId || principal.role !== "老板") {
    throw new ForbiddenError("只有真实老板可以执行此操作");
  }
  return principal;
}

export function sessionKeyForRequest(bearerToken?: string): string {
  return sessionKeyFor(bearerToken);
}

export async function getCurrentPrincipal(bearerToken?: string): Promise<AppPrincipal> {
  return requirePrincipal(bearerToken);
}

export function requireImportKind(principal: AppPrincipal, kind: string): AppPrincipal {
  if (kind === "stock" || kind === "transit") return requireRole(principal, "inventory.import");
  if (kind === "offer" || kind === "inquiry") return requireRole(principal, "market.write");
  if (kind === "mixed") {
    if (roleHasPermission(principal.role, "inventory.import") || roleHasPermission(principal.role, "market.write")) {
      return principal;
    }
  }
  throw new ForbiddenError("无权导入该类型数据");
}
