create table if not exists recap_announcement (
  id int primary key default 1,
  text text,
  updated_at timestamptz default now(),
  updated_by text,
  constraint single_row check (id = 1)
);

insert into recap_announcement (id, text) values (1, null) on conflict (id) do nothing;
