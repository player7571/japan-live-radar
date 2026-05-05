import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { recordSyncRun } from "../src/lib/syncRuns";

type EplusReception = {
  hambai_hoho_label?: string | null;
  uketsuke_name_pc?: string | null;
  uketsuke_name_mobile?: string | null;
  uketsuke_start_datetime?: string | null;
  uketsuke_end_datetime?: string | null;
  uketsuke_status?: string | null;
  shutsuensha?: string | null;
};

type EplusRecord = {
  koenbi_term?: string | null;
  koenbi_hyoji_mongon?: string | null;
  kaien_time?: string | null;
  kanren_venue?: {
    venue_name?: string | null;
    todofuken_name?: string | null;
  } | null;
  kanren_uketsuke_koen_list?: EplusReception[] | null;
  kanren_kogyo_sub?: {
    kogyo_code?: string | null;
    kogyo_sub_code?: string | null;
    kogyo_name_1?: string | null;
    kogyo_name_2?: string | null;
  } | null;
  koen_detail_url_pc?: string | null;
};

type EplusPayload = {
  data?: {
    record_list?: EplusRecord[];
  };
};

type EplusEventRow = {
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
  raw: EplusRecord;
};

const defaultEplusKeywords = ["J-POP", "K-POP", "ライブ", "コンサート", "フェス", "ROCK"];

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const eplusFetchTimeoutMs = normalizeEplusFetchTimeoutMs(process.env.EPLUS_FETCH_TIMEOUT_MS);
const eplusRowLimit = normalizeEplusRowLimit(process.env.EPLUS_ROW_LIMIT);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function normalizeEplusFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function normalizeEplusRowLimit(value: string | undefined) {
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

export function eplusSearchUrls() {
  const explicitUrls = envList("EPLUS_SEARCH_URLS");
  if (explicitUrls.length > 0) return explicitUrls.slice(0, 8);

  const keywords = envList("EPLUS_SYNC_KEYWORDS");
  const defaultKeywords = keywords.length > 0 ? keywords : defaultEplusKeywords;
  return defaultKeywords.slice(0, 8).map((keyword) => {
    const url = new URL("https://eplus.jp/sf/search");
    url.searchParams.set("keyword", keyword);
    return url.toString();
  });
}

async function fetchEplusPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JapanLiveRadar/0.1 (+https://japan-live-radar.vercel.app)",
    },
    signal: AbortSignal.timeout(eplusFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`e+ request failed for ${url}: ${response.status} ${await response.text()}`);
  }

  return response.text();
}

export function extractEplusPayload(html: string) {
  const $ = cheerio.load(html);
  const raw = $("script#json").first().text().trim();
  if (!raw) return null;
  return JSON.parse(raw) as EplusPayload;
}

function compactText(value: string | null | undefined) {
  if (!value) return "";
  return cheerio.load(value).text().replace(/\s+/g, " ").trim();
}

function formatEplusDate(value: string | null | undefined) {
  const match = value?.match(/\d{8}/);
  if (!match) return null;
  const raw = match[0];
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function formatEplusTime(value: string | null | undefined) {
  if (!value || !/^\d{4}$/.test(value)) return null;
  return `${value.slice(0, 2)}:${value.slice(2, 4)}`;
}

function formatEplusDateTime(value: string | null | undefined) {
  if (!value || !/^\d{14}$/.test(value)) return null;
  return `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`;
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

const concertSignals = [
  "live",
  "Live",
  "LIVE",
  "ライブ",
  "コンサート",
  "ツアー",
  "フェス",
  "band",
  "Band",
  "BAND",
  "バンド",
  "rock",
  "Rock",
  "ROCK",
  "j-pop",
  "J-POP",
  "k-pop",
  "K-POP",
  "idol",
  "アイドル",
  "music",
  "Music",
  "MUSIC",
  "音楽",
];

const nonConcertSignals = [
  "Streaming+",
  "LIVE配信",
  "配信",
  "お話し会",
  "撮影会",
  "舞台",
  "演劇",
  "スポーツ",
  "野球",
  "サッカー",
  "バスケット",
  "Coffee",
  "コーヒー",
  "餃子",
  "うまいもの",
  "グルメ",
];

function recordText(record: EplusRecord) {
  return [
    record.kanren_kogyo_sub?.kogyo_name_1,
    record.kanren_kogyo_sub?.kogyo_name_2,
    record.kanren_venue?.venue_name,
    ...(record.kanren_uketsuke_koen_list ?? []).flatMap((reception) => [
      reception.uketsuke_name_pc,
      reception.uketsuke_name_mobile,
      reception.shutsuensha,
    ]),
  ]
    .map(compactText)
    .filter(Boolean)
    .join(" ");
}

export function isLikelyEplusConcert(record: EplusRecord) {
  const text = recordText(record);
  if (!text) return false;
  if (nonConcertSignals.some((signal) => text.includes(signal))) return false;
  return concertSignals.some((signal) => text.includes(signal));
}

function postgrestStringList(values: string[]) {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")})`;
}

function eplusDisplayTitle(value: string) {
  return value
    .replace(/^(?:【[^】]*(?:先行|早割|受付|抽選|一般|発売|販売)[^】]*】\s*)+/g, "")
    .replace(/^(?:\[[^\]]*(?:先行|早割|受付|抽選|一般|発売|販売)[^\]]*\]\s*)+/gi, "")
    .trim();
}

function eplusTitle(record: EplusRecord) {
  const names = [
    compactText(record.kanren_kogyo_sub?.kogyo_name_1),
    compactText(record.kanren_kogyo_sub?.kogyo_name_2),
  ].filter(Boolean);
  const title = names.join(" ").trim();
  return eplusDisplayTitle(title) || title || "e+ 공연";
}

function eplusSaleType(record: EplusRecord) {
  const labels = (record.kanren_uketsuke_koen_list ?? [])
    .map((reception) => `${reception.hambai_hoho_label ?? ""} ${reception.uketsuke_name_pc ?? ""}`)
    .join(" ");
  if (labels.includes("プレオーダー") || labels.includes("抽選")) return "추첨 접수";
  if (labels.includes("先着")) return "선착 판매";
  return "일반 판매";
}

function eplusSaleWindow(record: EplusRecord) {
  const windows = (record.kanren_uketsuke_koen_list ?? [])
    .slice(0, 3)
    .map((reception) => {
      const label = compactText(reception.uketsuke_name_pc) || compactText(reception.hambai_hoho_label) || "판매";
      const start = formatEplusDateTime(reception.uketsuke_start_datetime) ?? "시작일 확인 필요";
      const end = formatEplusDateTime(reception.uketsuke_end_datetime) ?? "종료일 확인 필요";
      return `${label}: ${start} - ${end}`;
    });
  return windows.length > 0 ? windows.join(" / ") : null;
}

function eplusLink(record: EplusRecord) {
  const raw = record.koen_detail_url_pc;
  if (!raw) return null;
  return new URL(raw, "https://eplus.jp").toString();
}

export function eplusLogicalEventKey(row: Pick<EplusEventRow, "title" | "date" | "time" | "venue" | "city">) {
  return [row.title, row.date, row.time ?? "", row.venue, row.city]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

function mergeSaleType(current: string, next: string) {
  if (current === next) return current;
  const labels = [current, next];
  if (labels.includes("추첨 접수") && labels.includes("선착 판매")) return "추첨/선착 판매";
  return labels.includes("추첨 접수") ? "추첨 접수" : labels.includes("선착 판매") ? "선착 판매" : current;
}

function mergeSaleWindow(current: string | null, next: string | null) {
  const windows = [...(current?.split(" / ") ?? []), ...(next?.split(" / ") ?? [])]
    .map((window) => window.trim())
    .filter(Boolean);
  return windows.length > 0 ? Array.from(new Set(windows)).slice(0, 6).join(" / ") : null;
}

export function mergeEplusEventRows(current: EplusEventRow, next: EplusEventRow) {
  return {
    ...current,
    sale_type: mergeSaleType(current.sale_type, next.sale_type),
    sale_window: mergeSaleWindow(current.sale_window, next.sale_window),
  };
}

export function toEplusEventRow(record: EplusRecord, now = new Date()): EplusEventRow | null {
  const date = formatEplusDate(record.koenbi_term);
  const link = eplusLink(record);
  const venue = compactText(record.kanren_venue?.venue_name);
  const title = eplusTitle(record);
  if (!date || !link || !venue || !isLikelyEplusConcert(record)) return null;
  if (new Date(`${date}T23:59:59+09:00`).getTime() < now.getTime()) return null;

  return {
    source: "e+",
    source_event_id: link,
    artist: title,
    title,
    city: mapCity(record.kanren_venue?.todofuken_name, venue),
    venue,
    date,
    time: formatEplusTime(record.kaien_time),
    genre: "Music",
    ticket_access: "일본 번호 필요",
    sale_type: eplusSaleType(record),
    sale_window: eplusSaleWindow(record),
    price: null,
    phone_required: true,
    foreigner_note: "e+는 일본 계정, 전화번호 인증, 결제/수령 제한이 있을 수 있어 원본에서 조건을 확인하세요.",
    link,
    image: null,
    country_code: "JP",
    raw: record,
  };
}

async function main() {
  const startedAt = new Date();
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const collected = new Map<string, EplusEventRow>();
  let fetchedCount = 0;

  for (const url of eplusSearchUrls()) {
    const html = await fetchEplusPage(url);
    const payload = extractEplusPayload(html);
    const records = payload?.data?.record_list ?? [];
    fetchedCount += records.length;
    for (const record of records) {
      const row = toEplusEventRow(record, startedAt);
      if (row) {
        const key = eplusLogicalEventKey(row);
        const current = collected.get(key);
        collected.set(key, current ? mergeEplusEventRows(current, row) : row);
      }
      if (collected.size >= eplusRowLimit) break;
    }
    if (collected.size >= eplusRowLimit) break;
  }

  const rows = [...collected.values()];
  const skippedCount = fetchedCount - rows.length;
  if (rows.length === 0) {
    await recordSyncRun(supabase, {
      source: "e+",
      status: "success",
      fetchedCount,
      skippedCount,
      message: "No usable e+ concert rows were found.",
      startedAt,
    });
    console.log("No usable e+ concert rows were found.");
    return;
  }

  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: "e+",
      status: "error",
      fetchedCount,
      skippedCount,
      message: error.message,
      startedAt,
    });
    throw new Error(`Supabase e+ upsert failed: ${error.message}`);
  }

  const { error: staleError, count: staleDeletedCount } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("source", "e+")
    .not("source_event_id", "in", postgrestStringList(rows.map((row) => row.source_event_id)));

  if (staleError) {
    await recordSyncRun(supabase, {
      source: "e+",
      status: "error",
      fetchedCount,
      skippedCount,
      message: staleError.message,
      startedAt,
    });
    throw new Error(`Supabase stale e+ cleanup failed: ${staleError.message}`);
  }

  await recordSyncRun(supabase, {
    source: "e+",
    status: "success",
    fetchedCount,
    upsertedCount: rows.length,
    skippedCount,
    message: `Synced ${rows.length} e+ public search events. Removed ${staleDeletedCount ?? 0} stale e+ rows.`,
    startedAt,
  });
  console.log(`Synced ${rows.length} e+ events. Skipped ${skippedCount}. Removed ${staleDeletedCount ?? 0} stale rows.`);
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
