alter table public.event_alerts
  add column if not exists remind_before_hours integer not null default 3
  check (remind_before_hours in (3, 24, 72));
