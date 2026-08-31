export const APP_ROLES = ["老板", "最高督察", "主管", "跟进人"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const PERMISSION_GROUP_KEYS = ["boss", "inspector", "manager", "follower"] as const;
export type PermissionGroupKey = (typeof PERMISSION_GROUP_KEYS)[number];

export type Permission =
  | "model.read" | "model.write" | "stock.read" | "stock.write" | "inventory.import"
  | "market.read" | "market.write" | "potential.read" | "potential.write"
  | "settings.manage" | "users.manage" | "identity.check"
  | "logs.read" | "analysis.read" | "analysis.write";

export const ALL_PERMISSIONS = [
  "model.read", "model.write", "stock.read", "stock.write", "inventory.import",
  "market.read", "market.write", "potential.read", "potential.write",
  "settings.manage", "users.manage", "identity.check",
  "logs.read", "analysis.read", "analysis.write",
] as const satisfies readonly Permission[];

export const ROLE_TO_PERMISSION_GROUP: Record<AppRole, PermissionGroupKey> = {
  老板: "boss",
  最高督察: "inspector",
  主管: "manager",
  跟进人: "follower",
};

export const PERMISSION_GROUP_TO_ROLE: Record<PermissionGroupKey, AppRole> = {
  boss: "老板",
  inspector: "最高督察",
  manager: "主管",
  follower: "跟进人",
};

export const PERMISSION_GROUP_LABELS: Record<PermissionGroupKey, string> = {
  boss: "老板权限组",
  inspector: "最高督察权限组",
  manager: "主管权限组",
  follower: "跟进人权限组",
};

export const ROLE_LABELS: Record<AppRole, string> = {
  老板: "老板",
  最高督察: "最高督察",
  主管: "主管",
  跟进人: "跟进人",
};

/** 默认模板只负责初始化新库；运行时授权必须读取数据库中的权限组。 */
export const DEFAULT_PERMISSION_GROUPS: Record<PermissionGroupKey, readonly Permission[]> = {
  boss: [
    "model.read", "model.write", "stock.read", "stock.write", "inventory.import",
    "market.read", "market.write", "potential.read", "potential.write", "settings.manage",
    "users.manage", "identity.check", "logs.read", "analysis.read", "analysis.write",
  ],
  inspector: ["model.read", "stock.read", "market.read", "potential.read", "potential.write", "analysis.read"],
  manager: ["model.read", "stock.read", "market.read", "market.write", "potential.read", "potential.write", "analysis.read"],
  follower: ["model.read", "stock.read", "stock.write", "inventory.import", "analysis.read"],
};

export const PERMISSION_SECTIONS: ReadonlyArray<{
  label: string;
  permissions: readonly Permission[];
}> = [
  { label: "型号", permissions: ["model.read", "model.write", "analysis.read", "analysis.write"] },
  { label: "库存", permissions: ["stock.read", "stock.write", "inventory.import"] },
  { label: "渠道与询价", permissions: ["market.read", "market.write"] },
  { label: "潜力型号", permissions: ["potential.read", "potential.write"] },
  { label: "系统", permissions: ["settings.manage", "users.manage", "identity.check", "logs.read"] },
];

export const PERMISSION_LABELS: Record<Permission, string> = {
  "model.read": "查看型号",
  "model.write": "修正型号主档",
  "analysis.read": "查看型号分析",
  "analysis.write": "执行型号分析",
  "stock.read": "查看库存和成本",
  "stock.write": "入库、出库、调拨和修正",
  "inventory.import": "库存批量导入",
  "market.read": "查看渠道推货和客户询价",
  "market.write": "管理渠道推货和客户询价（含导入）",
  "potential.read": "查看潜力型号",
  "potential.write": "管理潜力型号",
  "settings.manage": "管理系统设置",
  "users.manage": "管理用户",
  "identity.check": "身份检查",
  "logs.read": "查看操作记录",
};

export const BOSS_REQUIRED_PERMISSIONS: readonly Permission[] = [
  "model.read", "model.write", "stock.read", "stock.write", "inventory.import",
  "market.read", "market.write", "potential.read", "potential.write", "settings.manage",
  "users.manage", "identity.check", "analysis.read", "analysis.write",
];

/** 这些能力不能被授予固定老板组之外的角色。 */
export const BOSS_ONLY_PERMISSIONS: readonly Permission[] = ["settings.manage"];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export function permissionGroupKeyForRole(role: AppRole): PermissionGroupKey {
  return ROLE_TO_PERMISSION_GROUP[role];
}

export function permissionGroupNameForRole(role: AppRole | null): string | null {
  return role ? PERMISSION_GROUP_LABELS[permissionGroupKeyForRole(role)] : null;
}

/** 将数据库行转换为有效权限；缺失、改名、非法权限和重复项全部拒绝。 */
export function permissionsFromGroupRow(
  role: AppRole,
  row: { role_key?: unknown; display_name?: unknown; permissions?: unknown } | undefined,
): Permission[] | null {
  const key = permissionGroupKeyForRole(role);
  if (!row || row.role_key !== key || row.display_name !== PERMISSION_GROUP_LABELS[key]) return null;
  if (!Array.isArray(row.permissions)) return null;
  const permissions = row.permissions.filter((value): value is Permission => isPermission(value));
  if (permissions.length !== row.permissions.length || new Set(permissions).size !== permissions.length) return null;
  if (role !== "老板" && BOSS_ONLY_PERMISSIONS.some((permission) => permissions.includes(permission))) return null;
  return permissions;
}

export function scopeForPermissions(
  role: AppRole | null,
  permissions: readonly Permission[],
): "all" | "own" | "none" {
  if (!permissions.includes("potential.read")) return "none";
  return role === "跟进人" ? "own" : "all";
}
