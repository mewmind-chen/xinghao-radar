alter table potential_models add column if not exists import_batch_id text references import_batches(id);

create index if not exists potential_models_import_batch_idx
  on potential_models (import_batch_id)
  where import_batch_id is not null;
