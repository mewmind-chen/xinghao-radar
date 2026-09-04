alter table import_batches add column if not exists submission_id text;
alter table import_batches add column if not exists status text not null default 'success';
alter table import_batches add column if not exists result_json text;
alter table import_batches add column if not exists error_message text;

create unique index if not exists import_batches_submission_id_uq
  on import_batches (submission_id)
  where submission_id is not null;

create index if not exists import_batches_status_idx on import_batches (status, created_at desc);
