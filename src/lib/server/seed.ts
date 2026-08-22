import type { Sql } from "@/lib/db";
import { nid } from "./helpers";

function ago(days: number, hours = 0): string {
  return new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString();
}
function ahead(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export async function ensureSeed(sql: Sql): Promise<void> {
  await sql`insert into app_settings (key, value) values
    ('inquiry_window_days', '90'),
    ('offer_window_days', '30')
    on conflict (key) do nothing`;

  await sql`insert into warehouses (id, code, name, sort_order) values
    ('wh_hk', 'HK', '香港', 1),
    ('wh_jt', '交通', '交通', 2),
    ('wh_bt', '坂田', '坂田', 3)
    on conflict (id) do nothing`;

  const rows = await sql<{ n: number }>`select count(*)::int as n from parts`;
  if ((rows[0]?.n ?? 0) > 0) return;

  await sql`insert into brands (code, full_name, aliases) values
    ('TI', 'Texas Instruments', '德州仪器,TEXAS INSTRUMENTS'),
    ('ST', 'STMicroelectronics', '意法,STM'),
    ('NXP', 'NXP', '恩智浦'),
    ('ADI', 'Analog Devices', '亚德诺'),
    ('Nordic', 'Nordic Semiconductor', '北欧'),
    ('Espressif', 'Espressif', '乐鑫'),
    ('Microchip', 'Microchip', '微芯,ATMEL'),
    ('Winbond', 'Winbond', '华邦'),
    ('MPS', 'Monolithic Power Systems', '芯源'),
    ('ON', 'onsemi', '安森美')
    on conflict (code) do nothing`;

  const parts: Array<Record<string, string | null>> = [
    {
      id: "p_tps",
      key: "TPS7A4700RGWR",
      mpn: "TPS7A4700RGWR",
      brand: "TI",
      cat: "LDO",
      pkg: "VQFN-20",
      desc: "低噪声 LDO，常用于高精度模拟与时钟供电。",
      life: "Active",
      params: "Vin 3–36V · 1A · 4μVrms",
    },
    {
      id: "p_stm",
      key: "STM32F103C8T6",
      mpn: "STM32F103C8T6",
      brand: "ST",
      cat: "MCU",
      pkg: "LQFP-48",
      desc: "Cortex-M3 主流 MCU，工控与消费电子常见料。",
      life: "Active",
      params: "72MHz · 64KB Flash · 20KB RAM",
    },
    {
      id: "p_nrf",
      key: "NRF52840-QIAA",
      mpn: "NRF52840-QIAA",
      brand: "Nordic",
      cat: "BLE SoC",
      pkg: "aQFN-73",
      desc: "蓝牙 5 / Thread / Zigbee 多协议 SoC。",
      life: "Active",
      params: "64MHz · 1MB Flash · USB",
    },
    {
      id: "p_esp",
      key: "ESP32-WROOM-32E",
      mpn: "ESP32-WROOM-32E",
      brand: "Espressif",
      cat: "模组",
      pkg: "Module",
      desc: "Wi-Fi + BLE 模组，量产通信方案常用。",
      life: "Active",
      params: "4MB Flash 常见配置",
    },
    {
      id: "p_lm",
      key: "LM2596S-5.0",
      mpn: "LM2596S-5.0",
      brand: "TI",
      cat: "DCDC",
      pkg: "TO-263",
      desc: "5V 降压开关电源，大电流供电常见。",
      life: "NRND",
      params: "4.5–40V in · 3A · 5V out",
    },
    {
      id: "p_ads",
      key: "ADS1115IDGSR",
      mpn: "ADS1115IDGSR",
      brand: "TI",
      cat: "ADC",
      pkg: "VSSOP-10",
      desc: "16-bit I2C ADC，传感器采集常用。",
      life: "Active",
      params: "4ch · PGA · 860SPS",
    },
    {
      id: "p_atm",
      key: "ATMEGA328P-AU",
      mpn: "ATMEGA328P-AU",
      brand: "Microchip",
      cat: "MCU",
      pkg: "TQFP-32",
      desc: "8-bit AVR，Arduino 生态核心料。",
      life: "Active",
      params: "20MHz · 32KB Flash",
    },
    {
      id: "p_w25",
      key: "W25Q128JVSIQ",
      mpn: "W25Q128JVSIQ",
      brand: "Winbond",
      cat: "Flash",
      pkg: "SOIC-8",
      desc: "128Mbit SPI NOR Flash。",
      life: "Active",
      params: "2.7–3.6V · 133MHz",
    },
    {
      id: "p_sn74",
      key: "SN74LVC245APWR",
      mpn: "SN74LVC245APWR",
      brand: "TI",
      cat: "逻辑",
      pkg: "TSSOP-20",
      desc: "8 位总线收发器。",
      life: "Active",
      params: "1.65–3.6V",
    },
    {
      id: "p_bq",
      key: "BQ24610RGER",
      mpn: "BQ24610RGER",
      brand: "TI",
      cat: "充电",
      pkg: "VQFN-24",
      desc: "开关模式锂电池充电控制器。",
      life: "Active",
      params: "SMBus · 同步 buck",
    },
    {
      id: "p_tlv",
      key: "TLV62568DBVR",
      mpn: "TLV62568DBVR",
      brand: "TI",
      cat: "DCDC",
      pkg: "SOT-23-5",
      desc: "1A 同步降压转换器。",
      life: "Active",
      params: "2.5–5.5V in",
    },
    {
      id: "p_usb",
      key: "USB3320C-EZK",
      mpn: "USB3320C-EZK",
      brand: "Microchip",
      cat: "USB PHY",
      pkg: "QFN-32",
      desc: "Hi-Speed USB 2.0 ULPI PHY。",
      life: "Active",
      params: "ULPI · 60MHz",
    },
  ];

  for (const p of parts) {
    await sql`
      insert into parts (id, mpn_key, mpn, brand_code, category, package, description, lifecycle, params, source)
      values (${p.id}, ${p.key}, ${p.mpn}, ${p.brand}, ${p.cat}, ${p.pkg}, ${p.desc}, ${p.life}, ${p.params}, ${"种子"})
    `;
  }

  await sql`insert into channels (id, name) values
    ('ch_sxd', '深迅达'),
    ('ch_kxs', '科芯盛'),
    ('ch_by', '北原电子'),
    ('ch_gy', '港亚半导体')`;

  await sql`insert into customers (id, name) values
    ('cu_xl', '星澜科技'),
    ('cu_mk', '迈科智造'),
    ('cu_hb', '瀚博微'),
    ('cu_lc', '联测电子'),
    ('cu_qh', '启航电源')`;

  // lots
  const lots = [
    {
      id: "lot_tps_hk",
      part: "p_tps",
      wh: "wh_hk",
      st: "on_hand",
      qin: 12000,
      q: 12000,
      dc: "2418",
      pkg: "VQFN-20",
      sp: "3K/盘",
      ps: "full",
      amt: "22.5",
      cur: "CNY",
      tax: "exclusive",
      sup: "ch_kxs",
      inb: ago(12),
    },
    {
      id: "lot_tps_jt",
      part: "p_tps",
      wh: "wh_jt",
      st: "on_hand",
      qin: 3000,
      q: 3000,
      dc: "2336",
      pkg: "VQFN-20",
      sp: "3K/盘",
      ps: "full",
      amt: "3.20",
      cur: "USD",
      tax: "none",
      sup: "ch_sxd",
      inb: ago(5),
    },
    {
      id: "lot_tps_bt",
      part: "p_tps",
      wh: "wh_bt",
      st: "on_hand",
      qin: 4000,
      q: 1000,
      dc: "2418",
      pkg: "VQFN-20",
      sp: "3K/盘",
      ps: "loose",
      amt: "22.5",
      cur: "CNY",
      tax: "exclusive",
      sup: "ch_kxs",
      inb: ago(10),
    },
    {
      id: "lot_tps_tr",
      part: "p_tps",
      wh: null,
      st: "in_transit",
      qin: 10000,
      q: 10000,
      dc: "2504",
      pkg: "VQFN-20",
      sp: "3K/盘",
      ps: "full",
      amt: "3.05",
      cur: "USD",
      tax: "none",
      sup: "ch_gy",
      inb: ago(4),
      ord: ago(14),
      eta: ahead(6),
      et: "8月底前",
      ep: "month",
    },
    {
      id: "lot_stm_tr",
      part: "p_stm",
      wh: null,
      st: "in_transit",
      qin: 5000,
      q: 5000,
      dc: "2440",
      pkg: "LQFP-48",
      sp: "1.5K/盘",
      ps: "full",
      amt: "1.05",
      cur: "USD",
      tax: "none",
      sup: "ch_by",
      inb: ago(8),
      ord: ago(8),
      eta: ahead(14),
      et: "LT 4周",
      ep: "week",
    },
    {
      id: "lot_nrf_hk",
      part: "p_nrf",
      wh: "wh_hk",
      st: "on_hand",
      qin: 2000,
      q: 2000,
      dc: "2440",
      pkg: "aQFN-73",
      sp: "2K/盘",
      ps: "full",
      amt: "18.6",
      cur: "CNY",
      tax: "exclusive",
      sup: "ch_sxd",
      inb: ago(20),
    },
    {
      id: "lot_lm_jt",
      part: "p_lm",
      wh: "wh_jt",
      st: "on_hand",
      qin: 8000,
      q: 8000,
      dc: "2312",
      pkg: "TO-263",
      sp: "1K/管",
      ps: "full",
      amt: "1.80",
      cur: "CNY",
      tax: "inclusive",
      sup: "ch_kxs",
      inb: ago(30),
    },
    {
      id: "lot_w25_hk",
      part: "p_w25",
      wh: "wh_hk",
      st: "on_hand",
      qin: 20000,
      q: 20000,
      dc: "2426",
      pkg: "SOIC-8",
      sp: "20K/盘",
      ps: "full",
      amt: "0.42",
      cur: "USD",
      tax: "none",
      sup: "ch_gy",
      inb: ago(18),
    },
    {
      id: "lot_ads_bt",
      part: "p_ads",
      wh: "wh_bt",
      st: "on_hand",
      qin: 1500,
      q: 1500,
      dc: "2408",
      pkg: "VSSOP-10",
      sp: "3K/盘",
      ps: "loose",
      amt: "9.8",
      cur: "CNY",
      tax: "exclusive",
      sup: "ch_by",
      inb: ago(9),
    },
  ];

  for (const l of lots) {
    await sql`
      insert into stock_lots (
        id, part_id, warehouse_id, status, qty_in, qty_remaining, date_code, package,
        standard_pack, pack_state, cost_amount, cost_currency, cost_tax, supplier_id,
        inbound_at, ordered_at, eta_date, eta_text, eta_precision
      ) values (
        ${l.id}, ${l.part}, ${l.wh ?? null}, ${l.st}, ${l.qin}, ${l.q}, ${l.dc}, ${l.pkg},
        ${l.sp}, ${l.ps}, ${l.amt}, ${l.cur}, ${l.tax}, ${l.sup},
        ${l.inb}, ${"ord" in l ? l.ord : null}, ${"eta" in l ? l.eta : null},
        ${"et" in l ? l.et : null}, ${"ep" in l ? l.ep : null}
      )
    `;
  }

  const mv = [
    ["m1", "p_tps", "lot_tps_hk", "in", 12000, null, "wh_hk", ago(12), null],
    ["m2", "p_tps", "lot_tps_bt", "in", 4000, null, "wh_bt", ago(10), null],
    ["m3", "p_tps", "lot_tps_jt", "transfer", 3000, "wh_bt", "wh_jt", ago(5), null],
    ["m4", "p_tps", "lot_tps_tr", "transit_open", 10000, null, null, ago(4), "港亚 在途"],
    ["m5", "p_nrf", "lot_nrf_hk", "in", 2000, null, "wh_hk", ago(20), null],
    ["m6", "p_lm", "lot_lm_jt", "in", 8000, null, "wh_jt", ago(30), null],
    ["m7", "p_w25", "lot_w25_hk", "in", 20000, null, "wh_hk", ago(18), null],
    ["m8", "p_ads", "lot_ads_bt", "in", 1500, null, "wh_bt", ago(9), null],
    ["m9", "p_stm", "lot_stm_tr", "transit_open", 5000, null, null, ago(8), "LT 4周"],
  ] as const;
  for (const m of mv) {
    await sql`
      insert into stock_movements (id, part_id, lot_id, type, qty, from_warehouse_id, to_warehouse_id, happened_at, note)
      values (${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4]}, ${m[5]}, ${m[6]}, ${m[7]}, ${m[8]})
    `;
  }

  // offers
  await sql`
    insert into channel_offers (id, channel_id, part_id, qty, date_code, price_amount, price_currency, price_tax, is_tp, lead_time_text, offered_at, is_valid) values
    ('of_tps_1', 'ch_kxs', 'p_tps', 20000, '24+', null, null, null, true, 'LT 4周', ${ago(0, 5)}, true),
    ('of_tps_2', 'ch_sxd', 'p_tps', 8000, '2418', 3.15, 'USD', 'none', false, '现货', ${ago(3)}, true),
    ('of_stm_1', 'ch_by', 'p_stm', 10000, '2440', 1.15, 'USD', 'none', false, '现货', ${ago(2)}, true),
    ('of_esp_1', 'ch_sxd', 'p_esp', 20000, null, null, null, null, true, 'LT 4周', ${ago(1)}, true),
    ('of_bq_1', 'ch_sxd', 'p_bq', 8000, '2502', null, null, null, true, 'LT 8周', ${ago(0, 3)}, true),
    ('of_sn74_old', 'ch_kxs', 'p_sn74', 25000, '2310', 0.18, 'USD', 'none', false, '现货', ${ago(40)}, false)
  `;
  await sql`update channel_offers set invalidated_at = ${ago(10)} where id = 'of_sn74_old'`;

  // inquiries
  await sql`
    insert into customer_inquiries (id, customer_id, part_id, qty, inquired_at, is_valid) values
    ('iq_tps_1', 'cu_xl', 'p_tps', 5000, ${ago(0, 2)}, true),
    ('iq_tps_2', 'cu_mk', 'p_tps', 3000, ${ago(4)}, true),
    ('iq_tps_3', 'cu_hb', 'p_tps', 10000, ${ago(11)}, true),
    ('iq_stm_1', 'cu_qh', 'p_stm', 4000, ${ago(6)}, true),
    ('iq_stm_2', 'cu_xl', 'p_stm', 2000, ${ago(15)}, true),
    ('iq_nrf_1', 'cu_hb', 'p_nrf', 1000, ${ago(2)}, true),
    ('iq_esp_1', 'cu_mk', 'p_esp', 10000, ${ago(0, 1)}, true),
    ('iq_esp_2', 'cu_hb', 'p_esp', 5000, ${ago(5)}, true),
    ('iq_sn74_1', 'cu_qh', 'p_sn74', 20000, ${ago(1)}, true),
    ('iq_w25_old', 'cu_lc', 'p_w25', 50000, ${ago(40)}, false)
  `;
  await sql`update customer_inquiries set invalidated_at = ${ago(20)} where id = 'iq_w25_old'`;

  await sql`insert into watchlist (part_id, note, added_at) values
    ('p_tps', '高频询价 + 自有库存', ${ago(20)}),
    ('p_nrf', '蓝牙项目跟料', ${ago(12)}),
    ('p_bq', '充电方案缺货观察', ${ago(3)})`;

  await sql`
    insert into op_logs (id, action, entity_type, entity_id, detail)
    values (${nid()}, 'seed', 'system', 'init', '演示数据已写入')
  `;
}
