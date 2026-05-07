import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { recordSyncRun } from "../src/lib/syncRuns";

type LiveFansEventRow = {
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

const liveFansSource = "LiveFans";
const defaultLiveFansKeywords = ["K-POP", "J-POP", "ライブ", "コンサート", "フェス", "ROCK", "アジア"];

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const liveFansFetchTimeoutMs = normalizeLiveFansFetchTimeoutMs(process.env.LIVEFANS_FETCH_TIMEOUT_MS);
const liveFansKeywordLimit = normalizeLiveFansKeywordLimit(process.env.LIVEFANS_KEYWORD_LIMIT);
const liveFansRowLimit = normalizeLiveFansRowLimit(process.env.LIVEFANS_ROW_LIMIT);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normalizeLiveFansFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function normalizeLiveFansKeywordLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(Math.max(Math.trunc(parsed), 1), 8);
}

export function normalizeLiveFansRowLimit(value: string | undefined) {
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

export function liveFansSearchUrls() {
  const keywords = envList("LIVEFANS_SYNC_KEYWORDS");
  return (keywords.length > 0 ? keywords : defaultLiveFansKeywords)
    .slice(0, liveFansKeywordLimit)
    .map((keyword) => `https://www.livefans.jp/search?option=3&keyword=${encodeURIComponent(keyword)}`);
}

async function fetchLiveFansPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JapanLiveRadar/0.1 (+https://japan-live-radar.vercel.app)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(liveFansFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`LiveFans request failed for ${url}: ${response.status} ${await response.text()}`);
  }

  return response.text();
}

function compactText(value: string | null | undefined) {
  if (!value) return "";
  return cheerio.load(value).text().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function visibleText($: cheerio.CheerioAPI) {
  const body = $("body").clone();
  body.find("script, style, noscript").remove();
  return compactText(body.text());
}

function postgrestStringList(values: string[]) {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")})`;
}

const cityAliases: Array<[string[], string]> = [
  [["東京都", "東京", "Tokyo", "日本武道館", "有明", "渋谷"], "도쿄"],
  [["大阪府", "大阪", "Osaka"], "오사카"],
  [["神奈川県", "神奈川", "横浜", "Yokohama"], "요코하마"],
  [["千葉県", "千葉", "幕張", "Chiba"], "치바"],
  [["愛知県", "愛知", "名古屋", "Nagoya"], "나고야"],
  [["福岡県", "福岡", "Fukuoka"], "후쿠오카"],
  [["北海道", "札幌", "Sapporo"], "삿포로"],
  [["宮城県", "宮城", "仙台", "Sendai"], "센다이"],
  [["広島県", "広島", "Hiroshima"], "히로시마"],
  [["京都府", "京都", "Kyoto"], "교토"],
  [["兵庫県", "兵庫", "神戸", "Kobe"], "고베"],
  [["埼玉県", "埼玉", "さいたま", "Saitama"], "사이타마"],
  [["静岡県", "静岡", "Shizuoka"], "시즈오카"],
  [["沖縄県", "沖縄", "那覇", "Okinawa"], "오키나와"],
];

function mapCity(...values: string[]) {
  const text = values.map(compactText).join(" ");
  for (const [signals, city] of cityAliases) {
    if (signals.some((signal) => text.toLowerCase().includes(signal.toLowerCase()))) return city;
  }
  return "도시 미정";
}

function isJapanArea(value: string) {
  const text = compactText(value);
  return /(都|道|府|県)$/.test(text) || cityAliases.some(([signals]) => signals.some((signal) => text.includes(signal)));
}

function normalizeLiveFansUrl(value: string | null | undefined, baseUrl = "https://www.livefans.jp/") {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function decodeRedirectTarget(value: string) {
  try {
    const url = new URL(value);
    const target = url.searchParams.get("RD_PARM1");
    if (!target) return value;
    let decoded = target;
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    const targetUrl = new URL(decoded);
    if (targetUrl.protocol === "http:") targetUrl.protocol = "https:";
    return targetUrl.toString();
  } catch {
    return value;
  }
}

function ticketLinkFromPage($: cheerio.CheerioAPI, sourceUrl: string) {
  const candidates: string[] = [];
  $("a[href]").each((_, element) => {
    const href = normalizeLiveFansUrl($(element).attr("href"), sourceUrl);
    if (!href) return;
    const url = new URL(href);
    if (url.hostname === "www.livefans.jp" && /^\/tickets\/?$/.test(url.pathname)) return;
    const label = compactText($(element).text());
    if (/(チケット|ticket|一般発売|先行|抽選|ぴあ|ローチケ|イープラス)/i.test(`${label} ${href}`)) {
      candidates.push(decodeRedirectTarget(href));
    }
  });

  return candidates.find((href) => !href.includes("livefans.jp")) ?? candidates[0] ?? sourceUrl;
}

function titleFromPage($: cheerio.CheerioAPI) {
  const title = compactText($("title").first().text())
    .replace(/\s*[|｜]\s*ライブ・セットリスト情報サービス.*$/i, "")
    .replace(/\s*-\s*LiveFans.*$/i, "")
    .trim();
  return title.split(/\s+[＠@]\s+/)[0]?.trim() || title || "LiveFans 공연";
}

function eventTitleFromText(pageText: string, baseTitle: string, dateText: string) {
  const dateIndex = pageText.indexOf(dateText);
  if (dateIndex < 0) return baseTitle;
  const beforeDate = pageText
    .slice(Math.max(0, dateIndex - 220), dateIndex)
    .split("新規情報投稿")
    .pop();
  const candidate = compactText(beforeDate?.replace(/クリップ\d+人.*$/, ""));
  if (!candidate) return baseTitle;
  const duplicated = `${baseTitle} ${baseTitle}`;
  if (candidate.startsWith(duplicated)) return compactText(candidate.replace(baseTitle, ""));
  return candidate;
}

function pageImage($: cheerio.CheerioAPI, sourceUrl: string) {
  const image = $("meta[property='og:image']").attr("content") || $("img[src]").first().attr("src");
  if (!image) return null;
  return normalizeLiveFansUrl(image, sourceUrl);
}

function formatDate(value: string) {
  const match = value.match(/(20\d{2})[/.](\d{1,2})[/.](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function formatTime(value: string | undefined) {
  if (!value) return null;
  const [hour, minute] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute}`;
}

function saleWindowFromText(text: string) {
  const normalized = compactText(text);
  const sale = normalized.match(/(抽選|先行|一般発売|リセール)[^ ]{0,30}(発売中|受付中)?\s*(?:[~〜～]\s*)?(20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})?/);
  if (!sale) return null;
  return compactText(sale[0]);
}

function saleTypeFromText(text: string) {
  if (/(抽選|先行|プレリザーブ|プレオーダー)/.test(text)) return "추첨 접수";
  if (/(発売中|販売中|一般発売|先着)/.test(text)) return "선착 판매";
  return "일반 판매";
}

function isLikelyLiveFansConcert(text: string) {
  if (/(オンラインライブ|配信|舞台|演劇|ミュージカル|スポーツ|映画|トークショー)/.test(text)) return false;
  return /(ライブ|コンサート|フェス|ツアー|公演|開演|出演|チケット|音楽)/.test(text);
}

export function liveFansLogicalEventKey(row: Pick<LiveFansEventRow, "title" | "date" | "time" | "venue" | "city">) {
  return [row.title, row.date, row.time ?? "", row.venue, row.city]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

export function extractLiveFansDetailUrls(html: string, baseUrl = "https://www.livefans.jp/") {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $("a[href^='/events/'], a[href*='livefans.jp/events/']").each((_, element) => {
    const href = normalizeLiveFansUrl($(element).attr("href"), baseUrl);
    if (!href) return;
    const url = new URL(href);
    if (url.hostname === "www.livefans.jp" && /^\/events\/\d+\/?$/.test(url.pathname)) {
      urls.add(url.toString().replace(/\/?$/, ""));
    }
  });

  return Array.from(urls);
}

export function extractLiveFansRows(html: string, sourceUrl: string, now = new Date()) {
  const $ = cheerio.load(html);
  const pageText = visibleText($);
  const baseTitle = titleFromPage($);
  const image = pageImage($, sourceUrl);
  const link = ticketLinkFromPage($, sourceUrl);
  const rows: LiveFansEventRow[] = [];

  const match = pageText.match(
    /(?<date>20\d{2}\/\d{1,2}\/\d{1,2})\s+\([^)]+\)\s*(?:(?<time>\d{1,2}:\d{2})\s+開演\s*)?@(?<venue>.+?)\s+\((?<area>[^)]+)\)\s*(?:\[出演\]\s*(?<artists>.+?)\s+)?この公演/,
  );
  if (!match?.groups) return rows;

  const date = formatDate(match.groups.date);
  if (!date || new Date(`${date}T23:59:59+09:00`).getTime() < now.getTime()) return rows;

  const title = eventTitleFromText(pageText, baseTitle, match.groups.date);
  const venue = compactText(match.groups.venue);
  const area = compactText(match.groups.area);
  if (!venue || !isJapanArea(area) || !isLikelyLiveFansConcert(`${title} ${match[0]}`)) return rows;

  const artists = compactText(match.groups.artists);
  const artist = artists.split(/\s*\/\s*/)[0]?.trim() || title;
  const ticketAccess = link.includes("ticket.pia.jp") || link.includes("l-tike.com") || link.includes("eplus.jp") ? "일본 번호 필요" : "확인 필요";

  rows.push({
    source: liveFansSource,
    source_event_id: sourceUrl,
    artist,
    title,
    city: mapCity(area, venue),
    venue,
    date,
    time: formatTime(match.groups.time),
    genre: "Music",
    ticket_access: ticketAccess,
    sale_type: saleTypeFromText(pageText),
    sale_window: saleWindowFromText(pageText),
    price: null,
    phone_required: true,
    foreigner_note:
      "LiveFans는 공연 정보와 외부 예매 링크를 함께 보여주는 공개 정보원입니다. 실제 예매는 연결된 Ticket Pia, e+, Lawson 등 원본 예매처의 계정, 전화번호, 결제/수령 조건을 확인하세요.",
    link,
    image,
    country_code: "JP",
    raw: {
      sourceUrl,
      performers: artists,
      area,
    },
  });

  return rows;
}

async function main() {
  const startedAt = new Date();
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const detailUrls = new Set<string>();
  for (const searchUrl of liveFansSearchUrls()) {
    const html = await fetchLiveFansPage(searchUrl);
    for (const detailUrl of extractLiveFansDetailUrls(html, searchUrl)) {
      detailUrls.add(detailUrl);
      if (detailUrls.size >= liveFansRowLimit) break;
    }
    if (detailUrls.size >= liveFansRowLimit) break;
  }

  const collected = new Map<string, LiveFansEventRow>();
  let fetchedCount = 0;
  for (const detailUrl of detailUrls) {
    const html = await fetchLiveFansPage(detailUrl);
    fetchedCount += 1;
    for (const row of extractLiveFansRows(html, detailUrl, startedAt)) {
      const key = liveFansLogicalEventKey(row);
      if (!collected.has(key)) collected.set(key, row);
      if (collected.size >= liveFansRowLimit) break;
    }
    if (collected.size >= liveFansRowLimit) break;
  }

  const rows = [...collected.values()];
  const skippedCount = Math.max(fetchedCount - rows.length, 0);
  if (rows.length === 0) {
    await recordSyncRun(supabase, {
      source: liveFansSource,
      status: "success",
      fetchedCount,
      skippedCount,
      message: "No usable LiveFans Japan concert rows were found. Existing LiveFans rows were preserved.",
      startedAt,
    });
    console.log("No usable LiveFans Japan concert rows were found.");
    return;
  }

  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: liveFansSource,
      status: "error",
      fetchedCount,
      skippedCount,
      message: error.message,
      startedAt,
    });
    throw new Error(`Supabase LiveFans upsert failed: ${error.message}`);
  }

  const { error: staleError, count: staleDeletedCount } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("source", liveFansSource)
    .not("source_event_id", "in", postgrestStringList(rows.map((row) => row.source_event_id)));

  if (staleError) {
    await recordSyncRun(supabase, {
      source: liveFansSource,
      status: "error",
      fetchedCount,
      skippedCount,
      message: staleError.message,
      startedAt,
    });
    throw new Error(`Supabase stale LiveFans cleanup failed: ${staleError.message}`);
  }

  await recordSyncRun(supabase, {
    source: liveFansSource,
    status: "success",
    fetchedCount,
    upsertedCount: rows.length,
    skippedCount,
    message: `Synced ${rows.length} LiveFans public concert events. Removed ${staleDeletedCount ?? 0} stale LiveFans rows.`,
    startedAt,
  });
  console.log(`Synced ${rows.length} LiveFans events. Skipped ${skippedCount}. Removed ${staleDeletedCount ?? 0} stale rows.`);
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
