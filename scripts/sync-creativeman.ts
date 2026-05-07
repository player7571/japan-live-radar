import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { recordSyncRun } from "../src/lib/syncRuns";

type CreativemanEventRow = {
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

const creativemanSource = "Creativeman";
const defaultCreativemanIndexUrls = [
  "https://www.creativeman.co.jp/upcoming/",
  "https://www.creativeman.co.jp/event/",
];

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const creativemanFetchTimeoutMs = normalizeCreativemanFetchTimeoutMs(process.env.CREATIVEMAN_FETCH_TIMEOUT_MS);
const creativemanIndexLimit = normalizeCreativemanIndexLimit(process.env.CREATIVEMAN_INDEX_LIMIT);
const creativemanRowLimit = normalizeCreativemanRowLimit(process.env.CREATIVEMAN_ROW_LIMIT);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normalizeCreativemanFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function normalizeCreativemanIndexLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(Math.max(Math.trunc(parsed), 1), 6);
}

export function normalizeCreativemanRowLimit(value: string | undefined) {
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

export function creativemanIndexUrls() {
  const explicitUrls = envList("CREATIVEMAN_INDEX_URLS");
  return (explicitUrls.length > 0 ? explicitUrls : defaultCreativemanIndexUrls).slice(0, creativemanIndexLimit);
}

async function fetchCreativemanPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JapanLiveRadar/0.1 (+https://japan-live-radar.vercel.app)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(creativemanFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Creativeman request failed for ${url}: ${response.status} ${await response.text()}`);
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
  [["東京", "東京都"], "도쿄"],
  [["大阪", "大阪府"], "오사카"],
  [["神奈川", "横浜"], "요코하마"],
  [["千葉", "幕張"], "치바"],
  [["愛知", "名古屋"], "나고야"],
  [["福岡"], "후쿠오카"],
  [["北海道", "札幌"], "삿포로"],
  [["宮城", "仙台"], "센다이"],
  [["石川", "金沢"], "가나자와"],
  [["広島"], "히로시마"],
  [["京都"], "교토"],
  [["兵庫", "神戸"], "고베"],
  [["沖縄", "那覇"], "오키나와"],
];

function mapCity(value: string) {
  const text = compactText(value);
  for (const [signals, city] of cityAliases) {
    if (signals.some((signal) => text.includes(signal))) return city;
  }
  return text || "도시 미정";
}

function eventArtist($: cheerio.CheerioAPI) {
  return compactText($("h1").first().text())
    .replace(/\s+/g, " ")
    .replace(/\s+CREATIVEMAN PRODUCTIONS$/i, "")
    .trim() || "Creativeman 공연";
}

function eventTitle($: cheerio.CheerioAPI, artist: string) {
  const title = compactText($("title").first().text())
    .replace(/\s*[-|｜]\s*CREATIVEMAN PRODUCTIONS.*$/i, "")
    .trim();
  return title || artist;
}

function pageImage($: cheerio.CheerioAPI, sourceUrl: string) {
  const image = $("meta[property='og:image']").attr("content") || $("img[src]").first().attr("src");
  if (!image) return null;
  try {
    return new URL(image, sourceUrl).toString();
  } catch {
    return null;
  }
}

function formatCreativemanDate(value: string) {
  const match = value.match(/(20\d{2})[/.年]\s*(\d{1,2})[/.月]\s*(\d{1,2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function formatCreativemanTime(value: string) {
  const startMatch = value.match(/START\s*(\d{1,2}):(\d{2})/i);
  const fallbackMatch = value.match(/開演\s*(\d{1,2}):(\d{2})/);
  const match = startMatch ?? fallbackMatch;
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function priceFromBlock(value: string) {
  const prices = Array.from(value.matchAll(/[￥¥]\s*[\d,]+/g)).map((match) => match[0].replace(/\s+/g, ""));
  if (prices.length === 0) return null;
  return Array.from(new Set(prices)).slice(0, 4).join(" / ");
}

function saleTypeFromBlock(value: string) {
  if (/(抽選|先行|プレリザーブ|プレオーダー|プレリクエスト)/.test(value)) return "추첨 접수";
  if (/(発売中|当日券|販売中|先着)/.test(value)) return "선착 판매";
  return "일반 판매";
}

function saleWindowFromBlock(value: string) {
  const boundary =
    String.raw`(?:チケット発売日|注意事項|INFO|プレイガイド|主催|企画|制作|ARTIST|こちらもチェック|ACCESS\s+RANKING|FAQ|NEWS|UPCOMING|FESTIVALS|COMPANY|PRIVACY\s+POLICY|©|var\s|window\.|\{"@context"|$)`;
  const window = value.match(new RegExp(`期間[:：]\\s*(.+?)(?=\\s*${boundary})`));
  if (window) return `受付期間: ${compactText(window[1])}`;
  const saleDate = value.match(new RegExp(`チケット発売日\\s*[|｜]?\\s*(.+?)(?=\\s*${boundary})`));
  if (saleDate) return `発売日: ${compactText(saleDate[1])}`;
  if (value.includes("当日券")) return "当日券あり";
  if (value.includes("SOLD OUT")) return "SOLD OUT";
  if (value.includes("発売中")) return "発売中";
  return null;
}

function normalizeCreativemanVenue(value: string) {
  const normalized = compactText(value)
    .replace(/\s+(?:出演者|ACT|GUEST|ゲスト|サポートアクト)\s+.*$/i, "")
    .replace(/(?:チケット)?(?:販売終了|受付終了|販売中|発売中|予定枚数終了|売切|売り切れ|完売|SOLD OUT|当日券|残りわずか)+$/i, "")
    .trim();
  return normalized || compactText(value);
}

function ticketAccessFromPage(pageText: string) {
  if (/Purchasing Tickets from Overseas|海外.*(?:購入|販売)|w\.pia\.jp\/a\/.*eng/i.test(pageText)) {
    return {
      ticket_access: "한국 구매 가능",
      phone_required: false,
      foreigner_note: "Creativeman 원본 페이지에 해외 구매 안내가 있으나, 공연별 결제/수령 조건은 원본 링크에서 다시 확인하세요.",
    };
  }

  return {
    ticket_access: "확인 필요",
    phone_required: true,
    foreigner_note:
      "Creativeman 공연은 Ticket Pia, e+, Lawson 등 외부 예매처로 이동하는 경우가 많아 계정, 전화번호 인증, 결제/수령 조건을 원본에서 확인하세요.",
  };
}

function isLikelyCreativemanConcert(text: string) {
  if (/(ONLINE LIVE|配信|舞台|演劇|ミュージカル|スポーツ|野球|サッカー|バスケット|お笑い|トークショー)/i.test(text)) {
    return false;
  }
  return /(LIVE|Live|ライブ|コンサート|ツアー|フェス|ROCK|ロック|J-POP|K-POP|公演|発売中|SOLD OUT|当日券)/.test(text);
}

export function creativemanLogicalEventKey(
  row: Pick<CreativemanEventRow, "title" | "date" | "time" | "venue" | "city">,
) {
  return [row.title, row.date, row.time ?? "", row.venue, row.city]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

export function extractCreativemanDetailUrls(html: string, baseUrl = "https://www.creativeman.co.jp/") {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      if (url.hostname === "www.creativeman.co.jp" && /^\/event\/[^/]+\/?$/.test(url.pathname)) {
        urls.add(url.toString().replace(/\/?$/, "/"));
      }
    } catch {
      // Ignore malformed marketing links.
    }
  });

  return Array.from(urls);
}

export function extractCreativemanRows(html: string, sourceUrl: string, now = new Date()) {
  const $ = cheerio.load(html);
  const artist = eventArtist($);
  const title = eventTitle($, artist);
  const image = pageImage($, sourceUrl);
  const pageText = compactText($("body").text());
  const access = ticketAccessFromPage(pageText);
  const lines = pageText.split(/\s*(?=(?:東京|大阪|神奈川|千葉|愛知|福岡|北海道|宮城|石川|広島|京都|兵庫|沖縄)\s+20\d{2}[/.年])/g);
  const rows: CreativemanEventRow[] = [];

  for (const block of lines) {
    const header = block.match(/^(東京|大阪|神奈川|千葉|愛知|福岡|北海道|宮城|石川|広島|京都|兵庫|沖縄)\s+(20\d{2}[/.年]\s*\d{1,2}[/.月]\s*\d{1,2}(?:日)?[^\s]*)\s+(.+?)(?=\s+(?:チケット|SOLD OUT|当日券|残りわずか|出演者|ACT|GUEST|ゲスト|サポートアクト|開場|OPEN|---)|$)/);
    if (!header) continue;

    const [, cityLabel, rawDate, rawVenue] = header;
    const date = formatCreativemanDate(rawDate);
    const venue = normalizeCreativemanVenue(rawVenue);
    const searchText = `${artist} ${title} ${block}`;
    if (!date || !venue || !isLikelyCreativemanConcert(searchText)) continue;
    if (new Date(`${date}T23:59:59+09:00`).getTime() < now.getTime()) continue;

    const city = mapCity(cityLabel);
    const time = formatCreativemanTime(block);
    const source_event_id = `${sourceUrl}#${date}-${encodeURIComponent(venue)}`;
    rows.push({
      source: creativemanSource,
      source_event_id,
      artist,
      title,
      city,
      venue,
      date,
      time,
      genre: "Music",
      sale_type: saleTypeFromBlock(block),
      sale_window: saleWindowFromBlock(block),
      price: priceFromBlock(block),
      link: sourceUrl,
      image,
      country_code: "JP",
      raw: { sourceUrl, block: compactText(block) },
      ...access,
    });
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
  for (const indexUrl of creativemanIndexUrls()) {
    const html = await fetchCreativemanPage(indexUrl);
    for (const detailUrl of extractCreativemanDetailUrls(html, indexUrl)) {
      detailUrls.add(detailUrl);
      if (detailUrls.size >= creativemanRowLimit) break;
    }
    if (detailUrls.size >= creativemanRowLimit) break;
  }

  const collected = new Map<string, CreativemanEventRow>();
  let fetchedCount = 0;
  for (const detailUrl of detailUrls) {
    const html = await fetchCreativemanPage(detailUrl);
    fetchedCount += 1;
    for (const row of extractCreativemanRows(html, detailUrl, startedAt)) {
      const key = creativemanLogicalEventKey(row);
      if (!collected.has(key)) collected.set(key, row);
      if (collected.size >= creativemanRowLimit) break;
    }
    if (collected.size >= creativemanRowLimit) break;
  }

  const rows = [...collected.values()];
  const skippedCount = Math.max(fetchedCount - rows.length, 0);
  if (rows.length === 0) {
    await recordSyncRun(supabase, {
      source: creativemanSource,
      status: "success",
      fetchedCount,
      skippedCount,
      message: "No usable Creativeman rows were found.",
      startedAt,
    });
    console.log("No usable Creativeman rows were found.");
    return;
  }

  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: creativemanSource,
      status: "error",
      fetchedCount,
      skippedCount,
      message: error.message,
      startedAt,
    });
    throw new Error(`Supabase Creativeman upsert failed: ${error.message}`);
  }

  const { error: staleError, count: staleDeletedCount } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("source", creativemanSource)
    .not("source_event_id", "in", postgrestStringList(rows.map((row) => row.source_event_id)));

  if (staleError) {
    await recordSyncRun(supabase, {
      source: creativemanSource,
      status: "error",
      fetchedCount,
      skippedCount,
      message: staleError.message,
      startedAt,
    });
    throw new Error(`Supabase stale Creativeman cleanup failed: ${staleError.message}`);
  }

  await recordSyncRun(supabase, {
    source: creativemanSource,
    status: "success",
    fetchedCount,
    upsertedCount: rows.length,
    skippedCount,
    message: `Synced ${rows.length} Creativeman public schedule events. Removed ${staleDeletedCount ?? 0} stale Creativeman rows.`,
    startedAt,
  });
  console.log(`Synced ${rows.length} Creativeman events. Skipped ${skippedCount}. Removed ${staleDeletedCount ?? 0} stale rows.`);
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
