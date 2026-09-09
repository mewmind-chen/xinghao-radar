import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getCurrentPrincipal, requireRole } from "@/lib/auth/authorization.server";
import { sqlClient } from "./helpers";

export const listOperationLogs = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((input: { limit?: number; offset?: number; entityType?: string; outcome?: "success" | "failure" } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "logs.read");
    const limit = Number.isInteger(data.limit) ? Math.min(Math.max(Number(data.limit), 1), 100) : 50;
    const offset = Number.isInteger(data.offset) ? Math.min(Math.max(Number(data.offset), 0), 100_000_000) : 0;
    const params: unknown[] = [];
    const where: string[] = [];
    if (data.entityType?.trim()) {
      params.push(data.entityType.trim());
      where.push(`entity_type = $${params.length}`);
    }
    if (data.outcome) {
      params.push(data.outcome);
      where.push(`outcome = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const sql = await sqlClient();
    const count = await sql.query<{ n: number }>(`select count(*)::int as n from op_logs ${whereSql}`, params);
    const rows = await sql.query<Record<string, unknown>>(
      `select id, action, entity_type, entity_id, detail, actor_user_id, actor_name,
          effective_user_id, effective_name, outcome, before_json, after_json,
          failure_reason, request_id, import_batch_id, created_at
       from op_logs ${whereSql} order by created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset],
    );
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        action: String(row.action),
        entityType: String(row.entity_type),
        entityId: String(row.entity_id),
        detail: row.detail ? String(row.detail) : null,
        actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
        actorName: row.actor_name ? String(row.actor_name) : null,
        effectiveUserId: row.effective_user_id ? String(row.effective_user_id) : null,
        effectiveName: row.effective_name ? String(row.effective_name) : null,
        outcome: String(row.outcome ?? "success") as "success" | "failure",
        beforeJson: row.before_json ? String(row.before_json) : null,
        afterJson: row.after_json ? String(row.after_json) : null,
        failureReason: row.failure_reason ? String(row.failure_reason) : null,
        requestId: row.request_id ? String(row.request_id) : null,
        importBatchId: row.import_batch_id ? String(row.import_batch_id) : null,
        createdAt: new Date(String(row.created_at)).toISOString(),
      })),
      total: Number(count[0]?.n ?? 0),
      limit,
      offset,
      hasMore: offset + rows.length < Number(count[0]?.n ?? 0),
      viewer: { userId: principal.userId, displayName: principal.displayName },
    };
  });
