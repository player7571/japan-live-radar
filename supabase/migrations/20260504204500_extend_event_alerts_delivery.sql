alter table public.event_alerts
  add column if not exists last_sent_at timestamptz,
  add column if not exists send_count integer not null default 0,
  add column if not exists last_error text;

alter table public.event_alerts
  drop constraint if exists event_alerts_status_check;

alter table public.event_alerts
  add constraint event_alerts_status_check
  check (status in ('active', 'sent', 'cancelled', 'error'));

create index if not exists event_alerts_due_idx
on public.event_alerts (status, remind_at)
where remind_at is not null;
