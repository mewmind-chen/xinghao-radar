import { createServerFn } from "@tanstack/react-start";
import { formatStockLine, startOfTodayIso } from "@/lib/domain";
import { getSettings, listWarehouses, matchFlagsForParts, sqlClient } from "./helpers";
import { ensureSeed } from "./seed";

export const getWorkbench = createServerFn({ method: "GET" }).handler(async () => {
  const sql = await sqlClient();
  await ensureSeed(sql);
  const settings = await getSettings(sql);
  const warehouses = await listWarehouses(sql);
  const since = startOfTodayIso();

  const events = await sql<{ part_id: string; k: string }>`
    select part_id, 'offer' as k from channel_offers
      where deleted_at is null and offered_at >= ${since}
    union all
    select part_id, 'inquiry' as k from customer_inquiries
      where deleted_at is null and inquired_at >= ${since}
    union all
    select part_id, 'stock' as k from stock_movements
      where deleted_at is null and happened_at >= ${since}
  `;
  const byPart = new Map<string, Set<string>>();
  for (const e of events) {
    let set = byPart.get(e.part_id);
    if (!set) {
      set = new Set();
      byPart.set(e.part_id, set);
    }
    set.add(e.k);
  }
  const ids = [...byPart.keys()];
  const flags = await matchFlagsForParts(sql, ids, settings);
  const parts =
    ids.length === 0
      ? []
      : await sql.query<Record<string, unknown>>(
          `select * from parts where id in (${ids.map((_, i) => `$${i + 1}`).join(",")})`,
          ids,
        );
  const partMap = Object.fromEntries(parts.map((p) => [String(p.id), p]));

  const hits = ids
    .map((id) => {
      const f = flags.get(id);
      const p = partMap[id];
      const kinds = byPart.get(id);
      if (!f || !p || !kinds) return null;
      const offerHit = kinds.has("offer") && (f.stock || f.transit || f.inquiryCount > 0 || f.watch);
      const inqHit = kinds.has("inquiry") && (f.stock || f.transit || f.offerCount > 0 || f.watch);
      const stockHit = kinds.has("stock") && (f.inquiryCount > 0 || f.offerCount > 0 || f.watch);
      if (!(offerHit || inqHit || stockHit)) return null;
      return {
        partId: id,
        mpn: String(p.mpn),
        brandCode: p.brand_code ? String(p.brand_code) : null,
        flags: f,
        stockLine: formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel),
        dual: f.isDual,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => Number(b.dual) - Number(a.dual));

  const todayOffers = await sql`select count(*)::int as n from channel_offers where deleted_at is null and offered_at >= ${since}`;
  const todayInq = await sql`select count(*)::int as n from customer_inquiries where deleted_at is null and inquired_at >= ${since}`;

  const pendingTransit = await sql`
    select l.*, p.mpn, p.brand_code
    from stock_lots l join parts p on p.id = l.part_id
    where l.status = 'in_transit' and l.deleted_at is null and l.qty_remaining > 0
    order by l.eta_date nulls last
    limit 12
  `;

  const demandNoStock = await sql`
    select p.id, p.mpn, p.brand_code, count(i.id)::int as n
    from customer_inquiries i
    join customers c on c.id = i.customer_id
    join parts p on p.id = i.part_id
    where i.deleted_at is null and i.is_valid = true and c.is_active = true
      and i.inquired_at >= now() - (${settings.inquiryWindowDays} || ' days')::interval
      and not exists (
        select 1 from stock_lots l
        where l.part_id = p.id and l.deleted_at is null and l.status = 'on_hand' and l.qty_remaining > 0
      )
    group by p.id, p.mpn, p.brand_code
    order by n desc
    limit 8
  `;

  const onHandParts = await sql<{ n: number }>`
    select count(distinct part_id)::int as n from stock_lots
    where deleted_at is null and status = 'on_hand' and qty_remaining > 0
  `;
  const transitParts = await sql<{ n: number }>`
    select count(distinct part_id)::int as n from stock_lots
    where deleted_at is null and status = 'in_transit' and qty_remaining > 0
  `;
  const watchN = await sql<{ n: number }>`select count(*)::int as n from watchlist`;

  return {
    settings,
    warehouses,
    hits,
    stats: {
      todayOffers: Number(todayOffers[0]?.n ?? 0),
      todayInquiries: Number(todayInq[0]?.n ?? 0),
      todayHits: hits.length,
      dualHits: hits.filter((h) => h.dual).length,
      stockSku: Number(onHandParts[0]?.n ?? 0),
      transitSku: Number(transitParts[0]?.n ?? 0),
      watch: Number(watchN[0]?.n ?? 0),
    },
    pendingTransit: pendingTransit.map((r) => ({
      id: String(r.id),
      partId: String(r.part_id),
      mpn: String(r.mpn),
      brandCode: r.brand_code ? String(r.brand_code) : null,
      qty: Number(r.qty_remaining),
      etaDate: r.eta_date ? String(r.eta_date) : null,
      etaText: r.eta_text ? String(r.eta_text) : null,
    })),
    demandNoStock: demandNoStock.map((r) => ({
      partId: String(r.id),
      mpn: String(r.mpn),
      brandCode: r.brand_code ? String(r.brand_code) : null,
      inquiryCount: Number(r.n),
    })),
  };
});
