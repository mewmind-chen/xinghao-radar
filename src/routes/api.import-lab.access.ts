import { createFileRoute } from "@tanstack/react-router";
import { getCurrentPrincipal, isAppRole } from "@/lib/auth/authorization.server";

/**
 * Small same-origin auth bridge for the local Import Lab. The Lab does not
 * duplicate Radar's session verification or database access: it forwards the
 * browser Cookie/Authorization headers here and receives only an allow/deny
 * decision for the two explicitly approved roles.
 */
export const Route = createFileRoute("/api/import-lab/access")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const principal = await getCurrentPrincipal();
          const allowed =
            !principal.isImpersonating &&
            isAppRole(principal.role) &&
            (principal.role === "老板" || principal.role === "最高督察");
          if (!allowed) {
            return Response.json({ allowed: false }, { status: 403 });
          }
          return Response.json({
            allowed: true,
            subject: principal.actorUserId,
            role: principal.role,
          });
        } catch (error) {
          const status = typeof error === "object" && error && "status" in error && (error as { status?: unknown }).status === 403
            ? 403
            : 401;
          return Response.json({ allowed: false }, { status });
        }
      },
    },
  },
});
