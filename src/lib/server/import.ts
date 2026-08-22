import { createServerFn } from "@tanstack/react-start";
import {
  DUPLICATE_INQUIRY_HOURS,
  DUPLICATE_OFFER_HOURS,
  brandShort,
  correctTradeText,
  displayMpn,
  formatStockLine,
  isCrossHit,
  normalizeMpn,
  parseCost,
  parseLeadTime,
  parseQty,
  resolveWarehouseCode,
} from "@/lib/domain";
import type { ImportKind, ImportRow, ImportSource } from "@/lib/types";
import {
  ensureChannel,
  ensureCustomer,
  ensurePart,
  listWarehouses,
  matchFlagsForParts,
  nid,
  sqlClient,
} from "./helpers";
import { ensureSeed } from "./seed";

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const MPN_RE = /[A-Za-z0-9][A-Za-z0-9._+\-\/]{3,40}/;

function heuristicParse(text: string, kind: ImportKind): ImportRow[] {
  const rows: ImportRow[] = [];
  for (const line of splitLines(correctTradeText(text))) {
    const mpnMatch = line.match(MPN_RE);
    if (!mpnMatch) continue;
    const mpn = displayMpn(mpnMatch[0]);
    const rest = line.replace(mpnMatch[0], " ");
    const qtyHit = rest.match(/(\d+(?:\.\d+)?)\s*(万|W|K|k|M)?/);
    const qty = qtyHit ? parseQty(qtyHit[0]) : null;
    const cost = parseCost(rest);
    const dc = rest.match(/(?:^|[^A-Za-z0-9])((?:20\d{2}|2[3-6]\d{2})\+?|\d{2}\+)(?=[^A-Za-z0-9+]|$)/);
    const lt = rest.match(/(LT\s*)?(\d+\s*周|现货|\d{1,2}[\/.]\d{1,2}|\d+\s*月底|几天后|8月底)/i);
    const wh = rest.match(/HK|香港|坂田|板田|交通/);
    const isInquiry = kind === "inquiry" || /询|客户/.test(rest);
    const isTransit = kind === "transit" || /在途|到货|货期/.test(rest);
    const isStock = kind === "stock" || /入库|入仓/.test(rest);
    let rowKind: ImportKind = kind === "mixed" ? "offer" : kind;
    if (kind === "mixed") {
      if (isInquiry) rowKind = "inquiry";
      else if (isTransit) rowKind = "transit";
      else if (isStock) rowKind = "stock";
      else rowKind = "offer";
    }
    const cust = rest.match(/客[户]?\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
    const ch = rest.match(/渠道\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/);
    rows.push({
      id: nid(),
      kind: rowKind,
      mpn,
      brand: null,
      qty,
      qtyRaw: qtyHit ? qtyHit[0] : null,
      dateCode: dc ? dc[1] : null,
      priceAmount: cost.amount,
      priceCurrency: cost.currency,
      priceTax: cost.tax,
      isTp: cost.isTp || /\bTP\b/.test(rest),
      leadTimeText: lt ? lt[0] : null,
      etaText: lt ? lt[0] : null,
      warehouse: wh ? resolveWarehouseCode(wh[0]) : null,
      channel: ch ? ch[1] : null,
      customer: cust ? cust[1] : null,
      package: null,
      standardPack: null,
      packState: null,
      costAmount: cost.amount,
      costCurrency: cost.currency,
      costTax: cost.tax,
      note: line,
      duplicate: false,
      duplicateReason: null,
      selected: true,
      warning: null,
    });
  }
  return rows;
}

function headerKey(h: string): string | null {
  const s = h.normalize("NFKC").trim().toLowerCase();
  if (/型号|mpn|p\/n|pn|part\s*number|料号/.test(s)) return "mpn";
  if (/品牌|brand|mfr|厂牌/.test(s)) return "brand";
  if (/数量|qty|quantity/.test(s)) return "qty";
  if (/批次|date\s*code|^dc$|d\/c/.test(s)) return "dateCode";
  if (/价格|单价|price|tp/.test(s)) return "price";
  if (/货期|交期|lead|lt/.test(s)) return "lt";
  if (/仓库|仓位|warehouse/.test(s)) return "warehouse";
  if (/客户|customer/.test(s)) return "customer";
  if (/渠道|供应商|vendor|supplier/.test(s)) return "channel";
  if (/封装|package|pkg/.test(s)) return "package";
  if (/成本|cost/.test(s)) return "cost";
  return null;
}

function tableToRows(table: string[][], kind: ImportKind): ImportRow[] {
  if (table.length === 0) return [];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(table.length, 8); i++) {
    const mapped = table[i].map(headerKey);
    if (mapped.includes("mpn")) {
      headerIdx = i;
      break;
    }
  }
  const headers = table[headerIdx].map(headerKey);
  const rows: ImportRow[] = [];
  for (const line of table.slice(headerIdx + 1)) {
    const get = (k: string) => {
      const i = headers.indexOf(k);
      return i >= 0 ? String(line[i] ?? "").trim() : "";
    };
    const mpn = displayMpn(get("mpn"));
    if (!mpn) continue;
    const cost = parseCost(get("price") || get("cost"));
    rows.push({
      id: nid(),
      kind: kind === "mixed" ? (get("customer") ? "inquiry" : get("warehouse") ? "stock" : "offer") : kind,
      mpn,
      brand: get("brand") ? brandShort(get("brand")) : null,
      qty: parseQty(get("qty")),
      qtyRaw: get("qty") || null,
      dateCode: get("dateCode") || null,
      priceAmount: cost.amount,
      priceCurrency: cost.currency,
      priceTax: cost.tax,
      isTp: cost.isTp || /tp/i.test(get("price")),
      leadTimeText: get("lt") || null,
      etaText: get("lt") || null,
      warehouse: resolveWarehouseCode(get("warehouse")) || null,
      channel: get("channel") || null,
      customer: get("customer") || null,
      package: get("package") || null,
      standardPack: null,
      packState: null,
      costAmount: cost.amount,
      costCurrency: cost.currency,
      costTax: cost.tax,
      note: line.filter(Boolean).join(" | "),
      duplicate: false,
      duplicateReason: null,
      selected: true,
      warning: null,
    });
  }
  return rows;
}

function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => line.split(/[,	]/).map((c) => c.trim().replace(/^"|"$/g, "")));
}

async function parseExcel(base64: string): Promise<string[][]> {
  const XLSX = await import("xlsx");
  const buf = Buffer.from(base64, "base64");
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: false });
  return json.map((row) => (row ?? []).map((c) => String(c ?? "").trim()));
}

async function aiExtract(opts: {
  text?: string;
  imageDataUrl?: string;
  kind: ImportKind;
}): Promise<ImportRow[] | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;
  const sys = `你是电子元器件现货贸易录入助手。从用户提供的渠道推货/客户询价/库存/在途文本或截图中抽取结构化记录。
硬规则：
1. 型号（MPN）字符必须原样复制，禁止改写、补全、猜测。只允许去掉首尾空格。
2. 数量转成整数：10K=10000，1万=10000。
3. 批次是 Date Code（如 2418、24+），不是 Lot Number。
4. 无价格、要求对方报目标价 → isTp=true。不要发明我方报价。
5. 货期是 LT/交期，不是 AOT。香港仓=HK，板田=坂田。
6. 不要猜测车规/军工等级。
只返回 JSON：{"kind":"offer|inquiry|stock|transit|mixed","rows":[{...}]}
每行字段：kind,mpn,brand,qty,dateCode,priceAmount,priceCurrency(USD|CNY),priceTax(none|exclusive|inclusive),isTp,leadTimeText,etaText,warehouse,channel,customer,package,standardPack,packState(full|loose|mixed),costAmount,costCurrency,costTax,note`;

  const userContent: unknown[] = [
    {
      type: "text",
      text: `默认类型: ${opts.kind}\n${opts.text ? `文本:\n${correctTradeText(opts.text).slice(0, 8000)}` : "见图片"}`,
    },
  ];
  if (opts.imageDataUrl) {
    userContent.push({ type: "image_url", image_url: { url: opts.imageDataUrl } });
  }

  let res: Response;
  try {
    res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: "grok-4.5",
        temperature: 0,
        max_tokens: 3500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: userContent },
        ],
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const raw = body.choices[0]?.message.content ?? "";
  try {
    const parsed = JSON.parse(raw) as { rows?: Record<string, unknown>[] };
    const rows = (parsed.rows ?? []).map((r) => {
      const mpn = displayMpn(String(r.mpn ?? ""));
      const cost = parseCost(
        r.priceAmount != null ? String(r.priceAmount) : r.costAmount != null ? String(r.costAmount) : "",
      );
      const qty = typeof r.qty === "number" ? r.qty : parseQty(String(r.qty ?? ""));
      return {
        id: nid(),
        kind: (["offer", "inquiry", "stock", "transit"].includes(String(r.kind))
          ? r.kind
          : opts.kind === "mixed"
            ? "offer"
            : opts.kind) as ImportKind,
        mpn,
        brand: r.brand ? brandShort(String(r.brand)) : null,
        qty,
        qtyRaw: r.qty != null ? String(r.qty) : null,
        dateCode: r.dateCode ? String(r.dateCode) : null,
        priceAmount: r.priceAmount != null ? Number(r.priceAmount) : cost.amount,
        priceCurrency: (r.priceCurrency as ImportRow["priceCurrency"]) ?? cost.currency,
        priceTax: (r.priceTax as ImportRow["priceTax"]) ?? cost.tax,
        isTp: Boolean(r.isTp) || cost.isTp,
        leadTimeText: r.leadTimeText ? String(r.leadTimeText) : null,
        etaText: r.etaText ? String(r.etaText) : r.leadTimeText ? String(r.leadTimeText) : null,
        warehouse: resolveWarehouseCode(r.warehouse ? String(r.warehouse) : null),
        channel: r.channel ? String(r.channel) : null,
        customer: r.customer ? String(r.customer) : null,
        package: r.package ? String(r.package) : null,
        standardPack: r.standardPack ? String(r.standardPack) : null,
        packState: (r.packState as ImportRow["packState"]) ?? null,
        costAmount: r.costAmount != null ? Number(r.costAmount) : cost.amount,
        costCurrency: (r.costCurrency as ImportRow["costCurrency"]) ?? cost.currency,
        costTax: (r.costTax as ImportRow["costTax"]) ?? cost.tax,
        note: r.note ? String(r.note) : null,
        duplicate: false,
        duplicateReason: null,
        selected: Boolean(mpn),
        warning: mpn ? null : "缺少型号",
      } satisfies ImportRow;
    });
    return rows.filter((r) => r.mpn);
  } catch {
    return null;
  }
}

function flagIntraFileDuplicates(rows: ImportRow[]) {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const k = [
      row.kind,
      normalizeMpn(row.mpn),
      row.qty ?? "",
      row.dateCode ?? "",
      row.channel ?? "",
      row.customer ?? "",
      row.isTp ? "tp" : (row.priceAmount ?? ""),
    ].join("|");
    if (seen.has(k)) {
      row.duplicate = true;
      row.duplicateReason = "本表内重复行";
      row.selected = false;
    } else {
      seen.set(k, 1);
    }
  }
}

async function markDuplicates(sql: Awaited<ReturnType<typeof sqlClient>>, rows: ImportRow[]) {
  flagIntraFileDuplicates(rows);
  for (const row of rows) {
    if (row.duplicate) continue;
    const key = normalizeMpn(row.mpn);
    const part = await sql`select id from parts where mpn_key = ${key} limit 1`;
    if (!part[0]) continue;
    const partId = String(part[0].id);
    if (row.kind === "offer") {
      const chName = row.channel ?? "";
      const hits = await sql`
        select o.id from channel_offers o
        join channels ch on ch.id = o.channel_id
        where o.part_id = ${partId} and o.deleted_at is null
          and o.offered_at >= now() - (${DUPLICATE_OFFER_HOURS} || ' hours')::interval
          and coalesce(o.qty, -1) = coalesce(${row.qty}, -1)
          and coalesce(o.date_code,'') = coalesce(${row.dateCode ?? ""}, '')
          and o.is_tp = ${row.isTp}
          and coalesce(o.price_amount, -1) = coalesce(${row.priceAmount ?? null}, -1)
          and (${chName} = '' or ch.name = ${chName})
        limit 3
      `;
      if (hits.length > 0) {
        row.duplicate = true;
        row.duplicateReason = `疑似重复：同渠道同型号近 ${DUPLICATE_OFFER_HOURS}h 已有推货`;
        row.selected = false;
      }
    }
    if (row.kind === "inquiry") {
      const cuName = row.customer ?? "";
      const hits = await sql`
        select i.id from customer_inquiries i
        join customers c on c.id = i.customer_id
        where i.part_id = ${partId} and i.deleted_at is null
          and i.inquired_at >= now() - (${DUPLICATE_INQUIRY_HOURS} || ' hours')::interval
          and coalesce(i.qty, -1) = coalesce(${row.qty}, -1)
          and (${cuName} = '' or c.name = ${cuName})
        limit 3
      `;
      if (hits.length > 0) {
        row.duplicate = true;
        row.duplicateReason = `疑似重复：同客户同型号近 ${DUPLICATE_INQUIRY_HOURS}h 已有询价（若确为再次询价可勾选）`;
        row.selected = false;
      }
    }
  }
}

export const parseImport = createServerFn({ method: "POST" })
  .validator(
    (input: {
      kind: ImportKind;
      sourceType: ImportSource;
      text?: string;
      filename?: string;
      fileBase64?: string;
      mime?: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    await ensureSeed(sql);
    let rows: ImportRow[] = [];
    let usedAi = false;
    const text = data.text ? correctTradeText(data.text) : undefined;

    if (data.sourceType === "excel" && data.fileBase64) {
      const table = await parseExcel(data.fileBase64);
      rows = tableToRows(table, data.kind);
    } else if (data.sourceType === "csv" && (text || data.fileBase64)) {
      const raw = text ?? Buffer.from(data.fileBase64!, "base64").toString("utf8");
      rows = tableToRows(parseCsv(raw), data.kind);
    } else if (data.sourceType === "image" && data.fileBase64) {
      const mime = data.mime || "image/jpeg";
      const url = `data:${mime};base64,${data.fileBase64}`;
      const ai = await aiExtract({ imageDataUrl: url, kind: data.kind, text });
      if (ai && ai.length) {
        rows = ai;
        usedAi = true;
      }
    } else if (data.sourceType === "pdf" || data.sourceType === "word") {
      const heur = text ? heuristicParse(text, data.kind) : [];
      const ai = text ? await aiExtract({ text, kind: data.kind }) : null;
      if (ai && ai.length) {
        rows = ai;
        usedAi = true;
      } else {
        rows = heur;
      }
    } else {
      const t = text ?? "";
      rows = heuristicParse(t, data.kind);
      if (rows.length === 0) {
        const ai = await aiExtract({ text: t, kind: data.kind });
        if (ai && ai.length) {
          rows = ai;
          usedAi = true;
        }
      }
    }

    if (rows.length === 0 && text) rows = heuristicParse(text, data.kind);

    await markDuplicates(sql, rows);
    const warehouses = await listWarehouses(sql);
    const channels = await sql`select id, name from channels order by name`;
    const customers = await sql`select id, name from customers order by name`;
    return {
      rows,
      usedAi,
      aiAvailable: Boolean(process.env.XAI_API_KEY),
      warehouses,
      channels: channels.map((r) => ({ id: String(r.id), name: String(r.name) })),
      customers: customers.map((r) => ({ id: String(r.id), name: String(r.name) })),
    };
  });

export const confirmImport = createServerFn({ method: "POST" })
  .validator(
    (input: {
      kind: ImportKind;
      sourceType: ImportSource;
      filename?: string;
      excerpt?: string;
      defaultChannel?: string;
      defaultCustomer?: string;
      defaultWarehouseId?: string;
      rows: ImportRow[];
    }) => input,
  )
  .handler(async ({ data }) => {
    const sql = await sqlClient();
    const selected = data.rows.filter((r) => r.selected && r.mpn);
    const warehouses = await listWarehouses(sql);
    for (const row of selected) {
      const kind = row.kind === "mixed" ? data.kind : row.kind;
      if (kind === "offer" && !(row.channel || data.defaultChannel)) {
        throw new Error(`${row.mpn} 缺少渠道`);
      }
      if (kind === "inquiry" && !(row.customer || data.defaultCustomer)) {
        throw new Error(`${row.mpn} 缺少客户`);
      }
      if (kind === "stock") {
        const wh =
          warehouses.find((w) => w.code === row.warehouse) ??
          warehouses.find((w) => w.id === data.defaultWarehouseId);
        if (!wh) throw new Error(`${row.mpn} 缺少仓库`);
        if ((row.qty ?? 0) <= 0) throw new Error(`${row.mpn} 入库数量无效`);
      }
      if (kind === "transit" && (row.qty ?? 0) <= 0) {
        throw new Error(`${row.mpn} 在途数量无效`);
      }
    }

    const batchId = nid();
    await sql`
      insert into import_batches (id, kind, source_type, filename, raw_excerpt)
      values (${batchId}, ${data.kind}, ${data.sourceType}, ${data.filename ?? null}, ${data.excerpt ?? null})
    `;

    const partIds: string[] = [];
    for (const row of selected) {
      const part = await ensurePart(sql, row.mpn, {
        brand: row.brand,
        package: row.package,
        source: "导入",
      });
      partIds.push(part.id);
    }
    const uniqueIds = [...new Set(partIds)];
    const flagsBefore = await matchFlagsForParts(sql, uniqueIds);

    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      const partId = partIds[i];
      const kind = row.kind === "mixed" ? data.kind : row.kind;

      if (kind === "offer") {
        const chName = row.channel || data.defaultChannel;
        if (!chName) throw new Error(`${row.mpn} 缺少渠道`);
        const ch = await ensureChannel(sql, chName);
        await sql`
          insert into channel_offers (
            id, channel_id, part_id, qty, date_code, price_amount, price_currency, price_tax,
            is_tp, lead_time_text, import_batch_id
          ) values (
            ${nid()}, ${ch.id}, ${partId}, ${row.qty}, ${row.dateCode},
            ${row.priceAmount}, ${row.priceCurrency}, ${row.priceTax},
            ${row.isTp}, ${row.leadTimeText}, ${batchId}
          )
        `;
      } else if (kind === "inquiry") {
        const cuName = row.customer || data.defaultCustomer;
        if (!cuName) throw new Error(`${row.mpn} 缺少客户`);
        const cu = await ensureCustomer(sql, cuName);
        await sql`
          insert into customer_inquiries (id, customer_id, part_id, qty, import_batch_id)
          values (${nid()}, ${cu.id}, ${partId}, ${row.qty}, ${batchId})
        `;
      } else if (kind === "stock") {
        const code = row.warehouse;
        const wh =
          warehouses.find((w) => w.code === code) ??
          warehouses.find((w) => w.id === data.defaultWarehouseId);
        if (!wh) throw new Error(`${row.mpn} 缺少仓库`);
        const lotId = nid();
        const qty = row.qty ?? 0;
        if (qty <= 0) throw new Error(`${row.mpn} 入库数量无效`);
        const supplier = row.channel ? await ensureChannel(sql, row.channel) : null;
        await sql`
          insert into stock_lots (
            id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
            standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id, import_batch_id
          ) values (
            ${lotId}, ${partId}, ${wh.id}, 'on_hand', ${qty}, ${qty}, ${row.dateCode},
            ${row.package}, ${row.standardPack}, ${row.packState},
            ${row.costAmount ?? row.priceAmount}, ${row.costCurrency ?? row.priceCurrency},
            ${row.costTax ?? row.priceTax}, ${supplier?.id ?? null}, ${batchId}
          )
        `;
        await sql`
          insert into stock_movements (id, part_id, lot_id, type, qty, to_warehouse_id, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'in', ${qty}, ${wh.id}, ${batchId})
        `;
      } else if (kind === "transit") {
        const qty = row.qty ?? 0;
        if (qty <= 0) throw new Error(`${row.mpn} 在途数量无效`);
        const parsed = parseLeadTime(row.etaText || row.leadTimeText || "");
        const lotId = nid();
        const supplier = row.channel ? await ensureChannel(sql, row.channel) : null;
        await sql`
          insert into stock_lots (
            id, part_id, status, qty_in, qty_remaining, date_code,
            cost_amount, cost_currency, cost_tax, supplier_id, ordered_at, eta_date, eta_text, eta_precision, import_batch_id
          ) values (
            ${lotId}, ${partId}, 'in_transit', ${qty}, ${qty}, ${row.dateCode},
            ${row.costAmount ?? row.priceAmount}, ${row.costCurrency ?? row.priceCurrency},
            ${row.costTax ?? row.priceTax}, ${supplier?.id ?? null}, now(), ${parsed.etaDate}, ${parsed.original || null},
            ${parsed.precision}, ${batchId}
          )
        `;
        await sql`
          insert into stock_movements (id, part_id, lot_id, type, qty, note, import_batch_id)
          values (${nid()}, ${partId}, ${lotId}, 'transit_open', ${qty}, ${row.etaText}, ${batchId})
        `;
      }
      await sql`update parts set updated_at = now() where id = ${partId}`;
    }

    const flagsAfter = await matchFlagsForParts(sql, uniqueIds);
    const trigger: ImportKind = data.kind === "mixed" ? "offer" : data.kind;
    const summary = {
      identified: selected.length,
      hit: uniqueIds.filter((id) => {
        const f = flagsBefore.get(id);
        return f ? isCrossHit(f, trigger) : false;
      }).length,
      stock: uniqueIds.filter((id) => flagsBefore.get(id)?.stock).length,
      inquiry: uniqueIds.filter((id) => (flagsBefore.get(id)?.inquiryCount ?? 0) > 0).length,
      dual: uniqueIds.filter((id) => flagsBefore.get(id)?.isDual).length,
      watch: uniqueIds.filter((id) => flagsBefore.get(id)?.watch).length,
    };
    const hitParts = uniqueIds.map((id) => {
      const f = flagsAfter.get(id)!;
      return {
        partId: id,
        flags: f,
        stockLine: formatStockLine(f.byWarehouse, f.inTransit, f.transitEtaLabel),
      };
    });
    return { batchId, summary, hitParts };
  });
