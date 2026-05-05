alter table public.events
  drop constraint if exists events_sale_type_check;

alter table public.events
  add constraint events_sale_type_check
  check (sale_type in ('추첨 접수', '일반 판매', '선착 판매', '해외 판매', '리세일'));
