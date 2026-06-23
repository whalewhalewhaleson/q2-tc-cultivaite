-- 013_point_adjustments.sql
-- Manual one-off point adjustments (bonuses) that are not weekly submissions or
-- Good News. Each row credits `pts` to a member (matched by users.real_name) and
-- is summed straight onto their totalPoints in buildStatsCache() — affecting rank,
-- garden stage, leaderboard and dept totals like any other points. Not surfaced in
-- any per-user breakdown by design (silent bump). Reversible: delete the rows.
-- First use: Q1/Q2 performance-review self-reflection survey completion credit.

create table if not exists public.point_adjustments (
  id          bigint generated always as identity primary key,
  real_name   text not null,
  pts         integer not null,
  reason      text,
  created_at  timestamptz not null default now()
);

-- Bot connects with the service-role key, which bypasses RLS. Enable RLS with no
-- policies so the table is NOT readable/writable via the public anon key.
alter table public.point_adjustments enable row level security;

comment on table public.point_adjustments is 'Manual one-off point bonuses (e.g. survey-completion credit). Summed onto totalPoints in db.js buildStatsCache via adjustBonus. Reversible by deleting rows.';
