create extension if not exists pgcrypto;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_event_id text not null,
  artist text not null,
  title text not null,
  city text not null,
  venue text not null,
  date date not null,
  time text,
  genre text,
  ticket_access text not null default '확인 필요'
    check (ticket_access in ('한국 구매 가능', '일본 번호 필요', '확인 필요')),
  sale_type text not null default '일반 판매'
    check (sale_type in ('추첨 접수', '일반 판매', '선착 판매', '해외 판매', '리세일')),
  sale_window text,
  price text,
  phone_required boolean not null default false,
  foreigner_note text,
  link text,
  image text,
  country_code char(2) not null default 'JP',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_event_id)
);

create index if not exists events_country_date_idx on public.events (country_code, date);
create index if not exists events_city_date_idx on public.events (city, date);
create index if not exists events_artist_search_idx on public.events using gin (to_tsvector('simple', artist || ' ' || title || ' ' || venue));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_events_updated_at on public.events;
create trigger set_events_updated_at
before update on public.events
for each row
execute function public.set_updated_at();

alter table public.events enable row level security;

drop policy if exists "Events are publicly readable" on public.events;
create policy "Events are publicly readable"
on public.events
for select
using (true);
