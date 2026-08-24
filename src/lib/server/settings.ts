import { createServerFn } from "@tanstack/react-start";
import { iso } from "@/lib/domain";
import { getSettings, listWarehouses, logOp, nid, sqlClient } from "./helpers";
import { ensureSeed } from "./seed";

export const getAppSettings = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await ensureSeed(sql);
  const settings = await getSettings(sql);
  const warehouses = await listWarehouses(sql);
  const batches = await sql`
    select * from import_batches order by created_at desc limit 30
  `;
  const logs = await sql`
    select * from op_logs order by created_at desc limit 40
  `;
  const channels = await sql`select * from channels order by name`;
  const customers = await sql`select * from customers order by name`;
  return {
    settings,
    warehouses,
    channels: channels.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      isActive: Boolean(r.is_active),
    })),
    customers: customers.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      isActive: Boolean(r.is_active),
    })),
    batches: batches.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      sourceType: String(r.source_type),
      filename: r.filename ? String(r.filename) : null,
      createdAt: iso(r.created_at),
      undoneAt: r.undone_at ? String(r.undone_at) : null,
    })),
    logs: logs.map((r) => ({
      id: String(r.id),
      action: String(r.action),
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      detail: r.detail ? String(r.detail) : null,
      createdAt: iso(r.created_at),
    })),
  };
});

export const updateWindows = createServerFn({ method: "POST" })
  .validator((input: { inquiryWindowDays: number; offerWindowDays: number }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await sql`
      insert into app_settings (key, value) values ('inquiry_window_days', ${String(data.inquiryWindowDays)})
      on conflict (key) do update set value = excluded.value
    `;
    await sql`
      insert into app_settings (key, value) values ('offer_window_days', ${String(data.offerWindowDays)})
      on conflict (key) do update set value = excluded.value
    `;
    return { ok: true as const };
  });

export const upsertWarehouse = createServerFn({ method: "POST" })
  .validator((input: { id?: string; code: string; name: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const code = data.code.trim();
    const name = data.name.trim() || code;
    if (!code) throw new Error("仓库代码不能为空");
    if (data.id) {
      await sql`update warehouses set code = ${code}, name = ${name} where id = ${data.id}`;
      return { id: data.id };
    }
    const id = nid();
    const max = await sql<{ n: number }>`select coalesce(max(sort_order),0)::int as n from warehouses`;
    await sql`
      insert into warehouses (id, code, name, sort_order) values (${id}, ${code}, ${name}, ${(max[0]?.n ?? 0) + 1})
    `;
    return { id };
  });

export const setWarehouseActive = createServerFn({ method: "POST" })
  .validator((input: { id: string; isActive: boolean }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await sql`update warehouses set is_active = ${data.isActive} where id = ${data.id}`;
    return { ok: true as const };
  });

export const undoImportBatch = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const batch = await sql`select * from import_batches where id = ${data.id}`;
    if (!batch[0]) throw new Error("批次不存在");
    if (batch[0].undone_at) throw new Error("该批次已撤销");
    const lots = await sql`
      select * from stock_lots where import_batch_id = ${data.id} and deleted_at is null
    `;
    for (const lot of lots) {
      if (Number(lot.qty_remaining) !== Number(lot.qty_in) && lot.status !== "in_transit") {
        throw new Error("该批次库存已被后续出库消耗，不能整批撤销");
      }
      if (lot.status === "in_transit" && Number(lot.qty_remaining) !== Number(lot.qty_in)) {
        throw new Error("该批次在途已部分入库，不能整批撤销");
      }
    }
    await sql`update stock_lots set deleted_at = now() where import_batch_id = ${data.id}`;
    await sql`update stock_movements set deleted_at = now() where import_batch_id = ${data.id}`;
    await sql`update channel_offers set deleted_at = now() where import_batch_id = ${data.id}`;
    await sql`update customer_inquiries set deleted_at = now() where import_batch_id = ${data.id}`;
    await sql`update import_batches set undone_at = now() where id = ${data.id}`;
    await logOp(sql, "undo_batch", "import_batch", data.id);
    return { ok: true as const };
  });
