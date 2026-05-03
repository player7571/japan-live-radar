create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  status text not null check (status in ('success', 'error')),
  fetched_count integer not null default 0,
  upserted_count integer not null default 0,
  skipped_count integer not null default 0,
  message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now()
);

create index if not exists sync_runs_source_finished_idx on public.sync_runs (source, finished_at desc);

alter table public.sync_runs enable row level security;

drop policy if exists "Sync runs are publicly readable" on public.sync_runs;
create policy "Sync runs are publicly readable"
on public.sync_runs
for select
using (true);
