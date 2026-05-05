import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { extractDraft } from "../api/import-url";
import { recordSyncRun } from "../src/lib/syncRuns";

type RakutenTicketEventRow = {
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
  raw: ReturnType<typeof extractDraft>;
};

const defaultRakutenTicketCategoryUrls = [
  "https://ticket.rakuten.co.jp/area/all/genre/jpop",
  "https://ticket.rakuten.co.jp/area/all/genre/kpop",
  "https://ticket.rakuten.co.jp/area/all/genre/m-fes",
  "https://ticket.rakuten.co.jp/music/jpop/",
];

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const rakutenTicketFetchTimeoutMs = normalizeRakutenTicketFetchTimeoutMs(process.env.RAKUTEN_TICKET_FETCH_TIMEOUT_MS);
const rakutenTicketCategoryLimit = normalizeRakutenTicketCategoryLimit(process.env.RAKUTEN_TICKET_CATEGORY_LIMIT);
const rakutenTicketRowLimit = normalizeRakutenTicketRowLimit(process.env.RAKUTEN_TICKET_ROW_LIMIT);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normalizeRakutenTicketFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function normalizeRakutenTicketCategoryLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(Math.max(Math.trunc(parsed), 1), 8);
}

export function normalizeRakutenTicketRowLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function envList(name: string) {
  return (process.env[name] ?? "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function rakutenTicketCategoryUrls() {
  const explicitUrls = envList("RAKUTEN_TICKET_CATEGORY_URLS");
  return (explicitUrls.length > 0 ? explicitUrls : defaultRakutenTicketCategoryUrls).slice(0, rakutenTicketCategoryLimit);
}

async function fetchRakutenTicketPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JapanLiveRadar/0.1 (+https://japan-live-radar.vercel.app)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(rakutenTicketFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Rakuten Ticket request failed for ${url}: ${response.status} ${await response.text()}`);
  }

  return response.text();
}

function compactText(value: string | null | undefined) {
  if (!value) return "";
  return cheerio.load(value).text().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function postgrestStringList(values: string[]) {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")})`;
}

function isRakutenTicketDetailUrl(url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  return url.hostname === "ticket.rakuten.co.jp" &&
    segments[0] === "music" &&
    segments.length >= 2 &&
    /^(?:rt|rty|rtx|rtz)[a-z0-9-]+$/i.test(last) &&
    !segments.includes("feed");
}

export function extractRakutenTicketDetailUrls(html: string, baseUrl = "https://ticket.rakuten.co.jp/") {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      url.search = "";
      if (isRakutenTicketDetailUrl(url)) urls.add(url.toString().replace(/\/?$/, "/"));
    } catch {
      // Ignore malformed marketing or tracking links in source pages.
    }
  });

  return Array.from(urls);
}

function isLikelyRakutenTicketConcert(draft: ReturnType<typeof extractDraft>) {
  const text = [draft.artist, draft.title, draft.venue, draft.genre].map(compactText).join(" ");
  if (/(舞台|演劇|ミュージカル|歌舞伎|宝塚|スポーツ|野球|サッカー|バスケット|格闘技|お笑い|落語|寄席)/.test(text)) {
    return false;
  }
  return /(ライブ|コンサート|ツアー|フェス|J-POP|K-POP|ROCK|ロック|アイドル|音楽|music|Music|LIVE|Live)/.test(text);
}

export function rakutenTicketLogicalEventKey(
  row: Pick<RakutenTicketEventRow, "title" | "date" | "time" | "venue" | "city">,
) {
  return [row.title, row.date, row.time ?? "", row.venue, row.city]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

function normalizeRakutenTicketTitle(title: string, artist: string) {
  return title
    .replace(/^\s*[\[［【][^\]］】]{1,24}公演[\]］】]\s*/, "")
    .replace(/^\s*＜[^＞]{1,24}＞\s*/, "")
    .trim() || artist || title;
}

export function toRakutenTicketEventRow(
  draft: ReturnType<typeof extractDraft>,
  sourceUrl: string,
  now = new Date(),
): RakutenTicketEventRow | null {
  const link = draft.link || sourceUrl;
  if (!draft.date || !draft.venue || !link || !isLikelyRakutenTicketConcert(draft)) return null;
  if (new Date(`${draft.date}T23:59:59+09:00`).getTime() < now.getTime()) return null;
  const artist = draft.artist || draft.title || "Rakuten Ticket 공연";
  const title = normalizeRakutenTicketTitle(draft.title || artist, artist);

  return {
    source: "Rakuten Ticket",
    source_event_id: link,
    artist,
    title,
    city: draft.city || "도시 미정",
    venue: draft.venue,
    date: draft.date,
    time: draft.time || null,
    genre: "Music",
    ticket_access: draft.ticketAccess,
    sale_type: draft.saleType,
    sale_window: draft.saleWindow || null,
    price: draft.price || null,
    phone_required: draft.phoneRequired,
    foreigner_note: draft.foreignerNote || "Rakuten Ticket은 계정, 결제, 수령 제한이 있을 수 있어 원본에서 조건을 확인하세요.",
    link,
    image: draft.image || null,
    country_code: "JP",
    raw: draft,
  };
}

async function main() {
  const startedAt = new Date();
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const detailUrls = new Set<string>();
  for (const categoryUrl of rakutenTicketCategoryUrls()) {
    const html = await fetchRakutenTicketPage(categoryUrl);
    for (const detailUrl of extractRakutenTicketDetailUrls(html, categoryUrl)) {
      detailUrls.add(detailUrl);
      if (detailUrls.size >= rakutenTicketRowLimit) break;
    }
    if (detailUrls.size >= rakutenTicketRowLimit) break;
  }

  const collected = new Map<string, RakutenTicketEventRow>();
  let fetchedCount = 0;
  for (const detailUrl of detailUrls) {
    const html = await fetchRakutenTicketPage(detailUrl);
    fetchedCount += 1;
    const row = toRakutenTicketEventRow(extractDraft(html, new URL(detailUrl)), detailUrl, startedAt);
    if (row) {
      const key = rakutenTicketLogicalEventKey(row);
      if (!collected.has(key)) collected.set(key, row);
    }
    if (collected.size >= rakutenTicketRowLimit) break;
  }

  const rows = [...collected.values()];
  const skippedCount = Math.max(fetchedCount - rows.length, 0);
  if (rows.length === 0) {
    await recordSyncRun(supabase, {
      source: "Rakuten Ticket",
      status: "success",
      fetchedCount,
      skippedCount,
      message: "No usable Rakuten Ticket rows were found.",
      startedAt,
    });
    console.log("No usable Rakuten Ticket rows were found.");
    return;
  }

  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: "Rakuten Ticket",
      status: "error",
      fetchedCount,
      skippedCount,
      message: error.message,
      startedAt,
    });
    throw new Error(`Supabase Rakuten Ticket upsert failed: ${error.message}`);
  }

  const { error: staleError, count: staleDeletedCount } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("source", "Rakuten Ticket")
    .not("source_event_id", "in", postgrestStringList(rows.map((row) => row.source_event_id)));

  if (staleError) {
    await recordSyncRun(supabase, {
      source: "Rakuten Ticket",
      status: "error",
      fetchedCount,
      skippedCount,
      message: staleError.message,
      startedAt,
    });
    throw new Error(`Supabase stale Rakuten Ticket cleanup failed: ${staleError.message}`);
  }

  await recordSyncRun(supabase, {
    source: "Rakuten Ticket",
    status: "success",
    fetchedCount,
    upsertedCount: rows.length,
    skippedCount,
    message: `Synced ${rows.length} Rakuten Ticket public category events. Removed ${staleDeletedCount ?? 0} stale Rakuten Ticket rows.`,
    startedAt,
  });
  console.log(
    `Synced ${rows.length} Rakuten Ticket events. Skipped ${skippedCount}. Removed ${staleDeletedCount ?? 0} stale rows.`,
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
