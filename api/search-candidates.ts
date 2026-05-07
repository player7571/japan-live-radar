import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { extractDraft } from "./import-url.js";
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
const keywordSearchFetchTimeoutMs = 10_000;
const keywordDetailFetchTimeoutMs = 12_000;
const keywordSourceCandidateLimit = 5;
const keywordTotalCandidateLimit = 24;

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
          const draft = extractDraft(detailHtml.slice(0, 2_000_000), new URL(url));
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
}
