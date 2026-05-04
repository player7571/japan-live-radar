import { createClient } from "@supabase/supabase-js";
import type { AdminEventInput } from "../src/lib/adminEventRows";

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

function searchSources(keyword: string) {
  const encoded = encodeURIComponent(keyword);
  return [
    {
      source: "Ticket Pia",
      url: `https://t.pia.jp/en/pia/search_dtl_input.do?keyword=${encoded}`,
    },
    {
      source: "e+",
      url: `https://eplus.jp/sf/word?keyword=${encoded}`,
    },
    {
      source: "Lawson Ticket",
      url: `https://l-tike.com/search/?keyword=${encoded}`,
    },
  ];
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

  const rows = keywords.flatMap((keyword) =>
    searchSources(keyword).map(({ source, url }) => ({
      source,
      source_url: url,
      draft: candidateDraft(keyword, source, url),
      status: "pending",
    })),
  );

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase
    .from("event_candidates")
    .upsert(rows, { onConflict: "source_url" })
    .select("id,source,source_url,draft,status,rejection_reason,approved_event_id,created_at,updated_at");

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
  });
}
