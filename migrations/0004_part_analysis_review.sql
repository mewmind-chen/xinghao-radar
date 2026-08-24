-- Human decision record for a platform part analysis.
-- Radar owns the final business decision; the Agent Platform never writes it.
-- Each row is one reviewer decision against a saved analysis (by mpn_key).
create table if not exists part_analysis_reviews (
  mpn_key text primary key,
  mpn text not null,
  decision text not null check (decision in ('accept', 'reject', 'corrected')),
  reviewed_at timestamptz not null default now(),
  reviewer text,
  note text,
  corrected_json text
);

create index if not exists part_analysis_reviews_reviewed_at_idx on part_analysis_reviews (reviewed_at desc);