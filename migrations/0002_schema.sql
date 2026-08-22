-- 型号雷达 schema
-- First principles: one part master (MPN) ; unlimited events ; invalid ≠ delete ;
-- inventory is a ledger (never "invalidated") ; in-transit is not a warehouse.

create table if not exists app_settings (
  key   text primary key,
  value text not null
);

create table if not exists warehouses (
  id         text primary key,
  code       text not null unique,
  name       text not null,
  sort_order integer not null default 0,
  is_active  boolean not null default true
);

create table if not exists brands (
  code      text primary key,
  full_name text not null,
  aliases   text not null default ''
);

create table if not exists parts (
  id          text primary key,
  mpn_key     text not null unique,
  mpn         text not null,
  brand_code  text,
  category    text,
  package     text,
  description text,
  lifecycle   text,
  params      text,
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists channels (
  id         text primary key,
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists customers (
  id         text primary key,
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists import_batches (
  id           text primary key,
  kind         text not null,
  source_type  text not null,
  filename     text,
  raw_excerpt  text,
  created_at   timestamptz not null default now(),
  undone_at    timestamptz
);

create table if not exists stock_lots (
  id              text primary key,
  part_id         text not null references parts(id),
  warehouse_id    text references warehouses(id),
  status          text not null,
  qty_in          integer not null,
  qty_remaining   integer not null,
  date_code       text,
  package         text,
  standard_pack   text,
  pack_state      text,
  cost_amount     numeric(14,4),
  cost_currency   text,
  cost_tax        text,
  supplier_id     text references channels(id),
  inbound_at      timestamptz not null default now(),
  ordered_at      timestamptz,
  eta_date        date,
  eta_text        text,
  eta_precision   text,
  import_batch_id text references import_batches(id),
  deleted_at      timestamptz
);

create table if not exists stock_movements (
  id                text primary key,
  part_id           text not null references parts(id),
  lot_id            text references stock_lots(id),
  type              text not null,
  qty               integer not null,
  from_warehouse_id text references warehouses(id),
  to_warehouse_id   text references warehouses(id),
  happened_at       timestamptz not null default now(),
  note              text,
  import_batch_id   text references import_batches(id),
  deleted_at        timestamptz
);

create table if not exists channel_offers (
  id              text primary key,
  channel_id      text not null references channels(id),
  part_id         text not null references parts(id),
  qty             integer,
  date_code       text,
  price_amount    numeric(14,4),
  price_currency  text,
  price_tax       text,
  is_tp           boolean not null default false,
  lead_time_text  text,
  offered_at      timestamptz not null default now(),
  is_valid        boolean not null default true,
  invalidated_at  timestamptz,
  import_batch_id text references import_batches(id),
  deleted_at      timestamptz
);

create table if not exists customer_inquiries (
  id              text primary key,
  customer_id     text not null references customers(id),
  part_id         text not null references parts(id),
  qty             integer,
  inquired_at     timestamptz not null default now(),
  is_valid        boolean not null default true,
  invalidated_at  timestamptz,
  import_batch_id text references import_batches(id),
  deleted_at      timestamptz
);

create table if not exists watchlist (
  part_id  text primary key references parts(id),
  note     text,
  added_at timestamptz not null default now()
);

create table if not exists op_logs (
  id          text primary key,
  action      text not null,
  entity_type text not null,
  entity_id   text not null,
  detail      text,
  created_at  timestamptz not null default now()
);

create index if not exists parts_mpn_key_idx on parts (mpn_key);
create index if not exists parts_brand_idx on parts (brand_code);
create index if not exists lots_part_status_idx on stock_lots (part_id, status);
create index if not exists lots_wh_idx on stock_lots (warehouse_id, status);
create index if not exists offers_part_valid_idx on channel_offers (part_id, is_valid, offered_at desc);
create index if not exists inquiries_part_valid_idx on customer_inquiries (part_id, is_valid, inquired_at desc);
create index if not exists movements_part_idx on stock_movements (part_id, happened_at desc);
create index if not exists offers_channel_idx on channel_offers (channel_id, offered_at desc);
create index if not exists inquiries_customer_idx on customer_inquiries (customer_id, inquired_at desc);
