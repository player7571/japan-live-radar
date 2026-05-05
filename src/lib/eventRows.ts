import type { City, Event, SaleType, TicketAccess } from "../types/events";

export type EventRow = {
  id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string | null;
  genre: string | null;
  source: string;
  ticket_access: string;
  sale_type: string;
  sale_window: string | null;
  price: string | null;
  phone_required: boolean | null;
  foreigner_note: string | null;
  link: string | null;
  image: string | null;
};

const ticketAccessFallback: TicketAccess = "확인 필요";
const saleTypeFallback: SaleType = "일반 판매";

function toCity(value: string): City {
  const normalized = value.trim();
  return normalized || "도시 미정";
}

function toTicketAccess(value: string): TicketAccess {
  if (value === "한국 구매 가능" || value === "일본 번호 필요" || value === "확인 필요") {
    return value;
  }
  return ticketAccessFallback;
}

function toSaleType(value: string): SaleType {
  if (
    value === "추첨 접수" ||
    value === "일반 판매" ||
    value === "선착 판매" ||
    value === "해외 판매" ||
    value === "리세일"
  ) {
    return value;
  }
  return saleTypeFallback;
}

export function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    artist: row.artist,
    title: row.title,
    city: toCity(row.city),
    venue: row.venue,
    date: row.date,
    time: row.time ?? "시간 미정",
    genre: row.genre ?? "Music",
    source: row.source,
    ticketAccess: toTicketAccess(row.ticket_access),
    saleType: toSaleType(row.sale_type),
    saleWindow: row.sale_window ?? "판매 일정 확인 필요",
    price: row.price ?? "가격 확인 필요",
    phoneRequired: row.phone_required ?? true,
    foreignerNote: row.foreigner_note ?? "원본 티켓 페이지에서 해외 결제와 수령 조건을 확인하세요.",
    link: row.link ?? "#",
    image:
      row.image ??
      "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=1200&q=80",
  };
}

export function eventToSeedRow(event: Event) {
  return {
    source: "Seed",
    source_event_id: event.id,
    artist: event.artist,
    title: event.title,
    city: event.city,
    venue: event.venue,
    date: event.date,
    time: event.time,
    genre: event.genre,
    ticket_access: event.ticketAccess,
    sale_type: event.saleType,
    sale_window: event.saleWindow,
    price: event.price,
    phone_required: event.phoneRequired,
    foreigner_note: event.foreignerNote,
    link: event.link,
    image: event.image,
    country_code: "JP",
    raw: event,
  };
}
