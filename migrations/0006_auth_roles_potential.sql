-- Authentication-to-business authorization bridge.  Better Auth owns identity;
-- these tables own this application's role and business ownership.
create table if not exists app_users (
  user_id          text primary key references "user" ("id") on delete cascade,
  email            text not null,
  display_name     text not null,
  role             text check (role in ('老板', '最高督察', '主管', '跟进人')),
  potential_enabled boolean not null default false,
  status           text not null default 'active' check (status in ('active', 'disabled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table import_batches add column if not exists created_by text references "user" ("id");

create table if not exists potential_models (
  user_id    text not null references "user" ("id") on delete cascade,
  part_id    text not null references parts (id) on delete cascade,
  created_at timestamptz not null default now(),
  note       text,
  primary key (user_id, part_id)
);

create table if not exists identity_checks (
  session_key    text primary key,
  actor_user_id  text not null references "user" ("id") on delete cascade,
  target_user_id text not null references "user" ("id") on delete cascade,
  created_at     timestamptz not null default now()
);

create index if not exists app_users_role_status_idx on app_users (role, status);
create index if not exists potential_models_part_idx on potential_models (part_id, created_at desc);
create index if not exists identity_checks_actor_idx on identity_checks (actor_user_id);
