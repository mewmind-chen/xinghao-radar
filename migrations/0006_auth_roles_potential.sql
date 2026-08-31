-- Authentication-to-business authorization bridge.  Better Auth owns identity;
-- these tables own this application's role and business ownership.
create table if not exists app_users (
  user_id          text primary key references "user" ("id") on delete cascade,
  email            text not null,
  display_name     text not null,
  role             text check (role in ('老板', '最高督察', '主管', '跟进人')),
  status           text not null default 'active' check (status in ('active', 'disabled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 四个固定角色各自拥有唯一、同名的权限组。用户只保存 role，不能选择权限组。
create table if not exists permission_groups (
  role_key         text primary key check (role_key in ('boss', 'inspector', 'manager', 'follower')),
  display_name     text not null unique check (display_name in ('老板权限组', '最高督察权限组', '主管权限组', '跟进人权限组')),
  permissions      text[] not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

insert into permission_groups (role_key, display_name, permissions) values
  ('boss', '老板权限组', ARRAY[
    'model.read', 'model.write', 'stock.read', 'stock.write', 'inventory.import',
    'market.read', 'market.write', 'potential.read', 'potential.write', 'settings.manage',
    'users.manage', 'identity.check', 'logs.read', 'analysis.read', 'analysis.write'
  ]),
  ('inspector', '最高督察权限组', ARRAY[
    'model.read', 'stock.read', 'market.read', 'potential.read', 'potential.write', 'analysis.read'
  ]),
  ('manager', '主管权限组', ARRAY[
    'model.read', 'stock.read', 'market.read', 'market.write', 'potential.read', 'potential.write', 'analysis.read'
  ]),
  ('follower', '跟进人权限组', ARRAY[
    'model.read', 'stock.read', 'stock.write', 'inventory.import', 'analysis.read'
  ])
on conflict (role_key) do nothing;

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
create index if not exists permission_groups_updated_idx on permission_groups (updated_at desc);
create index if not exists potential_models_part_idx on potential_models (part_id, created_at desc);
create index if not exists identity_checks_actor_idx on identity_checks (actor_user_id);
