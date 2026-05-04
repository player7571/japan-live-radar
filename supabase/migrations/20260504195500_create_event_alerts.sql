create table if not exists public.event_alerts (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  event_key text not null,
  event_snapshot jsonb not null,
  channel text not null default 'browser'
    check (channel in ('browser', 'email')),
  status text not null default 'active'
    check (status in ('active', 'cancelled')),
  remind_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, event_key)
);

create index if not exists event_alerts_status_remind_idx
on public.event_alerts (status, remind_at);

drop trigger if exists set_event_alerts_updated_at on public.event_alerts;
create trigger set_event_alerts_updated_at
before update on public.event_alerts
for each row
execute function public.set_updated_at();

alter table public.event_alerts enable row level security;
