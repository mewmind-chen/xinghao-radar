import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getCurrentPrincipal, requireRole, ForbiddenError } from "@/lib/auth/authorization.server";
import { iso } from "@/lib/domain";
import { getSettings, listWarehouses, logOp, nid, sqlClient, withTransaction } from "./helpers";
import { ensureSeed } from "./seed";

export const getAppSettings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    requireRole(await getCurrentPrincipal(context.bearerToken), "settings.manage");
    const sql = await sqlClient();
    await ensureSeed(sql);
    const settings = await getSettings(sql);
    const warehouses = await listWarehouses(sql);
    return {
      settings,
      warehouses,
    };
  });

export const updateWindows = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { inquiryWindowDays: number; offerWindowDays: number }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "settings.manage");
    for (const [label, value] of [["询价", data.inquiryWindowDays], ["推货", data.offerWindowDays]] as const) {
      if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error(`${label}窗口必须是 1～3650 的整数`);
    }
    const sql = await sqlClient();
    await withTransaction(sql, async (tx) => {
      const before = await tx`select key, value from app_settings where key in ('inquiry_window_days', 'offer_window_days')`;
      await tx`
        insert into app_settings (key, value) values ('inquiry_window_days', ${String(data.inquiryWindowDays)})
        on conflict (key) do update set value = excluded.value
      `;
      await tx`
        insert into app_settings (key, value) values ('offer_window_days', ${String(data.offerWindowDays)})
        on conflict (key) do update set value = excluded.value
      `;
      await logOp(tx, "update", "settings", "windows", { principal, before, after: data });
    });
    return { ok: true as const };
  });

export const upsertWarehouse = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id?: string; code: string; name: string }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "settings.manage");
    const sql = await sqlClient();
    const code = data.code.trim();
    const name = data.name.trim() || code;
    if (!code) throw new Error("仓库代码不能为空");
    if (data.id) {
      const before = await sql`select * from warehouses where id = ${data.id} limit 1`;
      const after = await sql`update warehouses set code = ${code}, name = ${name} where id = ${data.id} returning *`;
      if (!after[0]) throw new Error("仓库不存在");
      await logOp(sql, "update", "warehouse", data.id, { principal, before: before[0], after: after[0] });
      return { id: data.id };
    }
    const id = nid();
    const max = await sql<{
      n: number;
    }>`select coalesce(max(sort_order),0)::int as n from warehouses`;
    await sql`
      insert into warehouses (id, code, name, sort_order) values (${id}, ${code}, ${name}, ${(max[0]?.n ?? 0) + 1})
    `;
    await logOp(sql, "create", "warehouse", id, { principal, after: { id, code, name } });
    return { id };
  });

export const setWarehouseActive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; isActive: boolean }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "settings.manage");
    const sql = await sqlClient();
    const before = await sql`select * from warehouses where id = ${data.id} limit 1`;
    const after = await sql`update warehouses set is_active = ${data.isActive} where id = ${data.id} returning *`;
    if (!after[0]) throw new Error("仓库不存在");
    await logOp(sql, data.isActive ? "enable" : "disable", "warehouse", data.id, { principal, before: before[0], after: after[0] });
    return { ok: true as const };
  });

export const listImportBatches = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "model.read");
    const sql = await sqlClient();
    const canReadAll = principal.permissions.includes("logs.read");
    const rows =
      canReadAll
        ? await sql`select * from import_batches order by created_at desc limit 30`
        : await sql`select * from import_batches where created_by = ${principal.userId} order by created_at desc limit 30`;
    const output = [];
    for (const r of rows) {
      let result: {
        summary?: { identified?: number; potential?: number };
        writtenCount?: number;
      } | null = null;
      try {
        result = r.result_json ? JSON.parse(String(r.result_json)) : null;
      } catch {
        result = null;
      }
      const kind = String(r.kind);
      let context: string | null = null;
      if (kind === "offer") {
        const hit =
          await sql`select c.name from channel_offers o join channels c on c.id = o.channel_id where o.import_batch_id = ${r.id} and o.deleted_at is null limit 1`;
        if (hit[0]?.name) context = `渠道：${String(hit[0].name)}`;
      } else if (kind === "inquiry") {
        const hit =
          await sql`select min(c.name) as first_name, count(distinct c.name)::int as customer_count from customer_inquiries i join customers c on c.id = i.customer_id where i.import_batch_id = ${r.id} and i.deleted_at is null`;
        if (hit[0]?.first_name) {
          const count = Number(hit[0].customer_count ?? 1);
          context = `客户：${String(hit[0].first_name)}${count > 1 ? `等${count}个` : ""}`;
        }
      } else if (kind === "stock" || kind === "transit") {
        const hit =
          await sql`select w.code from stock_lots l left join warehouses w on w.id = l.warehouse_id where l.import_batch_id = ${r.id} and l.deleted_at is null limit 1`;
        if (hit[0]?.code) context = `仓库：${String(hit[0].code)}`;
      } else if (kind === "potential" && r.created_by) {
        const hit =
          await sql`select display_name from app_users where user_id = ${r.created_by} limit 1`;
        context = `导入人：${String(hit[0]?.display_name ?? r.created_by)}`;
      }
      output.push({
        id: String(r.id),
        kind,
        sourceType: String(r.source_type),
        filename: r.filename ? String(r.filename) : null,
        createdAt: iso(r.created_at),
        status: String(r.status ?? "success") as "writing" | "success" | "failed",
        undoneAt: r.undone_at ? String(r.undone_at) : null,
        createdBy: r.created_by ? String(r.created_by) : null,
        writtenRows:
          result?.writtenCount ?? result?.summary?.potential ?? result?.summary?.identified ?? null,
        context,
        canRevoke: !r.undone_at && Boolean(
          principal.permissions.includes("logs.read") ||
          (principal.permissions.includes("inventory.import") && String(r.created_by ?? "") === principal.userId) ||
          (principal.permissions.includes("market.write") && String(r.created_by ?? "") === principal.userId) ||
          (principal.permissions.includes("potential.write") && String(r.created_by ?? "") === principal.userId),
        ),
      });
    }
    return output;
  });

export const undoImportBatch = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    if (!principal.permissions.includes("logs.read")) {
      if (!(principal.permissions.includes("inventory.import") || principal.permissions.includes("market.write") || principal.permissions.includes("potential.write"))) throw new ForbiddenError("无权撤销导入批次");
      const sql = await sqlClient();
      const owner = await sql`select created_by from import_batches where id = ${data.id} limit 1`;
      if (!owner[0] || String(owner[0].created_by ?? "") !== principal.userId) {
        throw new ForbiddenError("跟进人只能撤销自己创建且未发生后续动作的批次");
      }
    }
    const sql = await sqlClient();
    return withTransaction(sql, async (tx) => {
      const batch = await tx`select * from import_batches where id = ${data.id} for update`;
      if (!batch[0]) throw new Error("批次不存在");
      if (batch[0].undone_at) throw new Error("该批次已撤销");
      const lots = await tx`
        select * from stock_lots where import_batch_id = ${data.id} and deleted_at is null
      `;
      for (const lot of lots) {
        const downstream = await tx`
          select id from stock_movements
          where deleted_at is null
            and (lot_id = ${lot.id} or source_lot_id = ${lot.id})
            and coalesce(import_batch_id, '') <> ${data.id}
          limit 1
        `;
        if (downstream[0]) {
          throw new Error("该批次已发生出库、调拨、修正或在途接收，不能整批撤销");
        }
        if (Number(lot.qty_remaining) !== Number(lot.qty_in)) {
          throw new Error("该批次库存已被后续操作改变，不能整批撤销");
        }
      }
      await tx`update stock_lots set deleted_at = now() where import_batch_id = ${data.id}`;
      await tx`update stock_movements set deleted_at = now() where import_batch_id = ${data.id}`;
      await tx`update channel_offers set deleted_at = now() where import_batch_id = ${data.id}`;
      await tx`update customer_inquiries set deleted_at = now() where import_batch_id = ${data.id}`;
      await tx`delete from potential_models where import_batch_id = ${data.id}`;
      await tx`update import_batches set undone_at = now() where id = ${data.id}`;
      await logOp(tx, "undo_batch", "import_batch", data.id, { principal, importBatchId: data.id });
      return { ok: true as const };
    });
  });
