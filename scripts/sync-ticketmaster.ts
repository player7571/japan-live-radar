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
    status?: {
      code?: string;
    };
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
    presales?: Array<{
      name?: string;
      startDateTime?: string;
      endDateTime?: string;
    }>;
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
const ticketmasterPageLimit = normalizeTicketmasterPageLimit(process.env.TICKETMASTER_PAGE_LIMIT);
const ticketmasterFetchTimeoutMs = normalizeTicketmasterFetchTimeoutMs(process.env.TICKETMASTER_FETCH_TIMEOUT_MS);
export const searchProfiles = [
  { label: "all-jp-events", params: {} },
  { label: "music-classification", params: { classificationName: "music" } },
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

export function normalizeTicketmasterPageLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(Math.max(Math.trunc(parsed), 1), 5);
}

export function normalizeTicketmasterFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function nextTicketmasterPages(
  page: TicketmasterResponse["page"] | undefined,
  pageLimit = 2,
) {
  const currentPage = page?.number ?? 0;
  const totalPages = page?.totalPages ?? 1;
  const cappedTotalPages = Math.min(totalPages, pageLimit);
  return Array.from(
    { length: Math.max(cappedTotalPages - currentPage - 1, 0) },
    (_value, index) => currentPage + index + 1,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ticketmasterEndpoint(
  profile: (typeof searchProfiles)[number],
  apiKey: string,
  pageNumber = 0,
) {
  const endpoint = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
  endpoint.searchParams.set("apikey", apiKey);
  endpoint.searchParams.set("countryCode", "JP");
  endpoint.searchParams.set("size", "200");
  endpoint.searchParams.set("sort", "date,asc");
  endpoint.searchParams.set("locale", "*");
  endpoint.searchParams.set("page", String(pageNumber));
  for (const [key, value] of Object.entries(profile.params)) {
    endpoint.searchParams.set(key, value);
  }
  return endpoint;
}

async function fetchTicketmasterPage(
  profile: (typeof searchProfiles)[number],
  apiKey: string,
  pageNumber = 0,
) {
  const response = await fetch(ticketmasterEndpoint(profile, apiKey, pageNumber), {
    signal: AbortSignal.timeout(ticketmasterFetchTimeoutMs),
  });
  if (response.status === 429) {
    console.warn(`Skipping ${profile.label}: Ticketmaster rate limit`);
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Ticketmaster ${profile.label} page ${pageNumber} request failed: ${response.status} ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as TicketmasterResponse;
  const events = payload._embedded?.events ?? [];
  console.log(`${profile.label} page ${pageNumber}: fetched ${events.length} events`);
  return payload;
}

function bestImage(images: TicketmasterEvent["images"]) {
  if (!images || images.length === 0) return null;
  return [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url;
}

function ticketmasterTokyoDateParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
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
}

function formatTicketmasterDateTime(value: string) {
  const parts = ticketmasterTokyoDateParts(value);
  if (!parts) return null;

  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatTicketmasterDate(value?: string) {
  if (!value) return null;
  const parts = ticketmasterTokyoDateParts(value);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

function formatTicketmasterTime(value?: string) {
  if (!value) return null;
  const parts = ticketmasterTokyoDateParts(value);
  return parts ? `${parts.hour}:${parts.minute}` : null;
}

export function formatSaleWindow(event: TicketmasterEvent) {
  const windows = [
    ...ticketmasterPresaleWindows(event),
    ticketmasterSaleWindow("일반 판매", event.sales?.public),
  ].filter(Boolean);

  if (windows.length === 0) return formatTicketmasterStatus(event);
  return windows.join(" / ");
}

function ticketmasterSaleWindow(
  label: string,
  sale: { startDateTime?: string; endDateTime?: string } | undefined,
) {
  const start = sale?.startDateTime;
  const end = sale?.endDateTime;
  if (!start && !end) return null;
  const startText = start ? formatTicketmasterDateTime(start) ?? "시작일 확인 필요" : "시작일 확인 필요";
  const endText = end ? formatTicketmasterDateTime(end) ?? "종료일 확인 필요" : "종료일 확인 필요";
  return `${label}: ${startText} - ${endText}`;
}

function ticketmasterPresaleWindows(event: TicketmasterEvent) {
  return [...(event.sales?.presales ?? [])]
    .sort((left, right) => {
      const leftTime = left.startDateTime ? new Date(left.startDateTime).getTime() : Number.POSITIVE_INFINITY;
      const rightTime = right.startDateTime ? new Date(right.startDateTime).getTime() : Number.POSITIVE_INFINITY;
      return leftTime - rightTime;
    })
    .map((presale) => ticketmasterSaleWindow(ticketmasterPresaleLabel(presale.name), presale))
    .filter(Boolean);
}

function ticketmasterPresaleLabel(name: string | undefined) {
  const normalized = name?.trim();
  return normalized ? `선예매 - ${normalized}` : "선예매";
}

function ticketmasterSaleType(event: TicketmasterEvent) {
  return ticketmasterPresaleWindows(event).length > 0 ? "선착 판매" : "일반 판매";
}

function formatTicketmasterStatus(event: TicketmasterEvent) {
  const code = event.dates?.status?.code?.trim().toLowerCase();
  if (!code) return null;

  if (code === "onsale") return "판매 중";
  if (code === "offsale") return "판매 종료";
  if (code === "cancelled" || code === "canceled") return "공연 취소";
  if (code === "postponed" || code === "rescheduled") return "일정 변경 확인";
  if (code === "tba" || code === "tbd") return "일정 확인 필요";
  return `Ticketmaster 상태: ${code}`;
}

function formatPrice(event: TicketmasterEvent) {
  const ranges = (event.priceRanges ?? [])
    .map((price) => {
      const min = typeof price.min === "number" ? price.min : null;
      const max = typeof price.max === "number" ? price.max : null;
      const low = min ?? max;
      const high = max ?? min;
      const currency = price.currency?.trim().toUpperCase() || "JPY";

      if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high)) return null;
      return {
        currency,
        low: Math.min(low, high),
        high: Math.max(low, high),
      };
    })
    .filter((price) => price !== null);
  if (ranges.length === 0) return null;

  const currencyCode = ranges.some((price) => price.currency === "JPY") ? "JPY" : ranges[0].currency;
  const sameCurrencyRanges = ranges.filter((price) => price.currency === currencyCode);
  const currency = currencyCode === "JPY" ? "¥" : currencyCode;
  const lowest = Math.min(...sameCurrencyRanges.map((price) => price.low));
  const highest = Math.max(...sameCurrencyRanges.map((price) => price.high));
  if (!Number.isFinite(lowest) || !Number.isFinite(highest)) return null;

  if (lowest !== highest) {
    return currency === "¥"
      ? `${currency}${lowest.toLocaleString("ja-JP")} - ${currency}${highest.toLocaleString("ja-JP")}`
      : `${currency} ${lowest.toLocaleString()} - ${highest.toLocaleString()}`;
  }

  return currency === "¥" ? `${currency}${lowest.toLocaleString("ja-JP")}` : `${currency} ${lowest.toLocaleString()}`;
}

const cityAliases: Array<[string[], string]> = [
  [["tokyo", "東京"], "도쿄"],
  [["osaka", "大阪"], "오사카"],
  [["yokohama", "横浜", "kanagawa", "神奈川"], "요코하마"],
  [["nagoya", "名古屋", "aichi", "愛知"], "나고야"],
  [["fukuoka", "福岡"], "후쿠오카"],
  [["saitama", "埼玉"], "사이타마"],
  [["chiba", "千葉", "makuhari", "幕張"], "치바"],
  [["kyoto", "京都"], "교토"],
  [["kobe", "神戸", "hyogo", "兵庫"], "고베"],
  [["hiroshima", "広島"], "히로시마"],
  [["sendai", "仙台", "miyagi", "宮城"], "센다이"],
  [["sapporo", "札幌", "hokkaido", "北海道"], "삿포로"],
  [["naha", "那覇", "okinawa", "沖縄"], "오키나와"],
  [["shizuoka", "静岡"], "시즈오카"],
  [["niigata", "新潟"], "니가타"],
  [["kanazawa", "金沢", "ishikawa", "石川"], "가나자와"],
  [["okayama", "岡山"], "오카야마"],
  [["kumamoto", "熊本"], "구마모토"],
  [["kagoshima", "鹿児島"], "가고시마"],
  [["matsuyama", "松山", "ehime", "愛媛"], "마쓰야마"],
  [["takamatsu", "高松", "kagawa", "香川"], "다카마쓰"],
  [["oita", "大分"], "오이타"],
  [["nagano", "長野"], "나가노"],
  [["takasaki", "高崎", "gunma", "群馬"], "다카사키"],
  [["utsunomiya", "宇都宮", "tochigi", "栃木"], "우쓰노미야"],
  [["mito", "水戸", "ibaraki", "茨城"], "미토"],
];

function mapCity(value?: string) {
  if (!value) return null;
  const city = value.trim();
  if (!city || /^\d+$/.test(city)) return null;
  const normalized = city.toLowerCase();

  for (const [signals, mappedCity] of cityAliases) {
    if (signals.some((signal) => normalized.includes(signal.toLowerCase()) || city.includes(signal))) {
      return mappedCity;
    }
  }

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
  "音楽",
  "concert",
  "コンサート",
  "live",
  "ライブ",
  "festival",
  "フェス",
  "フェスティバル",
  "tour",
  "ツアー",
  "dj",
  "orchestra",
  "オーケストラ",
  "symphony",
  "シンフォニー",
  "band",
  "バンド",
  "idol",
  "アイドル",
  "j-pop",
  "k-pop",
  "rock",
  "ロック",
  "pop",
  "ポップ",
];

const nonConcertSignals = [
  "basketball",
  "バスケットボール",
  "baseball",
  "野球",
  "football",
  "soccer",
  "サッカー",
  "rugby",
  "ラグビー",
  "volleyball",
  "バレーボール",
  "hockey",
  "marathon",
  "マラソン",
  "triathlon",
  "gymnastics",
  "tennis",
  "テニス",
  "golf",
  "ゴルフ",
  "swimming",
  "athletics",
  "wrestling",
  "プロレス",
  "boxing",
  "ボクシング",
  "judo",
  "柔道",
  "karate",
  "空手",
  "cycling",
  "handball",
  "badminton",
  "bkb",
  "格闘技",
  "相撲",
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

export function isLikelyConcert(event: TicketmasterEvent) {
  const text = eventSearchText(event);
  if (!text) return false;
  if (nonConcertSignals.some((signal) => text.includes(signal))) return false;
  return concertSignals.some((signal) => text.includes(signal));
}

function postgrestStringList(values: string[]) {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")})`;
}

export function shouldDeleteStaleTicketmasterRows(currentRowCount: number, skippedProfiles: string[]) {
  return currentRowCount > 0 && skippedProfiles.length === 0;
}

async function deleteStaleTicketmasterRows(
  supabase: EventsSupabaseClient,
  currentRows: EventUpsertRow[],
  skippedProfiles: string[],
) {
  if (!shouldDeleteStaleTicketmasterRows(currentRows.length, skippedProfiles)) return 0;

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

export function toTicketmasterEventRow(event: TicketmasterEvent): EventUpsertRow | null {
  const date = event.dates?.start?.localDate ?? formatTicketmasterDate(event.dates?.start?.dateTime);
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
      formatTicketmasterTime(event.dates?.start?.dateTime) ??
      null,
    genre,
    ticket_access: "한국 구매 가능",
    sale_type: ticketmasterSaleType(event),
    sale_window: formatSaleWindow(event),
    price: formatPrice(event),
    phone_required: false,
    foreigner_note: "Ticketmaster는 해외 계정/카드 접근 가능성이 높지만 수령 방식과 신분 확인 조건은 원본에서 확인하세요.",
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

    const firstPage = await fetchTicketmasterPage(profile, apiKey);
    if (!firstPage) {
      skippedProfiles.push(profile.label);
      continue;
    }

    for (const event of firstPage._embedded?.events ?? []) {
      collected.set(event.id, event);
    }

    for (const pageNumber of nextTicketmasterPages(firstPage.page, ticketmasterPageLimit)) {
      await sleep(750);
      const page = await fetchTicketmasterPage(profile, apiKey, pageNumber);
      if (!page) {
        skippedProfiles.push(profile.label);
        break;
      }
      for (const event of page._embedded?.events ?? []) {
        collected.set(event.id, event);
      }
    }
  }

  const mappedRows = [...collected.values()].map(toTicketmasterEventRow);
  const rows = mappedRows.filter((row): row is EventUpsertRow => row !== null && isLikelyConcert(row.raw));
  const skippedCount = mappedRows.length - rows.length;

  if (rows.length === 0) {
    const staleDeletedCount = await deleteStaleTicketmasterRows(supabase, rows, skippedProfiles);
    const message =
      skippedProfiles.length > 0
        ? `No usable dated events. Rate-limited profiles: ${skippedProfiles.join(", ")}.`
        : "No concert-like Ticketmaster JP events were found. Preserved existing Ticketmaster rows because this sync produced zero usable rows.";
    await recordSyncRun(supabase, {
      source: "Ticketmaster",
      status: "success",
      fetchedCount: collected.size,
      skippedCount,
      message,
      startedAt,
    });
    console.log(`${message} Removed ${staleDeletedCount} stale rows.`);
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
