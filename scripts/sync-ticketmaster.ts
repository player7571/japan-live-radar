import { createClient } from "@supabase/supabase-js";
import { recordSyncRun } from "../src/lib/syncRuns";

type TicketmasterEvent = {
  id: string;
  name?: string;
  url?: string;
  images?: Array<{ url: string; width?: number; height?: number }>;
  dates?: {
    start?: {
      localDate?: string;
      localTime?: string;
    };
  };
  sales?: {
    public?: {
      startDateTime?: string;
      endDateTime?: string;
    };
  };
  priceRanges?: Array<{
    min?: number;
    max?: number;
    currency?: string;
  }>;
  classifications?: Array<{
    genre?: { name?: string };
    segment?: { name?: string };
  }>;
  _embedded?: {
    venues?: Array<{
      name?: string;
      city?: { name?: string };
    }>;
    attractions?: Array<{
      name?: string;
    }>;
  };
};

type TicketmasterResponse = {
  _embedded?: {
    events?: TicketmasterEvent[];
  };
  page?: {
    totalElements?: number;
    totalPages?: number;
    number?: number;
  };
};

type EventUpsertRow = {
  source: string;
  source_event_id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string | null;
  genre: string;
  ticket_access: string;
  sale_type: string;
  sale_window: string | null;
  price: string | null;
  phone_required: boolean;
  foreigner_note: string;
  link: string | null;
  image: string | null;
  country_code: string;
  raw: TicketmasterEvent;
};

const ticketmasterApiKey = process.env.TICKETMASTER_API_KEY;
const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const searchProfiles = [
  { label: "all-jp-events", params: {} },
  { label: "music-keyword", params: { keyword: "music" } },
  { label: "concert-keyword", params: { keyword: "concert" } },
  { label: "live-keyword", params: { keyword: "live" } },
  { label: "festival-keyword", params: { keyword: "festival" } },
] as const;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function bestImage(images: TicketmasterEvent["images"]) {
  if (!images || images.length === 0) return null;
  return [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url;
}

function formatSaleWindow(event: TicketmasterEvent) {
  const start = event.sales?.public?.startDateTime;
  const end = event.sales?.public?.endDateTime;
  if (!start && !end) return null;
  const formatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const startText = start ? formatter.format(new Date(start)) : "시작일 확인 필요";
  const endText = end ? formatter.format(new Date(end)) : "종료일 확인 필요";
  return `${startText} - ${endText}`;
}

function formatPrice(event: TicketmasterEvent) {
  const price = event.priceRanges?.[0];
  if (!price) return null;
  const currency = price.currency ?? "JPY";
  if (typeof price.min === "number" && typeof price.max === "number" && price.min !== price.max) {
    return `${currency} ${price.min.toLocaleString()} - ${price.max.toLocaleString()}`;
  }
  if (typeof price.min === "number") {
    return `${currency} ${price.min.toLocaleString()}`;
  }
  return null;
}

function mapCity(city?: string) {
  if (!city) return "도쿄";
  if (city.includes("Tokyo")) return "도쿄";
  if (city.includes("Osaka")) return "오사카";
  if (city.includes("Yokohama")) return "요코하마";
  if (city.includes("Nagoya")) return "나고야";
  if (city.includes("Fukuoka")) return "후쿠오카";
  return city;
}

function toEventRow(event: TicketmasterEvent): EventUpsertRow | null {
  const date = event.dates?.start?.localDate;
  if (!date) return null;

  const venue = event._embedded?.venues?.[0];
  const attraction = event._embedded?.attractions?.[0];
  const genre =
    event.classifications?.[0]?.genre?.name ?? event.classifications?.[0]?.segment?.name ?? "Music";

  return {
    source: "Ticketmaster",
    source_event_id: event.id,
    artist: attraction?.name ?? event.name ?? "Unknown Artist",
    title: event.name ?? "Untitled Event",
    city: mapCity(venue?.city?.name),
    venue: venue?.name ?? "Venue TBA",
    date,
    time: event.dates?.start?.localTime?.slice(0, 5) ?? null,
    genre,
    ticket_access: "확인 필요",
    sale_type: "일반 판매",
    sale_window: formatSaleWindow(event),
    price: formatPrice(event),
    phone_required: false,
    foreigner_note: "Ticketmaster 원본 페이지에서 해외 결제, 수령 방식, 신분 확인 조건을 확인하세요.",
    link: event.url ?? null,
    image: bestImage(event.images),
    country_code: "JP",
    raw: event,
  };
}

async function main() {
  const startedAt = new Date();
  const apiKey = requireEnv("TICKETMASTER_API_KEY", ticketmasterApiKey);
  const url = requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey);
  const supabase = createClient(url, key);

  const collected = new Map<string, TicketmasterEvent>();

  for (const profile of searchProfiles) {
    const endpoint = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
    endpoint.searchParams.set("apikey", apiKey);
    endpoint.searchParams.set("countryCode", "JP");
    endpoint.searchParams.set("size", "200");
    endpoint.searchParams.set("sort", "date,asc");
    endpoint.searchParams.set("locale", "*");
    for (const [key, value] of Object.entries(profile.params)) {
      endpoint.searchParams.set(key, value);
    }

    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`Ticketmaster ${profile.label} request failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as TicketmasterResponse;
    const events = payload._embedded?.events ?? [];
    console.log(`${profile.label}: fetched ${events.length} events`);
    for (const event of events) {
      collected.set(event.id, event);
    }
  }

  const mappedRows = [...collected.values()].map(toEventRow);
  const rows = mappedRows.filter((row): row is EventUpsertRow => row !== null);
  const skippedCount = mappedRows.length - rows.length;

  if (rows.length === 0) {
    await recordSyncRun(supabase, {
      source: "Ticketmaster",
      status: "success",
      fetchedCount: collected.size,
      skippedCount,
      message: "No Ticketmaster JP events with usable dates were found.",
      startedAt,
    });
    console.log(`No Ticketmaster events found after ${searchProfiles.length} JP searches.`);
    return;
  }

  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: "Ticketmaster",
      status: "error",
      fetchedCount: collected.size,
      skippedCount,
      message: error.message,
      startedAt,
    });
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  await recordSyncRun(supabase, {
    source: "Ticketmaster",
    status: "success",
    fetchedCount: collected.size,
    upsertedCount: rows.length,
    skippedCount,
    message: `Ran ${searchProfiles.length} JP search profiles.`,
    startedAt,
  });

  console.log(`Synced ${rows.length} Ticketmaster events. Skipped ${skippedCount}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
