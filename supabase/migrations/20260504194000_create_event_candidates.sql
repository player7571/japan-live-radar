create table if not exists public.event_candidates (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'Imported URL',
  source_url text,
  draft jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text,
  approved_event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_url)
);

create index if not exists event_candidates_status_created_idx
on public.event_candidates (status, created_at desc);

drop trigger if exists set_event_candidates_updated_at on public.event_candidates;
create trigger set_event_candidates_updated_at
before update on public.event_candidates
for each row
execute function public.set_updated_at();

alter table public.event_candidates enable row level security;
