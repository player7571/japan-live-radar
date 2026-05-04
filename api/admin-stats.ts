import { createClient } from "@supabase/supabase-js";

type VercelRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type EventQualityRow = {
  id: string;
  source: string;
  city: string;
  date: string;
  ticket_access: string;
  phone_required: boolean | null;
  link: string | null;
  sale_window: string | null;
  price: string | null;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminApiToken = process.env.ADMIN_API_TOKEN;

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function countBy(rows: EventQualityRow[], key: "source" | "city") {
  return Object.entries(
    rows.reduce<Record<string, number>>((acc, row) => {
      const value = row[key]?.trim() || "미정";
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ko"))
    .slice(0, 8);
}

function missingCandidateTable(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.message?.includes("event_candidates")));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !serviceRoleKey || !adminApiToken) {
    res.status(503).json({ error: "Admin stats API is not configured" });
    return;
  }

  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const today = new Date().toISOString().slice(0, 10);
  const [eventsResult, candidatesResult] = await Promise.all([
    supabase
      .from("events")
      .select("id,source,city,date,ticket_access,phone_required,link,sale_window,price")
      .eq("country_code", "JP")
      .gte("date", today)
      .order("date", { ascending: true })
      .limit(500),
    supabase
      .from("event_candidates")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);

  if (eventsResult.error) {
    res.status(500).json({ error: eventsResult.error.message });
    return;
  }

  const rows = (eventsResult.data ?? []) as EventQualityRow[];
  const missingLink = rows.filter((row) => !row.link || row.link === "#").length;
  const missingSaleWindow = rows.filter((row) => !row.sale_window).length;
  const missingPrice = rows.filter((row) => !row.price).length;
  const needsAccessReview = rows.filter((row) => row.ticket_access === "확인 필요").length;
  const phoneRequired = rows.filter((row) => row.phone_required).length;
  const koreaFriendly = rows.filter((row) => row.ticket_access === "한국 구매 가능" && !row.phone_required).length;

  res.status(200).json({
    totalEvents: rows.length,
    pendingCandidates: missingCandidateTable(candidatesResult.error) ? null : candidatesResult.count ?? 0,
    candidateTableReady: !missingCandidateTable(candidatesResult.error),
    quality: {
      missingLink,
      missingSaleWindow,
      missingPrice,
      needsAccessReview,
      phoneRequired,
      koreaFriendly,
    },
    bySource: countBy(rows, "source"),
    byCity: countBy(rows, "city"),
    generatedAt: new Date().toISOString(),
  });
}
