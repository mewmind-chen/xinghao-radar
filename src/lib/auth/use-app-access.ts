import { useQuery } from "@tanstack/react-query";
import { getCurrentAccess } from "@/lib/server/auth";
import { authEnabled } from "./client";
import { useCurrentUserState } from "./use-current-user";
import type { Permission } from "./roles";

export function useAppAccess() {
  const { user } = useCurrentUserState();
  const query = useQuery({
    queryKey: ["current-access"],
    queryFn: () => getCurrentAccess(),
    enabled: authEnabled && Boolean(user),
    staleTime: 2_000,
  });
  const permissions = query.data?.permissions ?? [];
  return {
    ...query,
    access: query.data,
    can: (permission: Permission) => permissions.includes(permission),
  };
}
