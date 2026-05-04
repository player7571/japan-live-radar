import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { recordSyncRun } from "../src/lib/syncRuns";

type TicketmasterVenue = {
  name?: string;
  city?: { name?: string };
  state?: { name?: string; stateCode?: string };
  address?: { line1?: string; line2?: string };
};

type TicketmasterEvent = {
  id: string;
  name?: string;
  url?: string;
  images?: Array<{ url: string; width?: number; height?: number }>;
  dates?: {
    start?: {
      localDate?: string;
      localTime?: string;
      dateTime?: string;
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
    subGenre?: { name?: string };
    segment?: { name?: string };
  }>;
  _embedded?: {
    venues?: TicketmasterVenue[];
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

type EventsSupabaseClient = ReturnType<typeof createClient<any, "public">>;

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

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function bestImage(images: TicketmasterEvent["images"]) {
  if (!images || images.length === 0) return null;
  return [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url;
}

function formatTicketmasterDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});

  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

export function formatSaleWindow(event: TicketmasterEvent) {
  const start = event.sales?.public?.startDateTime;
  const end = event.sales?.public?.endDateTime;
  if (!start && !end) return null;
  const startText = start ? formatTicketmasterDateTime(start) ?? "시작일 확인 필요" : "시작일 확인 필요";
  const endText = end ? formatTicketmasterDateTime(end) ?? "종료일 확인 필요" : "종료일 확인 필요";
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

function mapCity(value?: string) {
  if (!value) return null;
  const city = value.trim();
  if (!city || /^\d+$/.test(city)) return null;
  const normalized = city.toLowerCase();

  if (normalized.includes("tokyo") || city.includes("東京")) return "도쿄";
  if (normalized.includes("osaka") || city.includes("大阪")) return "오사카";
  if (normalized.includes("yokohama") || city.includes("横浜")) return "요코하마";
  if (normalized.includes("nagoya") || city.includes("名古屋")) return "나고야";
  if (normalized.includes("fukuoka") || city.includes("福岡")) return "후쿠오카";
  if (normalized.includes("saitama") || city.includes("埼玉")) return "사이타마";
  if (normalized.includes("chiba") || city.includes("千葉")) return "치바";
  if (normalized.includes("kyoto") || city.includes("京都")) return "교토";
  if (normalized.includes("kobe") || city.includes("神戸")) return "고베";
  if (normalized.includes("hiroshima") || city.includes("広島")) return "히로시마";
  if (normalized.includes("sendai") || city.includes("仙台")) return "센다이";
  if (normalized.includes("sapporo") || city.includes("札幌")) return "삿포로";
  if (normalized.includes("naha") || city.includes("那覇")) return "나하";
  if (normalized.includes("okinawa") || city.includes("沖縄")) return "오키나와";
  if (normalized.includes("aichi") || city.includes("愛知")) return "나고야";
  if (normalized.includes("kanagawa") || city.includes("神奈川")) return "요코하마";
  if (normalized.includes("hyogo") || city.includes("兵庫")) return "고베";
  if (normalized.includes("miyagi") || city.includes("宮城")) return "센다이";
  if (normalized.includes("hokkaido") || city.includes("北海道")) return "삿포로";

  return city;
}

function venueCity(venue?: TicketmasterVenue) {
  const candidates = [
    venue?.city?.name,
    venue?.state?.name,
    venue?.state?.stateCode,
    venue?.address?.line1,
    venue?.address?.line2,
    venue?.name,
  ];

  for (const candidate of candidates) {
    const mapped = mapCity(candidate);
    if (mapped) return mapped;
  }

  return "도시 미정";
}

const concertSignals = [
  "music",
  "concert",
  "live",
  "festival",
  "tour",
  "dj",
  "orchestra",
  "symphony",
  "band",
  "idol",
  "j-pop",
  "k-pop",
  "rock",
  "pop",
];

const nonConcertSignals = [
  "basketball",
  "baseball",
  "football",
  "soccer",
  "rugby",
  "volleyball",
  "hockey",
  "marathon",
  "triathlon",
  "gymnastics",
  "tennis",
  "golf",
  "swimming",
  "athletics",
  "wrestling",
  "boxing",
  "judo",
  "karate",
  "cycling",
  "handball",
  "badminton",
  "bkb",
];

function eventSearchText(event: TicketmasterEvent) {
  return [
    event.name,
    event._embedded?.attractions?.map((attraction) => attraction.name).join(" "),
    event.classifications
      ?.map((classification) =>
        [classification.segment?.name, classification.genre?.name, classification.subGenre?.name].join(" "),
      )
      .join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isLikelyConcert(event: TicketmasterEvent) {
  const text = eventSearchText(event);
  if (!text) return false;
  if (nonConcertSignals.some((signal) => text.includes(signal))) return false;
  return concertSignals.some((signal) => text.includes(signal));
}

function postgrestStringList(values: string[]) {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")})`;
}

async function deleteStaleTicketmasterRows(
  supabase: EventsSupabaseClient,
  currentRows: EventUpsertRow[],
  skippedProfiles: string[],
) {
  if (skippedProfiles.length > 0) return 0;

  const query = supabase.from("events").delete({ count: "exact" }).eq("source", "Ticketmaster");
  const { error, count } =
    currentRows.length > 0
      ? await query.not("source_event_id", "in", postgrestStringList(currentRows.map((row) => row.source_event_id)))
      : await query;

  if (error) {
    throw new Error(`Supabase stale Ticketmaster cleanup failed: ${error.message}`);
  }

  return count ?? 0;
}

function toEventRow(event: TicketmasterEvent): EventUpsertRow | null {
  const date = event.dates?.start?.localDate ?? event.dates?.start?.dateTime?.slice(0, 10);
  if (!date) return null;

  const venue = event._embedded?.venues?.[0];
  const attraction = event._embedded?.attractions?.[0];
  const genre =
    event.classifications?.[0]?.genre?.name ??
    event.classifications?.[0]?.subGenre?.name ??
    event.classifications?.[0]?.segment?.name ??
    "Music";

  return {
    source: "Ticketmaster",
    source_event_id: event.id,
    artist: attraction?.name ?? event.name ?? "Unknown Artist",
    title: event.name ?? "Untitled Event",
    city: venueCity(venue),
    venue: venue?.name ?? "Venue TBA",
    date,
    time:
      event.dates?.start?.localTime?.slice(0, 5) ??
      event.dates?.start?.dateTime?.slice(11, 16) ??
      null,
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
  const skippedProfiles: string[] = [];

  for (const [index, profile] of searchProfiles.entries()) {
    if (index > 0) {
      await sleep(1_250);
    }

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
    if (response.status === 429) {
      skippedProfiles.push(profile.label);
      console.warn(`Skipping ${profile.label}: Ticketmaster rate limit`);
      continue;
    }

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
  const rows = mappedRows.filter((row): row is EventUpsertRow => row !== null && isLikelyConcert(row.raw));
  const skippedCount = mappedRows.length - rows.length;

  if (rows.length === 0) {
    const staleDeletedCount = await deleteStaleTicketmasterRows(supabase, rows, skippedProfiles);
    await recordSyncRun(supabase, {
      source: "Ticketmaster",
      status: "success",
      fetchedCount: collected.size,
      skippedCount,
      message:
        skippedProfiles.length > 0
          ? `No usable dated events. Rate-limited profiles: ${skippedProfiles.join(", ")}.`
          : `No concert-like Ticketmaster JP events were found. Removed ${staleDeletedCount} stale Ticketmaster rows.`,
      startedAt,
    });
    console.log(
      `No concert-like Ticketmaster events found after ${searchProfiles.length} JP searches. Removed ${staleDeletedCount} stale rows.`,
    );
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

  const staleDeletedCount = await deleteStaleTicketmasterRows(supabase, rows, skippedProfiles);

  await recordSyncRun(supabase, {
    source: "Ticketmaster",
    status: "success",
    fetchedCount: collected.size,
    upsertedCount: rows.length,
    skippedCount,
    message:
      skippedProfiles.length > 0
        ? `Ran ${searchProfiles.length} JP search profiles. Rate-limited profiles: ${skippedProfiles.join(", ")}.`
        : `Ran ${searchProfiles.length} JP search profiles. Removed ${staleDeletedCount} stale Ticketmaster rows.`,
    startedAt,
  });

  console.log(
    `Synced ${rows.length} Ticketmaster concert-like events. Skipped ${skippedCount}. Removed ${staleDeletedCount} stale rows.`,
  );
}

function isDirectRun() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
