import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import type { AdminEventInput } from "../src/lib/adminEventRows.js";
import { splitCandidateRowsByExistingStatus } from "../src/lib/candidateDedupe.js";
import { publicSearchSources, type PublicEventSource } from "../src/lib/publicSources.js";

type VercelRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type CandidateRow = {
  id: string;
  source: string;
  source_url: string | null;
  draft: AdminEventInput;
  status: "pending" | "approved" | "rejected";
  rejection_reason: string | null;
  approved_event_id: string | null;
  created_at: string;
  updated_at: string;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminApiToken = process.env.ADMIN_API_TOKEN;
const keywordSearchFetchTimeoutMs = 3_500;
const keywordDetailFetchTimeoutMs = 4_500;
const keywordSourceCandidateLimit = 2;
const keywordTotalCandidateLimit = 10;

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody(body: unknown) {
  if (typeof body === "string") {
    return JSON.parse(body) as { keyword?: unknown; keywords?: unknown };
  }
  if (body && typeof body === "object") {
    return body as { keyword?: unknown; keywords?: unknown };
  }
  return {};
}

function keywordsFromBody(body: { keyword?: unknown; keywords?: unknown }) {
  const rawValues = Array.isArray(body.keywords) ? body.keywords : [body.keyword];
  const keywords = rawValues
    .flatMap((value) => (typeof value === "string" ? value.split(/[\n,]+/) : []))
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(keywords)).slice(0, 8);
}

function missingCandidateTable(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.message?.includes("event_candidates")));
}

export function searchSources(keyword: string) {
  const encoded = encodeURIComponent(keyword);
  return publicSearchSources.map((source) => ({
    source: source.syncRunSource,
    url: source.searchUrl?.(encoded) ?? "",
  }));
}

function compactText(value: string | null | undefined) {
  if (!value) return "";
  return cheerio.load(value).text().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizedKeyword(value: string) {
  return compactText(value).toLowerCase();
}

function inputString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return compactText(value);
  }
  return "";
}

function searchHeaders() {
  return {
    "user-agent": "JapanLiveRadarBot/0.1 (+https://japan-live-radar.vercel.app)",
    accept: "text/html,application/xhtml+xml",
  };
}

function allowedSearchHost(hostname: string) {
  return [
    "ticketmaster.com",
    "eplus.jp",
    "l-tike.com",
    "t.pia.jp",
    "pia.jp",
    "ticket.rakuten.co.jp",
    "rakuten.co.jp",
    "creativeman.co.jp",
    "livenationhip.co.jp",
    "livefans.jp",
  ].some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function sourcePathScore(source: PublicEventSource, url: URL) {
  const host = url.hostname.toLowerCase();
  const path = decodeURIComponent(url.pathname);

  if (source.key === "creativeman") return host.includes("creativeman.co.jp") && /^\/event\/[^/]+\/?$/.test(path) ? 90 : 0;
  if (source.key === "livenation-hip") return host.includes("livenationhip.co.jp") && /\/all-events\/.+tickets/i.test(path) ? 90 : 0;
  if (source.key === "livefans") return host.includes("livefans.jp") && /^\/events\/\d+\/?$/.test(path) ? 90 : 0;
  if (source.key === "lawson") return host.includes("l-tike.com") && /(order|concert|search|event|artist)/i.test(path) ? 70 : 0;
  if (source.key === "eplus") return host.includes("eplus.jp") && /(sf\/detail|sf\/word|sys\/|artist)/i.test(path) ? 70 : 0;
  if (source.key === "ticket-pia") return /(pia\.jp|t\.pia\.jp)$/.test(host) && /(event|ticket|tour|artist|w\/)/i.test(path) ? 70 : 0;
  if (source.key === "rakuten-ticket") return host.includes("rakuten.co.jp") && path.split("/").filter(Boolean).length >= 1 ? 60 : 0;
  if (source.key === "ticketmaster") return host.includes("ticketmaster.com") && /(event|artist|concert|music)/i.test(path) ? 60 : 0;

  return allowedSearchHost(host) ? 20 : 0;
}

function linkPenalty(url: URL) {
  const value = `${url.hostname}${url.pathname}${url.search}`;
  if (/(login|signin|signup|member|mypage|cart|checkout|payment|help|guide|faq|privacy|terms|contact)/i.test(value)) return -100;
  if (/(twitter|x\.com|instagram|youtube|line\.me|facebook|tiktok)/i.test(url.hostname)) return -100;
  return 0;
}

function candidateLinkScore(source: PublicEventSource, url: URL, label: string, keyword: string) {
  if (!allowedSearchHost(url.hostname.toLowerCase())) return 0;
  const sourceScore = sourcePathScore(source, url);
  if (sourceScore <= 0) return 0;

  const normalized = normalizedKeyword(`${decodeURIComponent(url.href)} ${label}`);
  const keywordScore = normalized.includes(normalizedKeyword(keyword)) ? 30 : 0;
  return sourceScore + keywordScore + linkPenalty(url);
}

export function extractSearchCandidateUrls(
  html: string,
  baseUrl: string,
  keyword: string,
  source: PublicEventSource,
  limit = keywordSourceCandidateLimit,
) {
  const $ = cheerio.load(html);
  const scored = new Map<string, number>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || href.startsWith("#") || /^mailto:|^tel:/i.test(href)) return;
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      const score = candidateLinkScore(source, url, $(element).text(), keyword);
      if (score <= 0) return;
      const normalizedUrl = url.toString();
      scored.set(normalizedUrl, Math.max(scored.get(normalizedUrl) ?? 0, score));
    } catch {
      // Ignore malformed links from public search pages.
    }
  });

  return Array.from(scored.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([url]) => url);
}

function draftLooksUsable(draft: AdminEventInput, keyword: string) {
  const artist = inputString(draft.artist);
  const title = inputString(draft.title);
  const venue = inputString(draft.venue);
  const link = inputString(draft.link);
  const date = inputString(draft.date);
  const text = normalizedKeyword([artist, title, venue, link].join(" "));
  const keywordMatch = text.includes(normalizedKeyword(keyword));
  return Boolean(title && date && venue && (keywordMatch || artist));
}

function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];

  const item = value as Record<string, unknown>;
  const graph = Array.isArray(item["@graph"]) ? item["@graph"].flatMap(flattenJsonLd) : [];
  return [item, ...graph];
}

function jsonString(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((item): item is string => typeof item === "string") ?? "";
  return "";
}

function jsonObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeDate(value: string) {
  const normalized = value.normalize("NFKC");
  const isoDate = normalized.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;

  const jpDate = normalized.match(/(\d{4})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/)?.slice(1);
  if (!jpDate || jpDate.length !== 3) return "";
  const [year, month, day] = jpDate;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function normalizeTime(value: string) {
  const normalized = value.normalize("NFKC");
  const isoTime = normalized.match(/T([01]\d|2[0-3]):([0-5]\d)/);
  if (isoTime) return `${isoTime[1]}:${isoTime[2]}`;
  const labeled = normalized.match(/(?:開演|START)\s*[:：]?\s*([01]?\d|2[0-3])(?::([0-5]\d)|時\s*([0-5]\d)?)/i);
  if (labeled) return `${labeled[1].padStart(2, "0")}:${(labeled[2] ?? labeled[3] ?? "00").padStart(2, "0")}`;
  const plain = normalized.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return plain ? `${plain[1].padStart(2, "0")}:${plain[2]}` : "";
}

function cityFromText(value: string) {
  const signals: Array<[string[], string]> = [
    [["東京", "Tokyo", "日本武道館", "有明アリーナ", "東京ドーム"], "도쿄"],
    [["大阪", "Osaka", "大阪城ホール"], "오사카"],
    [["神奈川", "横浜", "Yokohama", "K-Arena", "Kアリーナ", "ぴあアリーナ"], "요코하마"],
    [["愛知", "名古屋", "Nagoya"], "나고야"],
    [["福岡", "Fukuoka"], "후쿠오카"],
    [["北海道", "札幌", "Sapporo"], "삿포로"],
    [["宮城", "仙台", "Sendai"], "센다이"],
    [["千葉", "幕張", "Chiba"], "치바"],
    [["京都", "Kyoto"], "교토"],
    [["兵庫", "神戸", "Kobe"], "고베"],
    [["石川", "金沢"], "가나자와"],
    [["沖縄", "那覇", "Okinawa"], "오키나와"],
  ];
  return signals.find(([items]) => items.some((item) => value.includes(item)))?.[1] ?? "도쿄";
}

function sourceFromHostname(hostname: string) {
  const host = hostname.toLowerCase();
  if (host.includes("l-tike.com")) return "Lawson Ticket";
  if (host.includes("eplus.jp")) return "e+";
  if (host.includes("pia.jp")) return "Ticket Pia";
  if (host.includes("rakuten.co.jp")) return "Rakuten Ticket";
  if (host.includes("ticketmaster.com")) return "Ticketmaster";
  if (host.includes("creativeman.co.jp")) return "Creativeman";
  if (host.includes("livenationhip.co.jp")) return "Live Nation H.I.P.";
  if (host.includes("livefans.jp")) return "LiveFans";
  return "Artist Search";
}

function metaContent($: cheerio.CheerioAPI, selector: string) {
  return inputString($(selector).first().attr("content"));
}

function titleFromPage($: cheerio.CheerioAPI, sourceUrl: URL) {
  return firstString(
    metaContent($, "meta[property='og:title']"),
    metaContent($, "meta[name='twitter:title']"),
    $("h1").first().text(),
    $("title").first().text(),
  )
    .replace(/\s*[|｜-]\s*(チケットぴあ|e\+|イープラス|ローチケ|ローソンチケット|楽天チケット|Ticketmaster|LiveFans|CREATIVEMAN PRODUCTIONS).*$/i, "")
    .replace(new RegExp(`\\s*[|｜-]\\s*${sourceUrl.hostname.replace(/^www\\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "i"), "")
    .trim();
}

export function draftFromSearchDetail(html: string, sourceUrl: URL, keyword: string): AdminEventInput {
  const $ = cheerio.load(html);
  const pageText = compactText($("body").text());
  const jsonLdItems = $("script[type='application/ld+json']")
    .toArray()
    .flatMap((element) => {
      try {
        return flattenJsonLd(JSON.parse($(element).text()));
      } catch {
        return [];
      }
    });
  const eventJson = jsonLdItems.find((item) => {
    const type = item["@type"];
    return type === "Event" || (Array.isArray(type) && type.includes("Event"));
  });
  const location = jsonObject(eventJson?.location);
  const address = jsonObject(location.address);
  const performer = jsonObject(eventJson?.performer);
  const title = firstString(jsonString(eventJson?.name), titleFromPage($, sourceUrl), keyword);
  const dateText = firstString(jsonString(eventJson?.startDate), pageText);
  const venue = firstString(jsonString(location.name), pageText.match(/(?:会場|Venue|場所)[:：]?\s*([^\n\r]{2,80})/)?.[1]);
  const cityText = [jsonString(address.addressLocality), jsonString(address.addressRegion), venue, pageText].join(" ");
  const price = firstString(pageText.match(/[￥¥]\s*[\d,]+(?:\s*[～~-]\s*[￥¥]?\s*[\d,]+)?/)?.[0]);
  const source = sourceFromHostname(sourceUrl.hostname);

  return {
    artist: firstString(jsonString(performer.name), keyword, title),
    title,
    city: cityFromText(cityText),
    venue,
    date: normalizeDate(dateText),
    time: normalizeTime(dateText),
    genre: "Music",
    source,
    ticketAccess: source === "Ticketmaster" || source === "Creativeman" ? "한국 구매 가능" : "확인 필요",
    saleType: /(抽選|先行|プレリザーブ|プレオーダー)/.test(pageText) ? "추첨 접수" : "일반 판매",
    saleWindow: firstString(pageText.match(/(?:受付期間|販売期間|申込期間|発売日)[:：]?\s*([^\n\r]{4,120})/)?.[1]),
    price,
    phoneRequired: source !== "Ticketmaster" && source !== "Creativeman",
    foreignerNote:
      source === "Ticketmaster" || source === "Creativeman"
        ? "원본 페이지에서 해외 구매 가능 여부와 결제/수령 조건을 다시 확인하세요."
        : "일본 계정, 전화번호 인증, 결제/수령 제한이 있을 수 있으니 원본 페이지에서 확인하세요.",
    link: sourceUrl.toString(),
    image: firstString(metaContent($, "meta[property='og:image']"), metaContent($, "meta[name='twitter:image']")),
  };
}

async function fetchHtml(url: string, timeoutMs: number) {
  const response = await fetch(url, {
    headers: searchHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`${url} did not return HTML`);
  }
  return response.text();
}

async function parsedKeywordCandidateRows(keyword: string) {
  const rows: Array<{
    source: string;
    source_url: string;
    draft: AdminEventInput;
    status: "pending";
  }> = [];
  const fallbackRows: Array<{
    source: string;
    source_url: string;
    draft: AdminEventInput;
    status: "pending";
  }> = [];

  for (const source of publicSearchSources) {
    const searchUrl = source.searchUrl?.(encodeURIComponent(keyword));
    if (!searchUrl) continue;

    fallbackRows.push({
      source: source.syncRunSource,
      source_url: searchUrl,
      draft: candidateDraft(keyword, source.syncRunSource, searchUrl),
      status: "pending",
    });

    try {
      const searchHtml = await fetchHtml(searchUrl, keywordSearchFetchTimeoutMs);
      const urls = extractSearchCandidateUrls(searchHtml.slice(0, 1_000_000), searchUrl, keyword, source);
      for (const url of urls) {
        if (rows.length >= keywordTotalCandidateLimit) break;
        try {
          const detailHtml = await fetchHtml(url, keywordDetailFetchTimeoutMs);
          const draft = draftFromSearchDetail(detailHtml.slice(0, 1_000_000), new URL(url), keyword);
          if (!draftLooksUsable(draft, keyword)) continue;
          const draftLink = inputString(draft.link);
          const draftSource = inputString(draft.source);
          const draftArtist = inputString(draft.artist);
          rows.push({
            source: draftSource || source.syncRunSource,
            source_url: draftLink || url,
            draft: {
              ...draft,
              artist: draftArtist || keyword,
              link: draftLink || url,
            },
            status: "pending",
          });
        } catch {
          // A single blocked or malformed detail page should not discard other search results.
        }
      }
    } catch {
      // Keep the source search URL as a manual fallback candidate.
    }

    if (rows.length >= keywordTotalCandidateLimit) break;
  }

  return rows.length > 0 ? rows : fallbackRows;
}

function candidateDraft(keyword: string, source: string, url: string): AdminEventInput {
  return {
    artist: keyword,
    title: `${keyword} 공연 검색 후보`,
    city: "도쿄",
    venue: "",
    date: "",
    time: "",
    genre: "Music",
    source,
    saleWindow: "",
    price: "",
    foreignerNote: "검색 결과에서 공연일, 회장, 해외 예매 조건을 확인한 뒤 승인하세요.",
    link: url,
    image: "",
  };
}

function toPublicCandidate(row: CandidateRow) {
  return {
    id: row.id,
    source: row.source,
    sourceUrl: row.source_url,
    draft: row.draft,
    status: row.status,
    rejectionReason: row.rejection_reason,
    approvedEventId: row.approved_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !serviceRoleKey || !adminApiToken) {
    res.status(503).json({ error: "Search candidate API is not configured" });
    return;
  }

  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const keywords = keywordsFromBody(parseBody(req.body));
    if (keywords.length === 0) {
      res.status(400).json({ error: "keyword is required" });
      return;
    }

    const rows = (await Promise.all(keywords.map(parsedKeywordCandidateRows))).flat().slice(0, keywordTotalCandidateLimit);

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const sourceUrls = Array.from(new Set(rows.map((row) => row.source_url).filter(Boolean))) as string[];
    let existingRows: CandidateRow[] = [];

    if (sourceUrls.length > 0) {
      const { data: existingData, error: existingError } = await supabase
        .from("event_candidates")
        .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at")
        .in("source_url", sourceUrls);

      if (missingCandidateTable(existingError)) {
        res.status(200).json({
          configured: false,
          candidates: rows.map((row, index) => ({
            id: `generated-${Date.now()}-${index}`,
            source: row.source,
            sourceUrl: row.source_url,
            draft: row.draft,
            status: row.status,
            createdAt: new Date().toISOString(),
          })),
        });
        return;
      }

      if (existingError) {
        res.status(500).json({ error: existingError.message });
        return;
      }

      existingRows = (existingData ?? []) as CandidateRow[];
    }

    const { upsertRows, skippedRows } = splitCandidateRowsByExistingStatus(rows, existingRows);
    const { data, error } = upsertRows.length > 0
      ? await supabase
        .from("event_candidates")
        .upsert(upsertRows, { onConflict: "source_url" })
        .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at")
      : { data: [], error: null };

    if (missingCandidateTable(error)) {
      res.status(200).json({
        configured: false,
        candidates: rows.map((row, index) => ({
          id: `generated-${Date.now()}-${index}`,
          source: row.source,
          sourceUrl: row.source_url,
          draft: row.draft,
          status: row.status,
          createdAt: new Date().toISOString(),
        })),
      });
      return;
    }

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({
      ok: true,
      configured: true,
      candidates: ((data ?? []) as CandidateRow[]).map(toPublicCandidate),
      skippedCandidates: skippedRows.map(toPublicCandidate),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Search candidate API failed",
    });
  }
}
