create table if not exists late_submissions (
  id           bigint generated always as identity primary key,
  real_name    text not null,
  week_number  integer not null,
  created_at   timestamptz default now(),
  unique (real_name, week_number)
);
