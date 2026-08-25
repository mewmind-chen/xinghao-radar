-- Inventory operations need an explicit lot lineage. A transfer or a transit
-- receipt creates a new warehouse lot but keeps the original batch.
alter table stock_lots add column if not exists source_lot_id text references stock_lots(id);
alter table stock_lots add column if not exists origin_lot_id text references stock_lots(id);
alter table stock_movements add column if not exists source_lot_id text references stock_lots(id);

update stock_lots
set origin_lot_id = id
where origin_lot_id is null;

create index if not exists lots_origin_idx on stock_lots (origin_lot_id);
create index if not exists movements_lot_source_idx on stock_movements (lot_id, source_lot_id);
