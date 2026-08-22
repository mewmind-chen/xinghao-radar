import { createServerFn } from "@tanstack/react-start";
import { formatStockLine } from "@/lib/domain";
import type { CostTax, Currency, MatchFlags } from "@/lib/types";
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
} from "./helpers";
import { ensureSeed } from "./seed";

export const listChannels = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await ensureSeed(sql);
  const rows = await sql`select * from channels order by is_active desc, name`;
  return rows.map(mapChannel);
});

export const listCustomers = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await ensureSeed(sql);
  const rows = await sql`select * from customers order by is_active desc, name`;
  return rows.map(mapCustomer);
});

export const upsertChannel = createServerFn({ method: "POST" })
  .validator((input: { name: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    return ensureChannel(sql, data.name);
  });

export const upsertCustomer = createServerFn({ method: "POST" })
  .validator((input: { name: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    return ensureCustomer(sql, data.name);
  });

export const setChannelActive = createServerFn({ method: "POST" })
  .validator((input: { id: string; isActive: boolean }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await sql`update channels set is_active = ${data.isActive} where id = ${data.id}`;
    await logOp(sql, data.isActive ? "enable" : "disable", "channel", data.id);
    return { ok: true as const };
  });

export const setCustomerActive = createServerFn({ method: "POST" })
  .validator((input: { id: string; isActive: boolean }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await sql`update customers set is_active = ${data.isActive} where id = ${data.id}`;
    await logOp(sql, data.isActive ? "enable" : "disable", "customer", data.id);
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
};

export const listOffers = createServerFn({ method: "GET" })
  .validator(
    (input: { scope?: "valid" | "history" | "all"; q?: string; channelId?: string } | undefined) =>
      input ?? {},
  )
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await ensureSeed(sql);
    const settings = await getSettings(sql);
    const rows = await sql`
      select o.*, ch.name as channel_name, ch.is_active as channel_active, p.mpn, p.brand_code
      from channel_offers o
      join channels ch on ch.id = o.channel_id
      join parts p on p.id = o.part_id
      where o.deleted_at is null
      order by o.offered_at desc
      limit 400
    `;
    const flags = await matchFlagsForParts(
      sql,
      [...new Set(rows.map((r) => String(r.part_id)))],
      settings,
    );
    let items: OfferListItem[] = rows.map((r) => {
      const f = flags.get(String(r.part_id)) ?? null;
      return {
        id: String(r.id),
        channelId: String(r.channel_id),
        channelName: String(r.channel_name),
        channelActive: Boolean(r.channel_active),
        partId: String(r.part_id),
        mpn: String(r.mpn),
        brandCode: r.brand_code ? String(r.brand_code) : null,
        qty: r.qty != null ? Number(r.qty) : null,
        dateCode: r.date_code ? String(r.date_code) : null,
        priceAmount: r.price_amount != null ? Number(r.price_amount) : null,
        priceCurrency: asCurrency(r.price_currency),
        priceTax: asCostTax(r.price_tax),
        isTp: Boolean(r.is_tp),
        leadTimeText: r.lead_time_text ? String(r.lead_time_text) : null,
        offeredAt: String(r.offered_at),
        isValid: Boolean(r.is_valid),
        flags: f,
        stockLine: f ? formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel) : "",
      };
    });
    if (data.scope === "valid") items = items.filter((i) => i.isValid && i.channelActive);
    if (data.scope === "history") items = items.filter((i) => !i.isValid);
    if (data.channelId) items = items.filter((i) => i.channelId === data.channelId);
    if (data.q) {
      const q = data.q.trim().toUpperCase();
      items = items.filter(
        (i) =>
          i.mpn.toUpperCase().includes(q) ||
          i.channelName.includes(data.q!) ||
          (i.brandCode ?? "").toUpperCase().includes(q),
      );
    }
    const channels = (await sql`select * from channels order by name`).map(mapChannel);
    return { items, channels, settings };
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
  inquiredAt: string;
  isValid: boolean;
  flags: MatchFlags | null;
  stockLine: string;
};

export const listInquiries = createServerFn({ method: "GET" })
  .validator(
    (input: { scope?: "valid" | "history" | "all"; q?: string; customerId?: string } | undefined) =>
      input ?? {},
  )
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await ensureSeed(sql);
    const settings = await getSettings(sql);
    const rows = await sql`
      select i.*, c.name as customer_name, c.is_active as customer_active, p.mpn, p.brand_code
      from customer_inquiries i
      join customers c on c.id = i.customer_id
      join parts p on p.id = i.part_id
      where i.deleted_at is null
      order by i.inquired_at desc
      limit 400
    `;
    const flags = await matchFlagsForParts(
      sql,
      [...new Set(rows.map((r) => String(r.part_id)))],
      settings,
    );
    let items: InquiryListItem[] = rows.map((r) => {
      const f = flags.get(String(r.part_id)) ?? null;
      return {
        id: String(r.id),
        customerId: String(r.customer_id),
        customerName: String(r.customer_name),
        customerActive: Boolean(r.customer_active),
        partId: String(r.part_id),
        mpn: String(r.mpn),
        brandCode: r.brand_code ? String(r.brand_code) : null,
        qty: r.qty != null ? Number(r.qty) : null,
        inquiredAt: String(r.inquired_at),
        isValid: Boolean(r.is_valid),
        flags: f,
        stockLine: f ? formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel) : "",
      };
    });
    if (data.scope === "valid") items = items.filter((i) => i.isValid && i.customerActive);
    if (data.scope === "history") items = items.filter((i) => !i.isValid);
    if (data.customerId) items = items.filter((i) => i.customerId === data.customerId);
    if (data.q) {
      const q = data.q.trim().toUpperCase();
      items = items.filter(
        (i) =>
          i.mpn.toUpperCase().includes(q) ||
          i.customerName.includes(data.q!) ||
          (i.brandCode ?? "").toUpperCase().includes(q),
      );
    }
    const customers = (await sql`select * from customers order by name`).map(mapCustomer);
    return { items, customers, settings };
  });

export const createOffer = createServerFn({ method: "POST" })
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
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const part = await ensurePart(sql, data.mpn, { source: "渠道" });
    const ch = await ensureChannel(sql, data.channel);
    const id = nid();
    await sql`
      insert into channel_offers (
        id, channel_id, part_id, qty, date_code, price_amount, price_currency, price_tax, is_tp, lead_time_text
      ) values (
        ${id}, ${ch.id}, ${part.id}, ${data.qty ?? null}, ${data.dateCode ?? null},
        ${data.priceAmount ?? null}, ${data.priceCurrency ?? null}, ${data.priceTax ?? null},
        ${data.isTp ?? false}, ${data.leadTimeText ?? null}
      )
    `;
    await sql`update parts set updated_at = now() where id = ${part.id}`;
    const flags = await matchFlagsForParts(sql, [part.id]);
    return { id, partId: part.id, flags: flags.get(part.id)! };
  });

export const createInquiry = createServerFn({ method: "POST" })
  .validator((input: { customer: string; mpn: string; qty?: number | null }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const part = await ensurePart(sql, data.mpn, { source: "询价" });
    const cu = await ensureCustomer(sql, data.customer);
    const id = nid();
    await sql`
      insert into customer_inquiries (id, customer_id, part_id, qty)
      values (${id}, ${cu.id}, ${part.id}, ${data.qty ?? null})
    `;
    await sql`update parts set updated_at = now() where id = ${part.id}`;
    const flags = await matchFlagsForParts(sql, [part.id]);
    return { id, partId: part.id, flags: flags.get(part.id)! };
  });

export const setOfferValid = createServerFn({ method: "POST" })
  .validator((input: { ids: string[]; isValid: boolean }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    for (const id of data.ids) {
      await sql`
        update channel_offers
        set is_valid = ${data.isValid}, invalidated_at = ${data.isValid ? null : new Date().toISOString()}
        where id = ${id} and deleted_at is null
      `;
      await logOp(sql, data.isValid ? "restore" : "invalidate", "offer", id);
    }
    return { ok: true as const };
  });

export const setInquiryValid = createServerFn({ method: "POST" })
  .validator((input: { ids: string[]; isValid: boolean }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    for (const id of data.ids) {
      await sql`
        update customer_inquiries
        set is_valid = ${data.isValid}, invalidated_at = ${data.isValid ? null : new Date().toISOString()}
        where id = ${id} and deleted_at is null
      `;
      await logOp(sql, data.isValid ? "restore" : "invalidate", "inquiry", id);
    }
    return { ok: true as const };
  });

export const softDeleteOffers = createServerFn({ method: "POST" })
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    for (const id of data.ids) {
      await sql`update channel_offers set deleted_at = now() where id = ${id}`;
      await logOp(sql, "delete", "offer", id);
    }
    return { ok: true as const };
  });

export const softDeleteInquiries = createServerFn({ method: "POST" })
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    for (const id of data.ids) {
      await sql`update customer_inquiries set deleted_at = now() where id = ${id}`;
      await logOp(sql, "delete", "inquiry", id);
    }
    return { ok: true as const };
  });

export const listWatchlist = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await ensureSeed(sql);
  const rows = await sql`
    select w.part_id, w.note, w.added_at, p.*
    from watchlist w join parts p on p.id = w.part_id
    order by w.added_at desc
  `;
  const flags = await matchFlagsForParts(
    sql,
    rows.map((r) => String(r.part_id)),
  );
  return rows.map((r) => {
    const f = flags.get(String(r.part_id))!;
    return {
      partId: String(r.part_id),
      note: r.note ? String(r.note) : null,
      addedAt: String(r.added_at),
      mpn: String(r.mpn),
      brandCode: r.brand_code ? String(r.brand_code) : null,
      category: r.category ? String(r.category) : null,
      flags: f,
      stockLine: formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel),
    };
  });
});

export const toggleWatch = createServerFn({ method: "POST" })
  .validator((input: { partId: string; on: boolean; note?: string }) => input)
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    if (data.on) {
      await sql`
        insert into watchlist (part_id, note) values (${data.partId}, ${data.note ?? null})
        on conflict (part_id) do update set note = excluded.note
      `;
    } else {
      await sql`delete from watchlist where part_id = ${data.partId}`;
    }
    return { ok: true as const };
  });
