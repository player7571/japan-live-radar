import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { recordSyncRun } from "../src/lib/syncRuns";

type LiveNationHipEventRow = {
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

const liveNationHipSource = "Live Nation H.I.P.";
const defaultLiveNationHipIndexUrls = ["https://www.livenationhip.co.jp/"];

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const liveNationHipFetchTimeoutMs = normalizeLiveNationHipFetchTimeoutMs(process.env.LIVENATION_HIP_FETCH_TIMEOUT_MS);
const liveNationHipIndexLimit = normalizeLiveNationHipIndexLimit(process.env.LIVENATION_HIP_INDEX_LIMIT);
const liveNationHipRowLimit = normalizeLiveNationHipRowLimit(process.env.LIVENATION_HIP_ROW_LIMIT);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normalizeLiveNationHipFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function normalizeLiveNationHipIndexLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), 4);
}

export function normalizeLiveNationHipRowLimit(value: string | undefined) {
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

export function liveNationHipIndexUrls() {
  const explicitUrls = envList("LIVENATION_HIP_INDEX_URLS");
  return (explicitUrls.length > 0 ? explicitUrls : defaultLiveNationHipIndexUrls).slice(0, liveNationHipIndexLimit);
}

async function fetchLiveNationHipPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JapanLiveRadar/0.1 (+https://japan-live-radar.vercel.app)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(liveNationHipFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Live Nation H.I.P. request failed for ${url}: ${response.status} ${await response.text()}`);
  }

  return response.text();
}

function compactText(value: string | null | undefined) {
  if (!value) return "";
  return cheerio.load(value).text().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function pageVisibleText($: cheerio.CheerioAPI) {
  const body = $("body").clone();
  body.find("script, style, noscript").remove();
  return compactText(body.text());
}

function postgrestStringList(values: string[]) {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")})`;
}

const cityAliases: Array<[string[], string]> = [
  [["東京", "Tokyo", "有明", "豊洲", "渋谷", "新宿", "代々木", "日本武道館"], "도쿄"],
  [["大阪", "Osaka", "Namba", "なんば"], "오사카"],
  [["神奈川", "横浜", "Yokohama", "ぴあアリーナ"], "요코하마"],
  [["千葉", "Chiba", "幕張"], "치바"],
  [["愛知", "名古屋", "Nagoya"], "나고야"],
  [["福岡", "Fukuoka"], "후쿠오카"],
  [["北海道", "札幌", "Sapporo"], "삿포로"],
  [["宮城", "仙台", "Sendai"], "센다이"],
  [["広島", "Hiroshima"], "히로시마"],
  [["京都", "Kyoto"], "교토"],
  [["兵庫", "神戸", "Kobe"], "고베"],
  [["沖縄", "那覇", "Okinawa"], "오키나와"],
];

function mapCity(value: string) {
  const text = compactText(value);
  for (const [signals, city] of cityAliases) {
    if (signals.some((signal) => text.toLowerCase().includes(signal.toLowerCase()))) return city;
  }
  return text || "도시 미정";
}

function pageTitle($: cheerio.CheerioAPI) {
  const title =
    $("meta[property='og:title']").attr("content") ||
    $("meta[name='twitter:title']").attr("content") ||
    $("title").first().text();

  return compactText(title)
    .replace(/\s*Tickets,\s*Tour and Concert Dates.*$/i, "")
    .replace(/\s*–\s*www\.livenationhip\.co\.jp.*$/i, "")
    .trim();
}

function artistFromTitle(title: string) {
  if (title.includes(" - ")) return compactText(title.split(" - ")[0]);
  if (title.includes(":")) return compactText(title.split(":")[0]);
  return title || "Live Nation H.I.P. 공연";
}

function pageImage($: cheerio.CheerioAPI, sourceUrl: string) {
  const image =
    $("meta[property='og:image']").attr("content") ||
    $("img[src*='networksites']").first().attr("src") ||
    $("img[src]").first().attr("src");
  if (!image) return null;
  try {
    return new URL(image, sourceUrl).toString();
  } catch {
    return null;
  }
}

function normalizeUrl(value: string | null | undefined, baseUrl = "https://www.livenationhip.co.jp/") {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function ticketLinkFromPage($: cheerio.CheerioAPI, sourceUrl: string) {
  const sourceHost = new URL(sourceUrl).hostname;
  const ignoredHosts = new Set([
    "www.instagram.com",
    "x.com",
    "www.facebook.com",
    "www.youtube.com",
    "privacy.livenation.co.jp",
    "www.tenbai-no.jp",
  ]);

  const candidates: string[] = [];
  $("a[href]").each((_, element) => {
    const href = normalizeUrl($(element).attr("href"), sourceUrl);
    if (!href) return;
    const url = new URL(href);
    const label = compactText($(element).text());
    if (ignoredHosts.has(url.hostname)) return;
    if (url.hostname === sourceHost && !url.pathname.includes("/all-events/")) return;
    if (/venue|vdp|arena|privacy|cookie/i.test(url.pathname)) return;
    const ticketHost = /(^|\.)w\.pia\.jp$|(^|\.)t\.pia\.jp$|(^|\.)ticket\.pia\.jp$|eplus\.jp|l-tike\.com|ticket|rakuten/i.test(
      url.hostname,
    );
    const ticketLabel = /ticket|チケット|購入|受付|抽選|先行|発売|ローソン|イープラス/i.test(label);
    if (ticketHost || ticketLabel) {
      candidates.push(href);
    }
  });

  return candidates.find((href) => new URL(href).hostname !== sourceHost) ?? candidates[0] ?? sourceUrl;
}

function scheduleSections(pageText: string) {
  const sections = Array.from(pageText.matchAll(/SCHEDULE(.+?)TICKETS/g))
    .map((match) => match[1])
    .filter((section) => /20\d{2}年/.test(section) && /OPEN|START/.test(section));
  return sections.length > 0 ? sections : [pageText];
}

function formatDate(year: string, month: string, day: string) {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function formatTime(value: string | undefined) {
  if (!value) return null;
  const [hour, minute] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute}`;
}

function priceFromText(value: string) {
  const prices = Array.from(value.matchAll(/[￥¥]\s*[\d,]+/g)).map((match) => match[0].replace(/\s+/g, ""));
  if (prices.length === 0) return null;
  return Array.from(new Set(prices)).slice(0, 5).join(" / ");
}

function saleTypeFromText(value: string) {
  if (/(抽選|先行|プレリザーブ|プレオーダー|受付開始)/.test(value)) return "추첨 접수";
  if (/(発売中|販売中|先着|当日券)/.test(value)) return "선착 판매";
  return "일반 판매";
}

function saleWindowFromPage($: cheerio.CheerioAPI, pageText: string, scheduleText: string) {
  const linkedWindow: string[] = [];
  $("a[href]").each((_, element) => {
    const label = compactText($(element).text());
    if (/\d{1,2}\/\d{1,2}.+(?:~|〜|～|-).+\d{1,2}\/\d{1,2}/.test(label)) linkedWindow.push(label);
  });
  if (linkedWindow.length > 0) return `受付期間: ${linkedWindow[0]}`;

  const advance = pageText.match(/(?:オフィシャル|最速|抽選|先行|受付)[^。!！]{0,90}/);
  if (advance) return compactText(advance[0]);
  if (/SOLD OUT/i.test(scheduleText)) return "SOLD OUT 포함";
  return null;
}

function ticketAccessFromPage(pageText: string) {
  if (/海外|Overseas|English|International/i.test(pageText)) {
    return {
      ticket_access: "한국 구매 가능",
      phone_required: false,
      foreigner_note: "Live Nation H.I.P. 원본 페이지에 해외 또는 영문 안내가 있는 공연입니다. 결제/수령 조건은 원본 링크에서 다시 확인하세요.",
    };
  }

  return {
    ticket_access: "확인 필요",
    phone_required: true,
    foreigner_note:
      "Live Nation H.I.P. 공연은 Ticket Pia 등 외부 예매처와 연동되는 경우가 많아 일본 전화번호, 결제수단, 티켓 수령 조건을 원본 링크에서 확인하세요.",
  };
}

function isLikelyLiveNationHipConcert(title: string, pageText: string) {
  if (/(BUS|バス|shuttle|parking|駐車|配信|streaming|sport|スポーツ|theater|舞台|演劇|映画|cinema)/i.test(title)) {
    return false;
  }
  return /(live|tour|concert|music|ライブ|コンサート|ツアー|フェス|公演|来日|音楽)/i.test(`${title} ${pageText}`);
}

export function liveNationHipLogicalEventKey(
  row: Pick<LiveNationHipEventRow, "title" | "date" | "time" | "venue" | "city">,
) {
  return [row.title, row.date, row.time ?? "", row.venue, row.city]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

export function extractLiveNationHipDetailUrls(html: string, baseUrl = "https://www.livenationhip.co.jp/") {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = normalizeUrl($(element).attr("href"), baseUrl);
    if (!href) return;
    const url = new URL(href);
    if (url.hostname === "www.livenationhip.co.jp" && /^\/all-events\/.+-tickets-ae\d+\/?$/.test(url.pathname)) {
      urls.add(url.toString().replace(/\/?$/, ""));
    }
  });

  return Array.from(urls);
}

export function extractLiveNationHipRows(html: string, sourceUrl: string, now = new Date()) {
  const $ = cheerio.load(html);
  const title = pageTitle($);
  const artist = artistFromTitle(title);
  const image = pageImage($, sourceUrl);
  const pageText = pageVisibleText($);
  const link = ticketLinkFromPage($, sourceUrl);
  const access = ticketAccessFromPage(pageText);
  const rows: LiveNationHipEventRow[] = [];

  if (!title || !isLikelyLiveNationHipConcert(title, pageText)) return rows;

  for (const section of scheduleSections(pageText)) {
    const scheduleMatcher =
      /(?:【(?<statusBefore>[^】]+)】)?\s*(?<year>20\d{2})年\s*(?<month>\d{1,2})月\s*(?<day>\d{1,2})日(?:\([^)]+\))?\s*(?<venue>.+?)OPEN\s*(?<door>\d{1,2}:\d{2})\s*\/\s*START\s*(?<start>\d{1,2}:\d{2})/g;

    for (const match of section.matchAll(scheduleMatcher)) {
      const groups = match.groups;
      if (!groups) continue;

      const date = formatDate(groups.year, groups.month, groups.day);
      if (new Date(`${date}T23:59:59+09:00`).getTime() < now.getTime()) continue;

      const venue = compactText(groups.venue.replace(/【[^】]+】/g, " "));
      if (!venue) continue;

      const city = mapCity(venue);
      rows.push({
        source: liveNationHipSource,
        source_event_id: `${sourceUrl}#${date}-${encodeURIComponent(venue)}`,
        artist,
        title,
        city,
        venue,
        date,
        time: formatTime(groups.start),
        genre: "Music",
        sale_type: saleTypeFromText(`${pageText} ${groups.statusBefore ?? ""}`),
        sale_window: saleWindowFromPage($, pageText, section),
        price: priceFromText(pageText),
        link,
        image,
        country_code: "JP",
        raw: {
          sourceUrl,
          schedule: compactText(match[0]),
        },
        ...access,
      });
    }
  }

  return rows;
}

async function main() {
  const startedAt = new Date();
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const detailUrls = new Set<string>();
  for (const indexUrl of liveNationHipIndexUrls()) {
    const html = await fetchLiveNationHipPage(indexUrl);
    for (const detailUrl of extractLiveNationHipDetailUrls(html, indexUrl)) {
      detailUrls.add(detailUrl);
      if (detailUrls.size >= liveNationHipRowLimit) break;
    }
    if (detailUrls.size >= liveNationHipRowLimit) break;
  }

  const collected = new Map<string, LiveNationHipEventRow>();
  let fetchedCount = 0;
  for (const detailUrl of detailUrls) {
    const html = await fetchLiveNationHipPage(detailUrl);
    fetchedCount += 1;
    for (const row of extractLiveNationHipRows(html, detailUrl, startedAt)) {
      const key = liveNationHipLogicalEventKey(row);
      if (!collected.has(key)) collected.set(key, row);
      if (collected.size >= liveNationHipRowLimit) break;
    }
    if (collected.size >= liveNationHipRowLimit) break;
  }

  const rows = [...collected.values()];
  const skippedCount = Math.max(fetchedCount - rows.length, 0);
  if (rows.length === 0) {
    await recordSyncRun(supabase, {
      source: liveNationHipSource,
      status: "success",
      fetchedCount,
      skippedCount,
      message: "No usable Live Nation H.I.P. rows were found. Existing Live Nation H.I.P. rows were preserved.",
      startedAt,
    });
    console.log("No usable Live Nation H.I.P. rows were found.");
    return;
  }

  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: liveNationHipSource,
      status: "error",
      fetchedCount,
      skippedCount,
      message: error.message,
      startedAt,
    });
    throw new Error(`Supabase Live Nation H.I.P. upsert failed: ${error.message}`);
  }

  const { error: staleError, count: staleDeletedCount } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("source", liveNationHipSource)
    .not("source_event_id", "in", postgrestStringList(rows.map((row) => row.source_event_id)));

  if (staleError) {
    await recordSyncRun(supabase, {
      source: liveNationHipSource,
      status: "error",
      fetchedCount,
      skippedCount,
      message: staleError.message,
      startedAt,
    });
    throw new Error(`Supabase stale Live Nation H.I.P. cleanup failed: ${staleError.message}`);
  }

  await recordSyncRun(supabase, {
    source: liveNationHipSource,
    status: "success",
    fetchedCount,
    upsertedCount: rows.length,
    skippedCount,
    message: `Synced ${rows.length} Live Nation H.I.P. public schedule events. Removed ${staleDeletedCount ?? 0} stale Live Nation H.I.P. rows.`,
    startedAt,
  });
  console.log(`Synced ${rows.length} Live Nation H.I.P. events. Skipped ${skippedCount}. Removed ${staleDeletedCount ?? 0} stale rows.`);
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
