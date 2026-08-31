import { getSql, type Sql } from "@/lib/db";
import {
  DEFAULT_INQUIRY_WINDOW,
  DEFAULT_OFFER_WINDOW,
  brandShort,
  displayMpn,
  finalizeMatchFlags,
  formatEtaLabel,
  iso,
  num,
  normalizeMpn,
} from "@/lib/domain";
import type {
  AppSettings,
  Channel,
  CostTax,
  Currency,
  Customer,
  MatchFlags,
  PackState,
  Part,
  Warehouse,
} from "@/lib/types";

export function nid(): string {
  return crypto.randomUUID();
}

export async function sqlClient(): Promise<Sql> {
  return getSql();
}

export async function withTransaction<T>(
  sql: Sql,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  if (!sql.transaction) throw new Error("数据库事务不可用");
  return sql.transaction(fn);
}

export async function logOp(
  sql: Sql,
  action: string,
  entityType: string,
  entityId: string,
  detail?: string,
) {
  await sql`
    insert into op_logs (id, action, entity_type, entity_id, detail)
    values (${nid()}, ${action}, ${entityType}, ${entityId}, ${detail ?? null})
  `;
}

export function mapPart(r: Record<string, unknown>): Part {
  return {
    id: String(r.id),
    mpnKey: String(r.mpn_key),
    mpn: String(r.mpn),
    brandCode: r.brand_code ? String(r.brand_code) : null,
    category: r.category ? String(r.category) : null,
    package: r.package ? String(r.package) : null,
    description: r.description ? String(r.description) : null,
    lifecycle: r.lifecycle ? String(r.lifecycle) : null,
    params: r.params ? String(r.params) : null,
    source: r.source ? String(r.source) : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function mapWh(r: Record<string, unknown>): Warehouse {
  return {
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    sortOrder: num(r.sort_order) ?? 0,
    isActive: Boolean(r.is_active),
  };
}

export function mapChannel(r: Record<string, unknown>): Channel {
  return {
    id: String(r.id),
    name: String(r.name),
    isActive: Boolean(r.is_active),
    createdAt: iso(r.created_at),
  };
}

export function mapCustomer(r: Record<string, unknown>): Customer {
  return {
    id: String(r.id),
    name: String(r.name),
    isActive: Boolean(r.is_active),
    createdAt: iso(r.created_at),
  };
}

export async function getSettings(sql: Sql): Promise<AppSettings> {
  const rows = await sql<{ key: string; value: string }>`
    select key, value from app_settings where key in ('inquiry_window_days','offer_window_days')
  `;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    inquiryWindowDays: Number(map.inquiry_window_days) || DEFAULT_INQUIRY_WINDOW,
    offerWindowDays: Number(map.offer_window_days) || DEFAULT_OFFER_WINDOW,
  };
}

export async function ensurePart(
  sql: Sql,
  mpnRaw: string,
  extra?: { brand?: string | null; package?: string | null; source?: string | null },
): Promise<Part> {
  const key = normalizeMpn(mpnRaw);
  if (!key) throw new Error("型号不能为空");
  const existing = await sql`select * from parts where mpn_key = ${key} limit 1`;
  if (existing[0]) {
    const row = existing[0];
    if (extra?.brand && !row.brand_code) {
      await sql`update parts set brand_code = ${brandShort(extra.brand)}, updated_at = now() where id = ${row.id}`;
      row.brand_code = brandShort(extra.brand);
    }
    if (extra?.package && !row.package) {
      await sql`update parts set package = ${extra.package}, updated_at = now() where id = ${row.id}`;
      row.package = extra.package;
    }
    return mapPart(row);
  }
  const id = nid();
  const brand = extra?.brand ? brandShort(extra.brand) : null;
  await sql`
    insert into parts (id, mpn_key, mpn, brand_code, package, source)
    values (${id}, ${key}, ${displayMpn(mpnRaw)}, ${brand}, ${extra?.package ?? null}, ${extra?.source ?? "录入"})
  `;
  const created = await sql`select * from parts where id = ${id}`;
  return mapPart(created[0]);
}

export async function ensureChannel(sql: Sql, nameRaw: string): Promise<Channel> {
  const name = nameRaw.normalize("NFKC").trim();
  if (!name) throw new Error("渠道不能为空");
  const existing = await sql`select * from channels where name = ${name} limit 1`;
  if (existing[0]) return mapChannel(existing[0]);
  const id = nid();
  await sql`insert into channels (id, name) values (${id}, ${name})`;
  const created = await sql`select * from channels where id = ${id}`;
  return mapChannel(created[0]);
}

export async function ensureCustomer(sql: Sql, nameRaw: string): Promise<Customer> {
  const name = nameRaw.normalize("NFKC").trim();
  if (!name) throw new Error("客户不能为空");
  const existing = await sql`select * from customers where name = ${name} limit 1`;
  if (existing[0]) return mapCustomer(existing[0]);
  const id = nid();
  await sql`insert into customers (id, name) values (${id}, ${name})`;
  const created = await sql`select * from customers where id = ${id}`;
  return mapCustomer(created[0]);
}

export async function listWarehouses(sql: Sql): Promise<Warehouse[]> {
  const rows = await sql`select * from warehouses order by sort_order asc, code asc`;
  return rows.map(mapWh);
}

export async function matchFlagsForParts(
  sql: Sql,
  partIds: string[],
  settings?: AppSettings,
  userId?: string,
  potentialScope: "all" | "own" | "none" = userId ? "own" : "none",
): Promise<Map<string, MatchFlags>> {
  const out = new Map<string, MatchFlags>();
  if (partIds.length === 0) return out;
  const s = settings ?? (await getSettings(sql));
  const placeholders = partIds.map((_, i) => `$${i + 1}`).join(",");
  const lots = await sql.query<Record<string, unknown>>(
    `select l.part_id, l.status, l.qty_remaining, l.eta_date, l.eta_text, l.eta_precision, w.id as wh_id, w.code as wh_code
     from stock_lots l
     left join warehouses w on w.id = l.warehouse_id
     where l.deleted_at is null and l.qty_remaining > 0
       and l.status in ('on_hand', 'in_transit') and l.part_id in (${placeholders})`,
    partIds,
  );
  const inq = await sql.query<{ part_id: string; n: number }>(
    `select i.part_id, count(*)::int as n
     from customer_inquiries i
     join customers c on c.id = i.customer_id
     where i.deleted_at is null and i.is_valid = true and c.is_active = true
       and i.inquired_at >= now() - (${s.inquiryWindowDays} || ' days')::interval
       and i.part_id in (${placeholders})
     group by i.part_id`,
    partIds,
  );
  const off = await sql.query<{ part_id: string; n: number }>(
    `select o.part_id, count(*)::int as n
     from channel_offers o
     join channels ch on ch.id = o.channel_id
     where o.deleted_at is null and o.is_valid = true and ch.is_active = true
       and o.offered_at >= now() - (${s.offerWindowDays} || ' days')::interval
       and o.part_id in (${placeholders})
     group by o.part_id`,
    partIds,
  );
  const watch = potentialScope === "all"
    ? await sql.query<{ part_id: string }>(
        `select distinct part_id from potential_models where part_id in (${placeholders})`,
        partIds,
      )
    : potentialScope === "own" && userId
      ? await sql.query<{ part_id: string }>(
          `select part_id from potential_models where user_id = $${partIds.length + 1}
           and part_id in (${placeholders})`,
          [...partIds, userId],
        )
      : [];
  const watchSet = new Set(watch.map((r) => r.part_id));
  const inqMap = new Map(inq.map((r) => [r.part_id, r.n]));
  const offMap = new Map(off.map((r) => [r.part_id, r.n]));

  for (const id of partIds) {
    out.set(id, {
      partId: id,
      onHand: 0,
      byWarehouse: [],
      inTransit: 0,
      transitEtaLabel: null,
      inquiryCount: inqMap.get(id) ?? 0,
      offerCount: offMap.get(id) ?? 0,
      watch: watchSet.has(id),
      stock: false,
      transit: false,
      isHit: false,
      isDual: false,
    });
  }

  const whAcc = new Map<string, Map<string, { id: string; code: string; qty: number }>>();
  const transitEta = new Map<string, { date: string | null; text: string | null; precision: string | null }>();

  for (const lot of lots) {
    const id = String(lot.part_id);
    const flags = out.get(id);
    if (!flags) continue;
    const qty = num(lot.qty_remaining) ?? 0;
    if (lot.status === "on_hand") {
      flags.onHand += qty;
      if (lot.wh_id) {
        let m = whAcc.get(id);
        if (!m) {
          m = new Map();
          whAcc.set(id, m);
        }
        const key = String(lot.wh_id);
        const prev = m.get(key);
        if (prev) prev.qty += qty;
        else m.set(key, { id: key, code: String(lot.wh_code), qty });
      }
    } else if (lot.status === "in_transit") {
      flags.inTransit += qty;
      const cur = transitEta.get(id);
      const date = lot.eta_date ? String(lot.eta_date) : null;
      if (!cur || (date && (!cur.date || date < cur.date))) {
        transitEta.set(id, {
          date,
          text: lot.eta_text ? String(lot.eta_text) : null,
          precision: lot.eta_precision ? String(lot.eta_precision) : null,
        });
      }
    }
  }

  for (const [id, flags] of out) {
    flags.byWarehouse = [...(whAcc.get(id)?.values() ?? [])];
    const eta = transitEta.get(id);
    flags.transitEtaLabel = eta
      ? formatEtaLabel({
          etaDate: eta.date,
          etaText: eta.text,
          precision: (eta.precision as "date" | "week" | "month" | "fuzzy" | "stock" | null) ?? null,
        })
      : null;
    finalizeMatchFlags(flags);
  }
  return out;
}

export function asCostTax(v: unknown): CostTax | null {
  if (v === "none" || v === "exclusive" || v === "inclusive") return v;
  return null;
}
export function asCurrency(v: unknown): Currency | null {
  if (v === "USD" || v === "CNY") return v;
  return null;
}
export function asPack(v: unknown): PackState | null {
  if (v === "full" || v === "loose" || v === "mixed") return v;
  return null;
}
