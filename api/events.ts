import { createClient } from "@supabase/supabase-js";
import { seedEvents } from "../src/data/seedEvents.js";
import { rowToEvent, type EventRow } from "../src/lib/eventRows.js";
import { serverReadKey } from "../src/lib/supabaseServer.js";
import { rowToSyncRun, summarizeLatestSyncRuns, type SyncRunRow } from "../src/lib/syncRuns.js";
import type { EventApiResponse } from "../src/types/events.js";

type VercelRequest = {
  method?: string;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const defaultEventApiLimit = 300;

export function normalizeEventApiLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return defaultEventApiLimit;
  return Math.min(Math.max(Math.trunc(parsed), 50), 500);
}

export function seedResponse(): EventApiResponse {
  return {
    events: seedEvents,
    source: "seed",
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");

  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(200).json(seedResponse());
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const syncSupabase = createClient(supabaseUrl, serverReadKey(supabaseAnonKey, serviceRoleKey));
  const eventLimit = normalizeEventApiLimit(process.env.EVENT_API_LIMIT);
  const [eventsResult, syncResult] = await Promise.all([
    supabase
      .from("events")
      .select(
        "id,artist,title,city,venue,date,time,genre,source,ticket_access,sale_type,sale_window,price,phone_required,foreigner_note,link,image",
      )
      .eq("country_code", "JP")
      .gte("date", new Date().toISOString().slice(0, 10))
      .order("date", { ascending: true })
      .limit(eventLimit),
    syncSupabase
      .from("sync_runs")
      .select("source,status,fetched_count,upserted_count,skipped_count,message,finished_at")
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(30),
  ]);

  if (eventsResult.error || !eventsResult.data || eventsResult.data.length === 0) {
    res.status(200).json(seedResponse());
    return;
  }

  const syncRows = syncResult.error ? [] : ((syncResult.data ?? []) as SyncRunRow[]);

  res.status(200).json({
    events: (eventsResult.data as EventRow[]).map(rowToEvent),
    source: "supabase",
    meta: syncRows.length > 0
      ? {
          lastSync: rowToSyncRun(syncRows[0]),
          latestSyncBySource: summarizeLatestSyncRuns(syncRows),
        }
      : undefined,
  } satisfies EventApiResponse);
}
