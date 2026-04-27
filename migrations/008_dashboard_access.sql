create table if not exists dashboard_access (
  user_id text primary key,
  name    text not null,
  granted_by text not null,
  created_at timestamptz default now()
);
