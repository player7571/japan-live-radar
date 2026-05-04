alter table public.event_alerts
  add column if not exists contact_email text;

create index if not exists event_alerts_contact_email_idx
on public.event_alerts (contact_email)
where contact_email is not null;
