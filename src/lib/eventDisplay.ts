import type { Event } from "../types/events";

function normalizeDisplayText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isGenericArtistLabel(event: Pick<Event, "artist" | "source">) {
  const artist = normalizeDisplayText(event.artist);
  const source = normalizeDisplayText(event.source);
  return Boolean(source && artist === `${source} 공연`) || artist === "Creativeman 공연";
}

export function eventDisplayArtist(event: Pick<Event, "artist" | "title" | "source">) {
  const artist = normalizeDisplayText(event.artist);
  const title = normalizeDisplayText(event.title);
  if (isGenericArtistLabel(event) && title) return title;
  return artist || title || "공연 정보";
}

export function eventDisplayTitle(event: Pick<Event, "artist" | "title" | "source">) {
  const title = normalizeDisplayText(event.title);
  const displayArtist = eventDisplayArtist(event);
  if (!title || title === displayArtist) return "";
  return title;
}
