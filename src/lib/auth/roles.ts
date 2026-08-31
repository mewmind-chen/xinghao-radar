export const APP_ROLES = ["老板", "最高督察", "主管", "跟进人"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export type Permission =
  | "model.read" | "model.write" | "stock.read" | "stock.write" | "inventory.import"
  | "market.read" | "market.write" | "potential.read" | "potential.write"
  | "settings.read" | "settings.write" | "users.manage" | "identity.check"
  | "logs.read" | "analysis.read" | "analysis.write";

export const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  老板: [
    "model.read", "model.write", "stock.read", "stock.write", "inventory.import",
    "market.read", "market.write", "potential.read", "potential.write", "settings.read",
    "settings.write", "users.manage", "identity.check", "logs.read", "analysis.read", "analysis.write",
  ],
  最高督察: ["model.read", "stock.read", "market.read", "potential.read", "potential.write", "analysis.read"],
  主管: ["model.read", "stock.read", "market.read", "market.write", "potential.read", "potential.write", "analysis.read"],
  跟进人: ["model.read", "stock.read", "stock.write", "inventory.import", "potential.read", "potential.write", "analysis.read"],
};

export function roleHasPermission(role: AppRole | null, permission: Permission): boolean {
  return Boolean(role && ROLE_PERMISSIONS[role].includes(permission));
}

export function rolePermissions(role: AppRole | null): Permission[] {
  return role ? [...ROLE_PERMISSIONS[role]] : [];
}
