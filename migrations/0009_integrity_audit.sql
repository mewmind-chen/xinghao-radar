-- PR13: durable audit context, normalized market identities, and recoverable
-- import reservations. Existing rows are retained; duplicate normalized names
-- deliberately make this migration fail closed so they can be reviewed before
-- production is migrated rather than being silently merged.

alter table op_logs add column if not exists actor_user_id text;
alter table op_logs add column if not exists actor_name text;
alter table op_logs add column if not exists effective_user_id text;
alter table op_logs add column if not exists effective_name text;
alter table op_logs add column if not exists outcome text not null default 'success';
alter table op_logs add column if not exists before_json text;
alter table op_logs add column if not exists after_json text;
alter table op_logs add column if not exists failure_reason text;
alter table op_logs add column if not exists request_id text;
alter table op_logs add column if not exists import_batch_id text references import_batches(id);

alter table channels add column if not exists name_key text;
alter table customers add column if not exists name_key text;

update channels set name_key = lower(trim(name)) where name_key is null;
update customers set name_key = lower(trim(name)) where name_key is null;

alter table channels alter column name_key set not null;
alter table customers alter column name_key set not null;

create unique index if not exists channels_name_key_uq on channels (name_key);
create unique index if not exists customers_name_key_uq on customers (name_key);

alter table import_batches add column if not exists writing_started_at timestamptz;
alter table import_batches add column if not exists finished_at timestamptz;

create index if not exists op_logs_created_at_idx on op_logs (created_at desc);
create index if not exists op_logs_actor_idx on op_logs (actor_user_id, created_at desc);
create index if not exists op_logs_entity_idx on op_logs (entity_type, entity_id, created_at desc);
create index if not exists import_batches_writing_idx on import_batches (status, writing_started_at);
