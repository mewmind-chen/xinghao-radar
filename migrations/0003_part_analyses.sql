-- Durable analysis cache shared by deployed Postgres and local PGLite.
-- Analysis is a Radar-owned result artifact, keyed by normalized MPN; it does
-- not alter the part master, inventory ledger, inquiry records, or decisions.
create table if not exists part_analyses (
  mpn_key text primary key,
  mpn text not null,
  analyzed_at timestamptz not null,
  source_url text,
  analysis text not null
);

create index if not exists part_analyses_analyzed_at_idx on part_analyses (analyzed_at desc);
