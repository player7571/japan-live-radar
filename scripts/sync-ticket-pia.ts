import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { recordSyncRun } from "../src/lib/syncRuns";

type TicketPiaEventRow = {
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
  raw: Record<string, string | null>;
};

const defaultTicketPiaKeywords = ["J-POP", "K-POP", "ライブ", "コンサート", "フェス", "ROCK"];
const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ticketPiaFetchTimeoutMs = normalizeTicketPiaFetchTimeoutMs(process.env.TICKET_PIA_FETCH_TIMEOUT_MS);
const ticketPiaPageLimit = normalizeTicketPiaPageLimit(process.env.TICKET_PIA_PAGE_LIMIT);
const ticketPiaRowLimit = normalizeTicketPiaRowLimit(process.env.TICKET_PIA_ROW_LIMIT);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normalizeTicketPiaFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function normalizeTicketPiaPageLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), 3);
}

export function normalizeTicketPiaRowLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 80;
  return Math.min(Math.max(Math.trunc(parsed), 1), 120);
}

function envList(name: string) {
  return (process.env[name] ?? "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function ticketPiaSearchUrls() {
  const explicitUrls = envList("TICKET_PIA_SEARCH_URLS");
  if (explicitUrls.length > 0) return explicitUrls.slice(0, 8);

  const keywords = envList("TICKET_PIA_SYNC_KEYWORDS");
  const defaultKeywords = keywords.length > 0 ? keywords : defaultTicketPiaKeywords;
  return defaultKeywords.slice(0, 8).flatMap((keyword) =>
    Array.from({ length: ticketPiaPageLimit }, (_, index) => {
      const url = new URL("https://t.pia.jp/pia/rlsInfo.do");
      url.searchParams.set("kw", keyword);
      url.searchParams.set("cAsgnFlg", "false");
      url.searchParams.set("bAsgnFlg", "false");
      url.searchParams.set("includeSaleEnd", "false");
      url.searchParams.set("page", String(index + 1));
      url.searchParams.set("responsive", "true");
      url.searchParams.set("noConvert", "true");
      url.searchParams.set("searchMode", "1");
      url.searchParams.set("mode", "2");
      url.searchParams.set("dispMode", "1");
      return url.toString();
    }),
  );
}

async function fetchTicketPiaPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JapanLiveRadar/0.1 (+https://japan-live-radar.vercel.app)",
    },
    signal: AbortSignal.timeout(ticketPiaFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ticket Pia request failed for ${url}: ${response.status} ${await response.text()}`);
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

const cityAliases: Array<[string[], string]> = [
  [["東京都", "東京"], "도쿄"],
  [["大阪府", "大阪"], "오사카"],
  [["神奈川県", "横浜"], "요코하마"],
  [["愛知県", "名古屋"], "나고야"],
  [["福岡県", "福岡"], "후쿠오카"],
  [["埼玉県", "埼玉"], "사이타마"],
  [["千葉県", "千葉", "幕張"], "치바"],
  [["京都府", "京都"], "교토"],
  [["兵庫県", "神戸"], "고베"],
  [["広島県", "広島"], "히로시마"],
  [["宮城県", "仙台"], "센다이"],
  [["北海道", "札幌"], "삿포로"],
  [["沖縄県", "沖縄", "那覇"], "오키나와"],
  [["静岡県", "静岡"], "시즈오카"],
  [["新潟県", "新潟"], "니가타"],
  [["石川県", "金沢"], "가나자와"],
  [["岡山県", "岡山"], "오카야마"],
  [["熊本県", "熊本"], "구마모토"],
  [["鹿児島県", "鹿児島"], "가고시마"],
  [["愛媛県", "松山"], "마쓰야마"],
  [["香川県", "高松"], "다카마쓰"],
  [["大分県", "大分"], "오이타"],
  [["長野県", "長野"], "나가노"],
  [["群馬県", "高崎"], "다카사키"],
  [["栃木県", "宇都宮"], "우쓰노미야"],
  [["茨城県", "水戸"], "미토"],
];

function mapCity(...values: Array<string | null | undefined>) {
  const text = values.map(compactText).filter(Boolean).join(" ");
  for (const [signals, city] of cityAliases) {
    if (signals.some((signal) => text.includes(signal))) return city;
  }
  return compactText(values[0]) || "도시 미정";
}

function formatTicketPiaDate(value: string | null | undefined) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function formatTicketPiaTime(value: string | null | undefined) {
  const match = value?.match(/T(\d{2}):(\d{2})/);
  if (!match || match[1] === "00" && match[2] === "00") return null;
  return `${match[1]}:${match[2]}`;
}

function normalizeTicketPiaTitle(rawTitle: string, artist: string) {
  const withoutSeat = rawTitle.replace(/^【[^】]+】\s*/g, "");
  const afterSlash = withoutSeat.split(/[／/]/).pop()?.trim() ?? withoutSeat;
  return afterSlash
    .replace(/^(?:一般発売|プレリザーブ|先行受付|先行抽選|先着先行|抽選受付)[.．。\s]*/g, "")
    .trim() || artist || rawTitle;
}

function ticketPiaSaleType(text: string) {
  if (/(プレリザーブ|抽選|先行抽選)/.test(text)) return "추첨 접수";
  if (/(先着|販売期間中)/.test(text)) return "선착 판매";
  return "일반 판매";
}

function ticketPiaSaleWindow(text: string) {
  const compacted = compactText(text);
  const end = compacted.match(/[～~]\s*(\d{4})\/(\d{1,2})\/(\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (!end) return compacted || null;
  const [, year, month, day, hour, minute] = end;
  return `${compacted.split(/[～~]/)[0].trim() || "판매"} 종료: ${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute}`;
}

const nonConcertSignals = [
  "舞台",
  "演劇",
  "ミュージカル",
  "映画",
  "スポーツ",
  "野球",
  "サッカー",
  "バスケット",
  "講演会",
  "トークショー",
  "お笑い",
  "単独ライブ",
  "漫才",
  "落語",
  "寄席",
];

function isLikelyTicketPiaConcert(text: string) {
  return !nonConcertSignals.some((signal) => text.includes(signal));
}

export function ticketPiaLogicalEventKey(row: Pick<TicketPiaEventRow, "title" | "date" | "time" | "venue" | "city">) {
  return [row.title, row.date, row.time ?? "", row.venue, row.city]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

export function extractTicketPiaRows(html: string, now = new Date()) {
  const $ = cheerio.load(html);
  const rows: TicketPiaEventRow[] = [];

  $("section.sales_data").each((_, section) => {
    const artist = compactText($(section).find(".sales_data_title a").first().text());
    $(section).find(".event_link").each((__, element) => {
      const link = $(element).find("a[itemprop='url']").first().attr("href");
      const rawTitle = compactText($(element).find(".is_title").first().text());
      const dateTime = $(element).find("time[itemprop='startDate']").first().attr("datetime");
      const venue = compactText($(element).find(".is_place [itemprop='name']").first().text());
      const prefecture = compactText($(element).find(".is_place [itemprop='addressRegion']").first().text());
      const status = compactText($(element).find(".is_status").first().text());
      const date = formatTicketPiaDate(dateTime);
      const sourceEventId = link ? new URL(link, "https://t.pia.jp").toString() : null;
      const title = normalizeTicketPiaTitle(rawTitle, artist);
      const searchText = [artist, rawTitle, venue, prefecture, status].join(" ");

      if (!sourceEventId || !date || !venue || !isLikelyTicketPiaConcert(searchText)) return;
      if (new Date(`${date}T23:59:59+09:00`).getTime() < now.getTime()) return;

      rows.push({
        source: "Ticket Pia",
        source_event_id: sourceEventId,
        artist: artist || title,
        title,
        city: mapCity(prefecture, venue),
        venue,
        date,
        time: formatTicketPiaTime(dateTime),
        genre: "Music",
        ticket_access: "일본 번호 필요",
        sale_type: ticketPiaSaleType(`${rawTitle} ${status}`),
        sale_window: ticketPiaSaleWindow(status),
        price: null,
        phone_required: true,
        foreigner_note: "Ticket Pia는 일본 계정, 전화번호 인증, 결제/수령 제한이 있을 수 있어 원본에서 조건을 확인하세요.",
        link: sourceEventId,
        image: null,
        country_code: "JP",
        raw: { artist, rawTitle, dateTime: dateTime ?? null, venue, prefecture, status, link: sourceEventId },
      });
    });
  });

  return rows;
}

async function main() {
  const startedAt = new Date();
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const collected = new Map<string, TicketPiaEventRow>();
  let fetchedCount = 0;

  for (const url of ticketPiaSearchUrls()) {
    const rows = extractTicketPiaRows(await fetchTicketPiaPage(url), startedAt);
    fetchedCount += rows.length;
    for (const row of rows) {
      const key = ticketPiaLogicalEventKey(row);
      if (!collected.has(key)) collected.set(key, row);
      if (collected.size >= ticketPiaRowLimit) break;
    }
    if (collected.size >= ticketPiaRowLimit) break;
  }

  const rows = [...collected.values()];
  const skippedCount = Math.max(fetchedCount - rows.length, 0);
  if (rows.length === 0) {
    await recordSyncRun(supabase, {
      source: "Ticket Pia",
      status: "success",
      fetchedCount,
      skippedCount,
      message: "No usable Ticket Pia rows were found.",
      startedAt,
    });
    console.log("No usable Ticket Pia rows were found.");
    return;
  }

  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: "Ticket Pia",
      status: "error",
      fetchedCount,
      skippedCount,
      message: error.message,
      startedAt,
    });
    throw new Error(`Supabase Ticket Pia upsert failed: ${error.message}`);
  }

  const { error: staleError, count: staleDeletedCount } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("source", "Ticket Pia")
    .not("source_event_id", "in", postgrestStringList(rows.map((row) => row.source_event_id)));

  if (staleError) {
    await recordSyncRun(supabase, {
      source: "Ticket Pia",
      status: "error",
      fetchedCount,
      skippedCount,
      message: staleError.message,
      startedAt,
    });
    throw new Error(`Supabase stale Ticket Pia cleanup failed: ${staleError.message}`);
  }

  await recordSyncRun(supabase, {
    source: "Ticket Pia",
    status: "success",
    fetchedCount,
    upsertedCount: rows.length,
    skippedCount,
    message: `Synced ${rows.length} Ticket Pia public search events. Removed ${staleDeletedCount ?? 0} stale Ticket Pia rows.`,
    startedAt,
  });
  console.log(`Synced ${rows.length} Ticket Pia events. Skipped ${skippedCount}. Removed ${staleDeletedCount ?? 0} stale rows.`);
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
