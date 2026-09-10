import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  getCurrentPrincipal,
  potentialScopeFor,
  requirePotential,
  requireRole,
} from "@/lib/auth/authorization.server";
import { formatStockLine, iso } from "@/lib/domain";
import type { CostTax, Currency, MatchFlags } from "@/lib/types";
import type { ImportSource, ImportRow } from "@/lib/types";
import { resolveImportWithEngine } from "./import-engine-adapter";
import {
  asCostTax,
  asCurrency,
  ensureChannel,
  ensureCustomer,
  ensurePart,
  getSettings,
  logOp,
  mapChannel,
  mapCustomer,
  matchFlagsForParts,
  nid,
  sqlClient,
  withTransaction,
} from "./helpers";
import { ensureSeed } from "./seed";

export const listChannels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "market.read");
    const sql = await sqlClient();
    await ensureSeed(sql);
    const rows = await sql`select * from channels order by is_active desc, name`;
    return rows.map(mapChannel);
  });

export const listCustomers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "market.read");
    const sql = await sqlClient();
    await ensureSeed(sql);
    const rows = await sql`select * from customers order by is_active desc, name`;
    return rows.map(mapCustomer);
  });

export const upsertChannel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const channel = await ensureChannel(sql, data.name, { requireActive: false });
    await logOp(sql, "upsert", "channel", channel.id, { principal, after: { name: channel.name } });
    return channel;
  });

export const upsertCustomer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const customer = await ensureCustomer(sql, data.name);
    await logOp(sql, "upsert", "customer", customer.id, {
      principal,
      after: { name: customer.name },
    });
    return customer;
  });

export const setChannelActive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; isActive: boolean }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const before = await sql`select * from channels where id = ${data.id} limit 1`;
    const after =
      await sql`update channels set is_active = ${data.isActive} where id = ${data.id} returning *`;
    if (!after[0]) throw new Error("渠道不存在");
    await logOp(sql, data.isActive ? "enable" : "disable", "channel", data.id, {
      principal,
      before: before[0],
      after: after[0],
    });
    return { ok: true as const };
  });

export const setCustomerActive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; isActive: boolean }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const before = await sql`select * from customers where id = ${data.id} limit 1`;
    const after =
      await sql`update customers set is_active = ${data.isActive} where id = ${data.id} returning *`;
    if (!after[0]) throw new Error("客户不存在");
    await logOp(sql, data.isActive ? "enable" : "disable", "customer", data.id, {
      principal,
      before: before[0],
      after: after[0],
    });
    return { ok: true as const };
  });

export type OfferListItem = {
  id: string;
  channelId: string;
  channelName: string;
  channelActive: boolean;
  partId: string;
  mpn: string;
  brandCode: string | null;
  qty: number | null;
  dateCode: string | null;
  priceAmount: number | null;
  priceCurrency: Currency | null;
  priceTax: CostTax | null;
  isTp: boolean;
  leadTimeText: string | null;
  offeredAt: string;
  isValid: boolean;
  flags: MatchFlags | null;
  stockLine: string;
  historyReason?: string | null;
};

function pageValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

export const listOffers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    (
      input:
        | {
            scope?: "valid" | "history" | "all";
            q?: string;
            channelId?: string;
            limit?: number;
            offset?: number;
          }
        | undefined,
    ) => input ?? {},
  )
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "market.read");
    const sql = await sqlClient();
    await ensureSeed(sql);
    const settings = await getSettings(sql);
    const limit = pageValue(data.limit, 100, 1, 200);
    const offset = pageValue(data.offset, 0, 0, 100_000_000);
    const params: unknown[] = [];
    const where = ["o.deleted_at is null"];
    if (data.scope === "valid") where.push("o.is_valid = true and ch.is_active = true");
    if (data.scope === "history") where.push("(o.is_valid = false or ch.is_active = false)");
    if (data.channelId) {
      params.push(data.channelId);
      where.push(`o.channel_id = $${params.length}`);
    }
    if (data.q?.trim()) {
      params.push(`%${data.q.trim()}%`);
      const qParam = `$${params.length}`;
      where.push(
        `(p.mpn ilike ${qParam} or coalesce(p.brand_code, '') ilike ${qParam} or ch.name ilike ${qParam})`,
      );
    }
    const whereSql = where.join(" and ");
    const countRows = await sql.query<{ n: number }>(
      `select count(*)::int as n from channel_offers o join channels ch on ch.id = o.channel_id join parts p on p.id = o.part_id where ${whereSql}`,
      params,
    );
    const rows = await sql.query<Record<string, unknown>>(
      `select o.*, ch.name as channel_name, ch.is_active as channel_active, p.mpn, p.brand_code
       from channel_offers o join channels ch on ch.id = o.channel_id join parts p on p.id = o.part_id
       where ${whereSql} order by o.offered_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset],
    );
    const flags = await matchFlagsForParts(
      sql,
      [...new Set(rows.map((r) => String(r.part_id)))],
      settings,
      principal.userId,
      potentialScopeFor(principal),
    );
    const items: OfferListItem[] = rows.map((r) => {
      const f = flags.get(String(r.part_id)) ?? null;
      return {
        id: String(r.id),
        channelId: String(r.channel_id),
        channelName: String(r.channel_name),
        channelActive: r.channel_active === true,
        partId: String(r.part_id),
        mpn: String(r.mpn),
        brandCode: r.brand_code ? String(r.brand_code) : null,
        qty: r.qty != null ? Number(r.qty) : null,
        dateCode: r.date_code ? String(r.date_code) : null,
        priceAmount: r.price_amount != null ? Number(r.price_amount) : null,
        priceCurrency: asCurrency(r.price_currency),
        priceTax: asCostTax(r.price_tax),
        isTp: r.is_tp === true,
        leadTimeText: r.lead_time_text ? String(r.lead_time_text) : null,
        offeredAt: iso(r.offered_at),
        isValid: r.is_valid === true,
        flags: f,
        stockLine: f ? formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel) : "",
        historyReason:
          r.is_valid !== true ? "记录已停用" : r.channel_active !== true ? "渠道已停用" : null,
      };
    });
    const channels = (await sql`select * from channels order by name`).map(mapChannel);
    return {
      items,
      channels,
      activeChannels: channels.filter((channel) => channel.isActive),
      disabledChannels: channels.filter((channel) => !channel.isActive),
      settings,
      total: Number(countRows[0]?.n ?? 0),
      limit,
      offset,
      hasMore: offset + items.length < Number(countRows[0]?.n ?? 0),
    };
  });

export type InquiryListItem = {
  id: string;
  customerId: string;
  customerName: string;
  customerActive: boolean;
  partId: string;
  mpn: string;
  brandCode: string | null;
  qty: number | null;
  tpAmount: number | null;
  tpCurrency: Currency | null;
  inquiredAt: string;
  isValid: boolean;
  flags: MatchFlags | null;
  stockLine: string;
  historyReason?: string | null;
};

export const listInquiries = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(
    (
      input:
        | {
            scope?: "valid" | "history" | "all";
            q?: string;
            customerId?: string;
            limit?: number;
            offset?: number;
          }
        | undefined,
    ) => input ?? {},
  )
  .handler(async ({ data, context }) => {
    const principal = await getCurrentPrincipal(context.bearerToken);
    requireRole(principal, "market.read");
    const sql = await sqlClient();
    await ensureSeed(sql);
    const settings = await getSettings(sql);
    const limit = pageValue(data.limit, 100, 1, 200);
    const offset = pageValue(data.offset, 0, 0, 100_000_000);
    const params: unknown[] = [];
    const where = ["i.deleted_at is null"];
    if (data.scope === "valid") where.push("i.is_valid = true and c.is_active = true");
    if (data.scope === "history") where.push("(i.is_valid = false or c.is_active = false)");
    if (data.customerId) {
      params.push(data.customerId);
      where.push(`i.customer_id = $${params.length}`);
    }
    if (data.q?.trim()) {
      params.push(`%${data.q.trim()}%`);
      const qParam = `$${params.length}`;
      where.push(
        `(p.mpn ilike ${qParam} or coalesce(p.brand_code, '') ilike ${qParam} or c.name ilike ${qParam})`,
      );
    }
    const whereSql = where.join(" and ");
    const countRows = await sql.query<{ n: number }>(
      `select count(*)::int as n from customer_inquiries i join customers c on c.id = i.customer_id join parts p on p.id = i.part_id where ${whereSql}`,
      params,
    );
    const rows = await sql.query<Record<string, unknown>>(
      `select i.*, c.name as customer_name, c.is_active as customer_active, p.mpn, p.brand_code
       from customer_inquiries i join customers c on c.id = i.customer_id join parts p on p.id = i.part_id
       where ${whereSql} order by i.inquired_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, limit, offset],
    );
    const flags = await matchFlagsForParts(
      sql,
      [...new Set(rows.map((r) => String(r.part_id)))],
      settings,
      principal.userId,
      potentialScopeFor(principal),
    );
    const items: InquiryListItem[] = rows.map((r) => {
      const f = flags.get(String(r.part_id)) ?? null;
      return {
        id: String(r.id),
        customerId: String(r.customer_id),
        customerName: String(r.customer_name),
        customerActive: r.customer_active === true,
        partId: String(r.part_id),
        mpn: String(r.mpn),
        brandCode: r.brand_code ? String(r.brand_code) : null,
        qty: r.qty != null ? Number(r.qty) : null,
        tpAmount: r.tp_amount != null ? Number(r.tp_amount) : null,
        tpCurrency: asCurrency(r.tp_currency),
        inquiredAt: iso(r.inquired_at),
        isValid: r.is_valid === true,
        flags: f,
        stockLine: f ? formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel) : "",
        historyReason:
          r.is_valid !== true ? "记录已停用" : r.customer_active !== true ? "客户已停用" : null,
      };
    });
    const customers = (await sql`select * from customers order by name`).map(mapCustomer);
    const total = Number(countRows[0]?.n ?? 0);
    return {
      items,
      customers,
      settings,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  });

export const createOffer = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      channel: string;
      mpn: string;
      qty?: number | null;
      dateCode?: string;
      priceAmount?: number | null;
      priceCurrency?: Currency | null;
      priceTax?: CostTax | null;
      isTp?: boolean;
      leadTimeText?: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const id = nid();
    const partAndChannel = await withTransaction(sql, async (tx) => {
      const part = await ensurePart(tx, data.mpn, { source: "渠道" });
      const ch = await ensureChannel(tx, data.channel, { requireActive: true });
      await tx`
        insert into channel_offers (
          id, channel_id, part_id, qty, date_code, price_amount, price_currency, price_tax, is_tp, lead_time_text
        ) values (
          ${id}, ${ch.id}, ${part.id}, ${data.qty ?? null}, ${data.dateCode ?? null},
          ${data.priceAmount ?? null}, ${data.priceCurrency ?? null}, ${data.priceTax ?? null},
          ${data.isTp ?? false}, ${data.leadTimeText ?? null}
        )
      `;
      await tx`update parts set updated_at = now() where id = ${part.id}`;
      await logOp(tx, "create", "offer", id, {
        principal,
        after: { partId: part.id, channelId: ch.id, qty: data.qty ?? null },
      });
      return { part, ch };
    });
    const part = partAndChannel.part;
    const flags = await matchFlagsForParts(
      sql,
      [part.id],
      undefined,
      principal.userId,
      potentialScopeFor(principal),
    );
    return { id, partId: part.id, flags: flags.get(part.id)! };
  });

export const createInquiry = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      customer: string;
      mpn: string;
      qty?: number | null;
      tpAmount?: number | null;
      tpCurrency?: Currency | null;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const id = nid();
    const partAndCustomer = await withTransaction(sql, async (tx) => {
      const part = await ensurePart(tx, data.mpn, { source: "询价" });
      const cu = await ensureCustomer(tx, data.customer);
      await tx`
        insert into customer_inquiries (id, customer_id, part_id, qty, tp_amount, tp_currency)
        values (${id}, ${cu.id}, ${part.id}, ${data.qty ?? null}, ${data.tpAmount ?? null}, ${data.tpCurrency ?? null})
      `;
      await tx`update parts set updated_at = now() where id = ${part.id}`;
      await logOp(tx, "create", "inquiry", id, {
        principal,
        after: { partId: part.id, customerId: cu.id, qty: data.qty ?? null },
      });
      return { part, cu };
    });
    const part = partAndCustomer.part;
    const flags = await matchFlagsForParts(
      sql,
      [part.id],
      undefined,
      principal.userId,
      potentialScopeFor(principal),
    );
    return { id, partId: part.id, flags: flags.get(part.id)! };
  });

export const setOfferValid = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { ids: string[]; isValid: boolean }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const ids = [...new Set(data.ids)].filter(Boolean);
    if (!ids.length) throw new Error("没有选择记录");
    await withTransaction(sql, async (tx) => {
      for (const id of ids) {
        const before =
          await tx`select * from channel_offers where id = ${id} and deleted_at is null for update`;
        if (!before[0]) throw new Error("存在不可操作的渠道记录");
        const after = await tx`
          update channel_offers set is_valid = ${data.isValid}, invalidated_at = ${data.isValid ? null : new Date().toISOString()}
          where id = ${id} and deleted_at is null returning *
        `;
        await logOp(tx, data.isValid ? "restore" : "invalidate", "offer", id, {
          principal,
          before: before[0],
          after: after[0],
        });
      }
    });
    return { ok: true as const };
  });

export const setInquiryValid = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { ids: string[]; isValid: boolean }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const ids = [...new Set(data.ids)].filter(Boolean);
    if (!ids.length) throw new Error("没有选择记录");
    await withTransaction(sql, async (tx) => {
      for (const id of ids) {
        const before =
          await tx`select * from customer_inquiries where id = ${id} and deleted_at is null for update`;
        if (!before[0]) throw new Error("存在不可操作的询价记录");
        const after = await tx`
          update customer_inquiries set is_valid = ${data.isValid}, invalidated_at = ${data.isValid ? null : new Date().toISOString()}
          where id = ${id} and deleted_at is null returning *
        `;
        await logOp(tx, data.isValid ? "restore" : "invalidate", "inquiry", id, {
          principal,
          before: before[0],
          after: after[0],
        });
      }
    });
    return { ok: true as const };
  });

export const softDeleteOffers = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const ids = [...new Set(data.ids)].filter(Boolean);
    if (!ids.length) throw new Error("没有选择记录");
    await withTransaction(sql, async (tx) => {
      for (const id of ids) {
        const before =
          await tx`select * from channel_offers where id = ${id} and deleted_at is null for update`;
        if (!before[0]) throw new Error("存在不可删除的渠道记录");
        const after =
          await tx`update channel_offers set deleted_at = now() where id = ${id} returning *`;
        await logOp(tx, "delete", "offer", id, { principal, before: before[0], after: after[0] });
      }
    });
    return { ok: true as const };
  });

export const softDeleteInquiries = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data, context }) => {
    const principal = requireRole(await getCurrentPrincipal(context.bearerToken), "market.write");
    const sql = await sqlClient();
    const ids = [...new Set(data.ids)].filter(Boolean);
    if (!ids.length) throw new Error("没有选择记录");
    await withTransaction(sql, async (tx) => {
      for (const id of ids) {
        const before =
          await tx`select * from customer_inquiries where id = ${id} and deleted_at is null for update`;
        if (!before[0]) throw new Error("存在不可删除的询价记录");
        const after =
          await tx`update customer_inquiries set deleted_at = now() where id = ${id} returning *`;
        await logOp(tx, "delete", "inquiry", id, { principal, before: before[0], after: after[0] });
      }
    });
    return { ok: true as const };
  });

export const listWatchlist = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const principal = requirePotential(
      await getCurrentPrincipal(context.bearerToken),
      "potential.read",
    );
    const sql = await sqlClient();
    await ensureSeed(sql);
    const rows =
      potentialScopeFor(principal) === "own"
        ? await sql`
        select w.part_id, w.note, w.created_at as added_at, p.*
        from potential_models w join parts p on p.id = w.part_id
        where w.user_id = ${principal.userId}
        order by w.created_at desc
      `
        : await sql`
        select w.part_id, max(w.note) as note, max(w.created_at) as added_at, p.*
        from potential_models w join parts p on p.id = w.part_id
        group by w.part_id, p.id
        order by max(w.created_at) desc
      `;
    const flags = await matchFlagsForParts(
      sql,
      rows.map((r) => String(r.part_id)),
      undefined,
      principal.userId,
      potentialScopeFor(principal),
    );
    return rows.map((r) => {
      const f = flags.get(String(r.part_id))!;
      return {
        partId: String(r.part_id),
        note: r.note ? String(r.note) : null,
        addedAt: iso(r.added_at),
        mpn: String(r.mpn),
        brandCode: r.brand_code ? String(r.brand_code) : null,
        category: r.category ? String(r.category) : null,
        flags: f,
        stockLine: formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel),
      };
    });
  });

export const toggleWatch = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { partId: string; on: boolean; note?: string }) => input)
  .handler(async ({ data, context }) => {
    const principal = requirePotential(
      await getCurrentPrincipal(context.bearerToken),
      "potential.write",
    );
    const sql = await sqlClient();
    if (data.on) {
      await sql`
        insert into potential_models (user_id, part_id, note) values (${principal.userId}, ${data.partId}, ${data.note ?? null})
        on conflict (user_id, part_id) do update set note = excluded.note
      `;
    } else {
      await sql`delete from potential_models where user_id = ${principal.userId} and part_id = ${data.partId}`;
    }
    return { ok: true as const };
  });

export type PotentialCandidate = {
  id: string;
  mpn: string;
  partId: string | null;
  isNewPart: boolean;
  alreadyFollowed: boolean;
  selected: boolean;
  warning: string | null;
};

export const parsePotentialImport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: {
      sourceType: ImportSource;
      text?: string;
      filename?: string;
      fileBase64?: string;
      mime?: string;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const principal = requirePotential(
      await getCurrentPrincipal(context.bearerToken),
      "potential.write",
    );
    const sql = await sqlClient();
    await ensureSeed(sql);
    const resolved = await resolveImportWithEngine({
      kind: "offer",
      sourceType: data.sourceType,
      text: data.text,
      filename: data.filename,
      fileBase64: data.fileBase64,
      mime: data.mime,
    });
    const rows = resolved.rows.filter((row) => row.mpn.trim());
    const keys = [...new Set(rows.map((row) => row.mpn.normalize("NFKC").trim().toUpperCase()))];
    const parts = keys.length
      ? await sql.query<{ id: string; mpn_key: string }>(
          `select id, mpn_key from parts where mpn_key in (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          keys,
        )
      : [];
    const partByKey = new Map(parts.map((part) => [String(part.mpn_key), String(part.id)]));
    const partIds = [...partByKey.values()];
    const followed = partIds.length
      ? await sql.query<{ part_id: string }>(
          `select part_id from potential_models where user_id = $1 and part_id in (${partIds.map((_, i) => `$${i + 2}`).join(",")})`,
          [principal.userId, ...partIds],
        )
      : [];
    const followedSet = new Set(followed.map((row) => String(row.part_id)));
    const candidates: PotentialCandidate[] = rows.map((row: ImportRow) => {
      const key = row.mpn.normalize("NFKC").trim().toUpperCase();
      const partId = partByKey.get(key) ?? null;
      const alreadyFollowed = Boolean(partId && followedSet.has(partId));
      const warning = row.warning || (alreadyFollowed ? "当前用户已关注，默认不重复加入" : null);
      return {
        id: row.id,
        mpn: row.mpn,
        partId,
        isNewPart: !partId,
        alreadyFollowed,
        selected: row.selected && !alreadyFollowed && !row.warning,
        warning,
      };
    });
    return {
      candidates,
      extractOrigin: resolved.extractOrigin,
      extractState: resolved.extractState,
      extractMessage: resolved.extractMessage,
      usedAi: resolved.usedAi,
    };
  });

export const batchAddPotential = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { rows: { mpn: string; selected: boolean; note?: string }[] }) => input)
  .handler(async ({ data, context }) => {
    const principal = requirePotential(
      await getCurrentPrincipal(context.bearerToken),
      "potential.write",
    );
    if (!Array.isArray(data.rows) || data.rows.length > 5000) throw new Error("潜力型号行数无效");
    const sql = await sqlClient();
    const result = await sql.transaction!(async (tx) => {
      let added = 0;
      let created = 0;
      let skipped = 0;
      let needsReview = 0;
      for (const raw of data.rows) {
        const mpn = raw.mpn.normalize("NFKC").trim();
        if (!raw.selected) {
          if (raw.mpn) skipped += 1;
          continue;
        }
        if (!mpn) {
          needsReview += 1;
          continue;
        }
        const before = await tx`select id from parts where mpn_key = ${mpn.toUpperCase()} limit 1`;
        const part = await ensurePart(tx, mpn, { source: "潜力型号导入" });
        if (!before[0]) created += 1;
        const inserted = await tx`
          insert into potential_models (user_id, part_id, note)
          values (${principal.userId}, ${part.id}, ${raw.note?.trim() || null})
          on conflict (user_id, part_id) do nothing
          returning part_id
        `;
        if (inserted.length) added += 1;
        else skipped += 1;
      }
      return { added, created, skipped, needsReview };
    });
    return result;
  });
