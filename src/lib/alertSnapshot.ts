import type { Event } from "../types/events";

export type AlertEventSnapshot = Pick<
  Event,
  | "id"
  | "artist"
  | "title"
  | "city"
  | "venue"
  | "date"
  | "time"
  | "source"
  | "ticketAccess"
  | "saleType"
  | "saleWindow"
  | "price"
  | "phoneRequired"
  | "foreignerNote"
  | "link"
>;

export function buildAlertEventSnapshot(event: Event): AlertEventSnapshot {
  return {
    id: event.id,
    artist: event.artist,
    title: event.title,
    city: event.city,
    venue: event.venue,
    date: event.date,
    time: event.time,
    source: event.source,
    ticketAccess: event.ticketAccess,
    saleType: event.saleType,
    saleWindow: event.saleWindow,
    price: event.price,
    phoneRequired: event.phoneRequired,
    foreignerNote: event.foreignerNote,
    link: event.link,
  };
}
