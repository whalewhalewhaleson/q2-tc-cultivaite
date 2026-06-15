-- 012_user_scoring_flag.sql
-- Adds a per-user "scoring" flag. When false, the member keeps every bot feature
-- (reflect, send/receive good news, nudges, their own /mystats + mini-app stats)
-- but is excluded from ALL aggregates: company total points, rankings/leaderboard,
-- department points + average, the Q2 quarter goal / cumulative target, submission-rate
-- denominators, and the dept 4-week 100% bonus.
--
-- Implementation: buildStatsCache() in db.js keeps non-scoring members in statsMap
-- (so their personal view still computes) but filters them out of `sorted`,
-- `deptMembers`, and `deptWeekRate`. Existing rows default to true (unchanged behaviour).

alter table public.users add column if not exists scoring boolean not null default true;

comment on column public.users.scoring is 'When false, member has full bot features (reflect, good news, nudges, own stats) but is excluded from all aggregates: company total, rankings, dept points/avg, Q2 goal, submission-rate denominators, dept bonus. See db.js buildStatsCache nonScoring set.';
