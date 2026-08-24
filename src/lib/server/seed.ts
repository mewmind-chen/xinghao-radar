/**
 * 种子数据 —— 仅基础字典（业务数据从零开始，由真实导入填充）。
 *
 * 曾自动灌入演示型号/渠道/客户/库存等（demo），现已移除：
 * 用户进入真实录入阶段，库存、推货、询价等一律来自真实数据，
 * 系统不再带回任何示例业务行。
 */

import type { Sql } from "@/lib/db";

export async function ensureSeed(sql: Sql): Promise<void> {
  // 默认匹配窗口（可被设置页覆盖）
  await sql`insert into app_settings (key, value) values
    ('inquiry_window_days', '90'),
    ('offer_window_days', '30')
    on conflict (key) do nothing`;

  // 默认仓库字典
  await sql`insert into warehouses (id, code, name, sort_order) values
    ('wh_hk', 'HK', '香港', 1),
    ('wh_jt', '交通', '交通', 2),
    ('wh_bt', '坂田', '坂田', 3)
    on conflict (id) do nothing`;

  // 品牌字典（型号分析/表单归一用）
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

  // 无任何演示业务数据；parts/channels/customers/lots/offers/inquiries
  // /watchlist/op_logs 全部由真实录入与导入生成。
}