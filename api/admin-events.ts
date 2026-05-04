import { createClient } from "@supabase/supabase-js";
import { parseAdminEventBody, toEventRow } from "../src/lib/adminEventRows";

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

type AdminEventRow = {
  id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  source: string;
  updated_at: string;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminApiToken = process.env.ADMIN_API_TOKEN;

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !serviceRoleKey || !adminApiToken) {
    res.status(503).json({ error: "Admin API is not configured" });
    return;
  }

  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  if (!req.method || req.method === "GET") {
    const { data, error } = await supabase
      .from("events")
      .select("id,artist,title,city,venue,date,source,updated_at")
      .eq("country_code", "JP")
      .order("updated_at", { ascending: false })
      .limit(20);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ events: data as AdminEventRow[] });
    return;
  }

  try {
    const row = toEventRow(parseAdminEventBody(req.body));
    const { data, error } = await supabase
      .from("events")
      .upsert(row, { onConflict: "source,source_event_id" })
      .select("id,artist,title,city,venue,date,source,source_event_id")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ ok: true, event: data });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
  }
}
